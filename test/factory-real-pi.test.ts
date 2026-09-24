/**
 * The whole factory pipeline with real `pi` worker subprocesses. A mock
 * OpenAI-compatible model plays every role: it writes files through pi's own
 * write tool (so the in-worker guard applies) and replies with the JSON each
 * phase expects. Gates run for real (`node --test`) and git is real.
 */

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FactoryRun, newState } from "../src/factory/pipeline.js";
import { loadRoles } from "../src/factory/roles.js";
import { PiSubprocessRunner } from "../src/factory/runner.js";
import { FactoryStore } from "../src/factory/store.js";
import type { SetupAnswers, TeamMember } from "../src/factory/types.js";
import { startMockOpenAI } from "./mock-openai.js";
import type { MockServer } from "./mock-openai.js";
import { roleResponder } from "./mock-roles.js";
import { scriptedUi } from "./factory-helpers.js";
import { tempDir } from "./helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piCli = path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

let server: MockServer;
let agentDir: string;

beforeAll(async () => {
  server = await startMockOpenAI(roleResponder);
  agentDir = tempDir("pi-agent-e2e-");
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({ providers: { mock: { baseUrl: server.url, api: "openai-completions", apiKey: "mock", models: [{ id: "mock-model", contextWindow: 128000, maxTokens: 4096 }] } } }),
  );
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [repoRoot] }));
});

afterAll(async () => {
  await server?.close();
});

describe.skipIf(!fs.existsSync(piCli))("factory with real pi workers", () => {
  it("builds, verifies, reviews, documents and merges a project", async () => {
    const cwd = tempDir("factory-real-");
    const runner = new PiSubprocessRunner({ ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_FACTORY_PI_BIN: piCli, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" });
    const roles = loadRoles();
    const member = (role: string): TeamMember => ({ role, provider: "mock", modelId: "mock-model", tier: "daily", family: "mock" });
    const team = { members: Object.fromEntries([...roles.keys()].map((r) => [r, member(r)])), tiers: { source: { small: "none", daily: "none", frontier: "none" }, notes: [] } as any, notes: [] };
    const answers: SetupAnswers = { teamPreset: "balanced", pins: {}, autonomy: "auto", projectMode: "new", stack: "auto", research: "off", deploy: "none", budgetUsd: 0, budgetTokens: 0 };
    const { ui } = scriptedUi();
    const store = new FactoryStore(cwd);
    const run = new FactoryRun({ cwd, ui, runner, roles, team, answers, store, webAccess: false, workerTimeoutMs: 120_000, gateTimeoutMs: 60_000 }, newState("an add() function", "run-real", answers));

    const final = await run.run();

    expect(final.lastError).toBeUndefined();
    expect(final.status).toBe("done");
    expect(final.tickets[0].status).toBe("done");
    expect(fs.readFileSync(path.join(cwd, "src/add.js"), "utf8")).toContain("a + b");
    // The builder's out-of-scope write was blocked inside the worker.
    expect(JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"))).toEqual({ name: "demo", type: "module" });
    expect(fs.existsSync(path.join(cwd, "README.md"))).toBe(true);
    const log = execFileSync("git", ["log", "--oneline"], { cwd, encoding: "utf8" });
    expect(log).toMatch(/feat\(T-001\)/);
    // Worker sessions persisted under .factory/sessions.
    expect(fs.readdirSync(store.sessionsDir).length).toBeGreaterThan(0);
  }, 300_000);

  it("runs headless through the real /factory command in a pi session", async () => {
    const cwd = tempDir("factory-headless-");
    // Only the mock provider: hide ambient cloud credentials from the child.
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!/^(AWS_|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_|AZURE_)/.test(key)) env[key] = value;
    }
    Object.assign(env, { PI_CODING_AGENT_DIR: agentDir, PI_FACTORY_PI_BIN: piCli, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" });
    fs.writeFileSync(path.join(agentDir, "factory.json"), JSON.stringify({ research: "off", autonomy: "auto" }));
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [piCli, "--mode", "json", "-p", "--no-session", "--model", "mock/mock-model", "/factory new an add() function"], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`pi exited ${code}: ${stderr.slice(-2000)}`));
        else resolve(stdout);
      });
    });
    const entries = out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((e) => e?.type === "entry_appended")
      .map((e) => e.entry.data);
    expect(entries.some((d) => d.kind === "report")).toBe(true);
    const state = new FactoryStore(cwd).loadState()!;
    expect(state.status).toBe("done");
    expect(fs.readFileSync(path.join(cwd, "src/add.js"), "utf8")).toContain("a + b");
  }, 300_000);
});
