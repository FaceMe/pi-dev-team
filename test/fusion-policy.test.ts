import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { classifyCommand, decideDirectCall } from "../src/fusion/policy.js";
import fusionExtension from "../src/fusion/extension.js";
import { defaultFusionConfig, loadFusionConfig, saveFusionConfig } from "../src/shared/config.js";
import { fakeRegistry, fakeUi, recordingPi, tempDir, useTempAgentDir } from "./helpers.js";

let agent: ReturnType<typeof useTempAgentDir>;
beforeEach(() => {
  agent = useTempAgentDir();
});
afterEach(() => agent.restore());

describe("command classification", () => {
  it("recognises verification, installs and recon across ecosystems", () => {
    for (const cmd of ["npm test", "pnpm run build", "npx vitest run", "pytest -q", "python -m pytest tests", "cargo test", "go test ./...", "./gradlew test", "mvn -q test", "dotnet test", "make test", "npx tsc --noEmit", "ruff check .", "docker build -t x ."]) {
      expect(classifyCommand(cmd), cmd).toBe("verify");
    }
    for (const cmd of ["npm install", "pnpm add zod", "pip install -r requirements.txt", "uv sync", "bundle install"]) {
      expect(classifyCommand(cmd), cmd).toBe("install");
    }
    for (const cmd of ["grep -rn foo src", "rg TODO", "find . -name '*.ts'", "git log --oneline"]) {
      expect(classifyCommand(cmd), cmd).toBe("recon");
    }
    for (const cmd of ["ls", "cat src/a.ts", "git status", "node script.js", "echo hi"]) {
      expect(classifyCommand(cmd), cmd).toBe("other");
    }
  });
});

describe("direct-call decisions", () => {
  const fresh = () => ({ directStreak: 0, failedDelegations: 0 });

  it("balanced redirects tests/builds/installs but not reads or edits", () => {
    expect(decideDirectCall("balanced", "bash", { command: "npm test" }, fresh(), true).block).toBe(true);
    expect(decideDirectCall("balanced", "bash", { command: "npm install" }, fresh(), true).reason).toMatch(/sidekick/);
    expect(decideDirectCall("balanced", "bash", { command: "cat a.ts" }, fresh(), true).block).toBe(false);
    expect(decideDirectCall("balanced", "edit", { path: "a.ts" }, fresh(), true).block).toBe(false);
  });

  it("strict blocks every execution tool; advisory blocks nothing", () => {
    for (const tool of ["bash", "edit", "write"]) expect(decideDirectCall("strict", tool, { command: "ls" }, fresh(), true).block).toBe(true);
    expect(decideDirectCall("strict", "read", { path: "a" }, fresh(), true).block).toBe(false);
    expect(decideDirectCall("advisory", "bash", { command: "npm test" }, fresh(), true).block).toBe(false);
  });

  it("never blocks without a sidekick or after repeated failed delegations", () => {
    expect(decideDirectCall("strict", "bash", { command: "npm test" }, fresh(), false).block).toBe(false);
    expect(decideDirectCall("strict", "bash", { command: "npm test" }, { directStreak: 0, failedDelegations: 2 }, true).block).toBe(false);
  });
});

describe("fusion extension with the policy", () => {
  function boot(mode: "strict" | "balanced" | "advisory", responses: string[] = ["condensed: 3 tests failed at a.test.ts:4"]) {
    const core = createFauxCore({ provider: "faux", models: [{ id: "cheap", contextWindow: 128_000 }, { id: "big", reasoning: true, contextWindow: 200_000 }] });
    core.setResponses(responses.map((text) => fauxAssistantMessage([fauxText(text)])));
    const [cheap, big] = core.models;
    saveFusionConfig({
      ...defaultFusionConfig(),
      main: { provider: big.provider, modelId: big.id },
      sidekick: { provider: cheap.provider, modelId: cheap.id },
      delegation: { mode, nudgeAfter: 3, compressOutputChars: 200 },
    });
    const rec = recordingPi();
    rec.activeTools = ["read", "bash", "edit", "write"];
    fusionExtension(rec.api);
    const { ui } = fakeUi();
    const ctx: any = { hasUI: true, ui, cwd: tempDir(), model: big, modelRegistry: fakeRegistry([cheap, big], [cheap, big], { streamSimple: core.streamSimple }), sessionManager: { getBranch: () => [] } };
    const fire = async (event: string, payload: any) => {
      let result: any;
      for (const handler of rec.handlers.get(event) ?? []) result = (await handler(payload, ctx)) ?? result;
      return result;
    };
    return { rec, ctx, fire, core };
  }

  it("does not warn about its own sidekick tool", async () => {
    const { rec, fire, ctx } = boot("balanced");
    const notes: string[] = [];
    ctx.ui.notify = (message: string) => notes.push(message);
    await fire("session_start", {});
    expect(notes.filter((n) => n.includes("another extension registered"))).toEqual([]);
  });

  it("warns when another extension owns a tool named sidekick", async () => {
    const { rec, fire, ctx } = boot("balanced");
    rec.tools.set("sidekick", { name: "sidekick", description: "Someone else's sidekick" });
    const notes: string[] = [];
    ctx.ui.notify = (message: string) => notes.push(message);
    await fire("session_start", {});
    expect(notes.some((n) => n.includes("another extension registered"))).toBe(true);
  });

  it("activates the sidekick tools on start", async () => {
    const { rec, fire } = boot("balanced");
    await fire("session_start", {});
    expect(rec.activeTools).toEqual(expect.arrayContaining(["bash", "sidekick", "sidekick_wait"]));
  });

  it("strict mode removes execution tools from the main agent and restores them when switched off", async () => {
    const { rec, fire, ctx } = boot("strict");
    await fire("session_start", {});
    expect(rec.activeTools.sort()).toEqual(["read", "sidekick", "sidekick_wait"]);
    await rec.commands.get("fusion").handler("mode balanced", ctx);
    expect(rec.activeTools).toEqual(expect.arrayContaining(["bash", "edit", "write", "sidekick"]));
    expect(loadFusionConfig().delegation.mode).toBe("balanced");
  });

  it("balanced mode redirects a direct test run to the sidekick", async () => {
    const { fire } = boot("balanced");
    await fire("session_start", {});
    const blocked = await fire("tool_call", { toolName: "bash", input: { command: "npm test" } });
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toMatch(/sidekick\(/);
    expect(await fire("tool_call", { toolName: "bash", input: { command: "cat package.json" } })).toBeUndefined();
  });

  it("condenses verbose direct output with the sidekick model and keeps the full log", async () => {
    const { fire } = boot("balanced");
    await fire("session_start", {});
    const long = Array.from({ length: 50 }, (_, i) => `line ${i} of noisy output`).join("\n");
    const result = await fire("tool_result", { toolName: "bash", input: { command: "node noisy.js" }, content: [{ type: "text", text: long }], isError: false });
    const text = result.content[0].text as string;
    expect(text).toContain("condensed by the sidekick model");
    expect(text).toContain("condensed: 3 tests failed");
    const logPath = text.match(/full log: (\S+)/)![1];
    expect(fs.readFileSync(logPath, "utf8")).toBe(long);
  });

  it("nudges after a run of direct calls", async () => {
    const { fire } = boot("advisory");
    await fire("session_start", {});
    let last: any;
    for (let i = 0; i < 3; i++) {
      await fire("tool_call", { toolName: "read", input: { path: "a" } });
      last = await fire("tool_result", { toolName: "read", input: { path: "a" }, content: [{ type: "text", text: "x" }], isError: false });
    }
    expect(last.content.at(-1).text).toMatch(/3 direct tool calls in a row/);
  });

  it("collects a background delegation with sidekick_wait without delivering it twice", async () => {
    const { rec, fire, ctx } = boot("balanced", ["tests: 12 passed, 0 failed"]);
    await fire("session_start", {});
    const started = await rec.tools.get("sidekick").execute("c1", { task: "run the tests", background: true }, undefined, undefined, ctx);
    expect(started.content[0].text).toMatch(/Started background delegation D1/);
    const waited = await rec.tools.get("sidekick_wait").execute("c2", {}, undefined, undefined, ctx);
    expect(waited.content[0].text).toContain("12 passed");
    await new Promise((r) => setTimeout(r, 20));
    expect(rec.messages).toHaveLength(0);
  });

  it("delivers an uncollected background result into the conversation as a steer message", async () => {
    const { rec, fire, ctx } = boot("balanced", ["lint: clean"]);
    await fire("session_start", {});
    await rec.tools.get("sidekick").execute("c1", { task: "run the linter", background: true }, undefined, undefined, ctx);
    for (let i = 0; i < 100 && rec.messages.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(rec.messages).toHaveLength(1);
    expect(rec.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(rec.messages[0].message.content).toContain("lint: clean");
  });

  it("holds the run open until outstanding delegations finish", async () => {
    const { rec, fire, ctx } = boot("balanced", ["build ok"]);
    await fire("session_start", {});
    rec.api.sendMessage = () => undefined; // delivery path not under test here
    await rec.tools.get("sidekick").execute("c1", { task: "build", background: true }, undefined, undefined, ctx);
    const result = await fire("agent_before_settle", { outcome: "completed" });
    expect(result.continue).toBe(true);
    expect(result.entries[0].content).toContain("build ok");
    expect(await fire("agent_before_settle", { outcome: "completed" })).toBeUndefined();
  });

  it("puts the decision rule and mode into the main agent's prompt", async () => {
    const { fire } = boot("strict");
    await fire("session_start", {});
    const options: any = { sections: {} };
    await fire("before_agent_start", { systemPromptOptions: options });
    expect(options.sections.fusion).toContain("Mode: STRICT");
    expect(options.sections.fusion).toContain("judgement or labour");
    expect(options.sections.fusion).toContain("sidekick_wait");
  });
});
