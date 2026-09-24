/**
 * Real `pi` worker subprocesses against a mock OpenAI-compatible model:
 * the runner's args/env/JSONL parsing and the in-worker write-scope guard.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PiSubprocessRunner } from "../src/factory/runner.js";
import type { TeamMember } from "../src/factory/types.js";
import { startMockOpenAI } from "./mock-openai.js";
import type { MockServer } from "./mock-openai.js";
import { tempDir } from "./helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piCli = path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

let server: MockServer;
let agentDir: string;
let step = 0;

beforeAll(async () => {
  server = await startMockOpenAI((messages) => {
    const last = messages.at(-1);
    const lastText = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
    if (last?.role === "tool") return { text: `TOOL RESULT: ${lastText.slice(0, 300)}` };
    step += 1;
    if (lastText.includes("WRITE_OUTSIDE")) return { tool: "write", args: { path: "outside.txt", content: "nope" } };
    if (lastText.includes("WRITE_INSIDE")) return { tool: "write", args: { path: "src/inside.txt", content: "yes" } };
    if (lastText.includes("PUSH")) return { tool: "bash", args: { command: "git push origin main" } };
    return { text: "READY" };
  });
  agentDir = tempDir("pi-agent-int-");
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        mock: {
          baseUrl: server.url,
          api: "openai-completions",
          apiKey: "mock",
          models: [{ id: "mock-model", contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
  );
  // Load this package in the worker exactly as an installed package would be.
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [repoRoot] }));
});

afterAll(async () => {
  await server?.close();
});

const member: TeamMember = { role: "backend", provider: "mock", modelId: "mock-model", tier: "daily", family: "mock" };

function runner() {
  return new PiSubprocessRunner({ ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_FACTORY_PI_BIN: piCli, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" });
}

async function run(prompt: string, writeScope: string[], tools = ["read", "write", "bash"]) {
  const cwd = tempDir("worker-cwd-");
  const result = await runner().run({
    role: "backend",
    member,
    tools,
    systemPrompt: "You are a test worker.",
    prompt,
    cwd,
    sessionId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sessionDir: path.join(cwd, ".sessions"),
    writeScope,
    timeoutMs: 90_000,
  });
  return { result, cwd };
}

describe.skipIf(!fs.existsSync(piCli))("real pi workers", () => {
  it("runs a worker subprocess and parses its reply and usage", async () => {
    const { result } = await run("Say READY", []);
    expect(result.isError).toBe(false);
    expect(result.text).toBe("READY");
    expect(result.turns).toBe(1);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(server.requests.at(-1)?.model).toBe("mock-model");
    // Only the requested tools are exposed to the model.
    expect(server.requests.at(-1)?.tools.sort()).toEqual(["bash", "read", "write"]);
  }, 120_000);

  it("blocks writes outside the write scope inside the worker", async () => {
    const { result, cwd } = await run("WRITE_OUTSIDE", ["src/**"]);
    expect(fs.existsSync(path.join(cwd, "outside.txt"))).toBe(false);
    expect(result.text).toContain("outside that scope");
    const tool = result.trace.find((s) => s.kind === "tool" && s.title === "write");
    expect(tool?.isError).toBe(true);
  }, 120_000);

  it("allows writes inside the write scope", async () => {
    const { cwd } = await run("WRITE_INSIDE", ["src/**"]);
    expect(fs.readFileSync(path.join(cwd, "src/inside.txt"), "utf8")).toBe("yes");
  }, 120_000);

  it("blocks git push inside the worker", async () => {
    const { result } = await run("PUSH", ["**"]);
    expect(result.text).toContain("Blocked by the factory");
  }, 120_000);

  it("keeps context across calls with the same session id", async () => {
    const cwd = tempDir("worker-session-");
    const r = runner();
    const base = { role: "backend", member, tools: ["read"], systemPrompt: "Test.", cwd, sessionId: "persistent-1", sessionDir: path.join(cwd, ".sessions"), writeScope: [], timeoutMs: 90_000 };
    await r.run({ ...base, prompt: "first message" });
    await r.run({ ...base, prompt: "second message" });
    const messages = server.requests.at(-1)!.messages;
    const texts = messages.map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
    expect(texts.some((t: string) => t.includes("first message"))).toBe(true);
    expect(texts.some((t: string) => t.includes("second message"))).toBe(true);
  }, 120_000);
});
