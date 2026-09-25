/**
 * Fusion inside a real pi session against a mock OpenAI-compatible server
 * that plays both the main model and the sidekick model. Checks that the
 * delegation policy actually gets the sidekick started.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockOpenAI } from "./mock-openai.js";
import type { MockReply, MockServer } from "./mock-openai.js";
import { tempDir } from "./helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piCli = path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

let server: MockServer;
let agentDir: string;

const text = (m: any) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));

function respond(messages: any[]): MockReply {
  const system = text(messages.find((m: any) => m.role === "system" || m.role === "developer"));
  const last = messages.at(-1);
  if (system.includes("You are the sidekick agent")) {
    if (last?.role === "tool") return { text: `SIDEKICK REPORT: ${text(last).slice(0, 120)}` };
    return { tool: "bash", args: { command: "echo '3 passing'" } };
  }
  // Main agent.
  const firstUser = text(messages.find((m: any) => m.role === "user"));
  if (firstUser.includes("SETTLE")) {
    const turns = messages.filter((m: any) => m.role === "assistant").length;
    if (turns === 0) return { tool: "sidekick", args: { task: "Run npm test and report pass/fail counts.", background: true } };
    if (turns === 1) return { text: "I will wrap up now." };
    return { text: `MAIN REVIEWED: ${text(last).slice(0, 300)}` };
  }
  if (firstUser.includes("BACKGROUND")) {
    const turns = messages.filter((m: any) => m.role === "assistant").length;
    if (turns === 0) return { tool: "sidekick", args: { task: "Run npm test and report pass/fail counts.", background: true } };
    if (turns === 1) return { tool: "sidekick_wait", args: {} };
    return { text: `MAIN DONE: ${text(last).slice(0, 200)}` };
  }
  if (last?.role === "user") return { tool: "bash", args: { command: "npm test" } };
  if (last?.role === "tool" && text(last).includes("Fusion:")) return { tool: "sidekick", args: { task: "Run npm test and report pass/fail counts.", expect: "evidence" } };
  return { text: `MAIN DONE: ${text(last).slice(0, 200)}` };
}

beforeAll(async () => {
  server = await startMockOpenAI(respond);
  agentDir = tempDir("pi-agent-fusion-");
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        mock: {
          baseUrl: server.url,
          api: "openai-completions",
          apiKey: "mock",
          models: [
            { id: "main", contextWindow: 200000, maxTokens: 4096, cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 } },
            { id: "cheap", contextWindow: 128000, maxTokens: 4096, cost: { input: 0.2, output: 0.8, cacheRead: 0, cacheWrite: 0 } },
          ],
        },
      },
    }),
  );
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [repoRoot] }));
  fs.writeFileSync(
    path.join(agentDir, "fusion.json"),
    JSON.stringify({ enabled: true, main: { provider: "mock", modelId: "main" }, sidekick: { provider: "mock", modelId: "cheap" }, routing: { enabled: false }, delegation: { mode: "balanced" } }),
  );
});

afterAll(async () => {
  await server?.close();
});

function runPi(prompt: string, cwd: string): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(AWS_|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_|AZURE_)/.test(k)) env[k] = v;
  Object.assign(env, { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [piCli, "--mode", "json", "-p", "--no-session", "--model", "mock/main", prompt], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    const timer = setTimeout(() => {
      if (process.env.FUSION_DEBUG) fs.writeFileSync("/tmp/claude-0/fusion-debug.jsonl", out + "\n--stderr--\n" + err);
      child.kill("SIGKILL");
    }, Number(process.env.FUSION_TIMEOUT ?? 120_000));
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`pi exited ${code}: ${err.slice(-1500)}`));
    });
  });
}

describe.skipIf(!fs.existsSync(piCli))("fusion in a real pi session", () => {
  it("redirects a direct test run and the main agent then delegates to the sidekick", async () => {
    const out = await runPi("Run the tests and tell me the result.", tempDir("fusion-cwd-"));
    const events = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const toolEnds = events.filter((e: any) => e.type === "tool_execution_end").map((e: any) => ({ name: e.toolName, isError: e.isError, text: JSON.stringify(e.result?.content ?? "") }));
    // 1) main's direct `npm test` was blocked by the policy
    expect(toolEnds[0].name).toBe("bash");
    expect(toolEnds[0].text).toContain("Fusion:");
    // 2) main then called the sidekick, which ran its own bash and reported back
    const sidekick = toolEnds.find((t: any) => t.name === "sidekick");
    expect(sidekick?.isError).toBe(false);
    expect(sidekick?.text).toContain("SIDEKICK REPORT");
    expect(sidekick?.text).toContain("3 passing");
    // 3) the sidekick's requests went to the cheap model with its own system prompt
    const cheapRequests = server.requests.filter((r) => r.model === "cheap");
    expect(cheapRequests.length).toBeGreaterThanOrEqual(2);
    // 4) the main agent finished with the sidekick's result
    const final = events.filter((e: any) => e.type === "message_end" && e.message?.role === "assistant").at(-1);
    expect(JSON.stringify(final.message.content)).toContain("MAIN DONE");
  }, 180_000);

  it("runs a background delegation while the main agent continues, then collects it", async () => {
    const out = await runPi("BACKGROUND: run the tests.", tempDir("fusion-bg-"));
    const events = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const toolEnds = events.filter((e: any) => e.type === "tool_execution_end").map((e: any) => ({ name: e.toolName, text: JSON.stringify(e.result?.content ?? "") }));
    expect(toolEnds[0].name).toBe("sidekick");
    expect(toolEnds[0].text).toContain("Started background delegation D1");
    const waited = toolEnds.find((t: any) => t.name === "sidekick_wait");
    expect(waited?.text).toContain("3 passing");
    const final = events.filter((e: any) => e.type === "message_end" && e.message?.role === "assistant").at(-1);
    expect(JSON.stringify(final.message.content)).toContain("MAIN DONE");
    // Collected with sidekick_wait, so it is not delivered again as a steer message.
    expect(events.filter((e: any) => e.type === "message_end" && e.message?.customType === "fusion-result")).toHaveLength(0);
  }, 180_000);

  it("does not settle while a background delegation is outstanding", async () => {
    const out = await runPi("SETTLE: run the tests in the background.", tempDir("fusion-settle-"));
    const events = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const assistants = events.filter((e: any) => e.type === "message_end" && e.message?.role === "assistant").map((e: any) => JSON.stringify(e.message.content));
    expect(assistants.at(-1)).toContain("MAIN REVIEWED");
    expect(assistants.at(-1)).toContain("3 passing");
  }, 180_000);
});
