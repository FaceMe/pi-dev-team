import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { classifyCommand, decideDirectCall, DEFAULT_DELEGATION, neverExits, recordCommand } from "../src/fusion/policy.js";
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

  it("balanced lets a quick command run directly and redirects it once it proved slow or verbose", () => {
    const state = fresh();
    expect(decideDirectCall("balanced", "bash", { command: "npm test" }, state, true).block).toBe(false);
    recordCommand(state, "npm test", 1_200, 300);
    expect(decideDirectCall("balanced", "bash", { command: "npm  test" }, state, true).block).toBe(false);
    recordCommand(state, "npm test", 95_000, 300);
    const slow = decideDirectCall("balanced", "bash", { command: "npm test" }, state, true);
    expect(slow.block).toBe(true);
    expect(slow.reason).toMatch(/took 95s/);
    expect(slow.reason).toMatch(/background: true/);
    recordCommand(state, "npm install", 2_000, 50_000);
    expect(decideDirectCall("balanced", "bash", { command: "npm install" }, state, true).reason).toMatch(/printed 50,000 chars/);
    expect(decideDirectCall("balanced", "bash", { command: "cat a.ts" }, state, true).block).toBe(false);
    expect(decideDirectCall("balanced", "edit", { path: "a.ts" }, state, true).block).toBe(false);
  });

  it("refuses commands that never exit, in every mode", () => {
    for (const cmd of ["npm run dev", "pnpm start", "vitest --watch", "jest --watchAll", "vitest --watch=true", "tsc -w", "next dev", "python -m http.server 8000", "docker compose up", "tail -f app.log", "npx vite"]) {
      expect(neverExits(cmd), cmd).toBeDefined();
      expect(decideDirectCall("advisory", "bash", { command: cmd }, fresh(), true).block, cmd).toBe(true);
    }
    for (const cmd of ["npm test", "vitest run", "npx tsc --noEmit", "docker compose up -d", "npm run dev > /tmp/dev.log 2>&1 &", "timeout 5 npm start", "jest --watchAll=false", "vitest --watch=false"]) {
      expect(neverExits(cmd), cmd).toBeUndefined();
    }
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
  function boot(mode: "strict" | "balanced" | "advisory", responses: Array<string | object | ((context: any) => any)> = ["condensed: 3 tests failed at a.test.ts:4"]) {
    const core = createFauxCore({ provider: "faux", models: [{ id: "cheap", contextWindow: 128_000 }, { id: "big", reasoning: true, contextWindow: 200_000 }] });
    core.setResponses(responses.map((r) => (typeof r === "string" ? fauxAssistantMessage([fauxText(r)]) : r)) as any);
    const [cheap, big] = core.models;
    saveFusionConfig({
      ...defaultFusionConfig(),
      main: { provider: big.provider, modelId: big.id },
      sidekick: { provider: cheap.provider, modelId: cheap.id },
      delegation: { ...DEFAULT_DELEGATION, mode, nudgeAfter: 3, compressOutputChars: 200, resultCapChars: 300 },
      sidekickTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
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

  it("renders the widget dim and switches between compact, full and off", async () => {
    const { rec, fire, ctx } = boot("balanced");
    const widgets: any[] = [];
    ctx.ui.setWidget = (_key: string, content: any) => widgets.push(content);
    await fire("session_start", {});
    const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
    const render = (content: any) => String(content(undefined, theme).render?.(200)?.join("\n") ?? content(undefined, theme).text);
    const compact = render(widgets.at(-1));
    expect(compact).toMatch(/^<dim>⚛ fusion balanced/);
    expect(compact.split("\n")).toHaveLength(1);
    await rec.commands.get("fusion").handler("widget full", ctx);
    expect(render(widgets.at(-1)).split("\n").length).toBeGreaterThan(3);
    expect(loadFusionConfig().widget).toBe("full");
    await rec.commands.get("fusion").handler("widget off", ctx);
    expect(widgets.at(-1)).toBeUndefined();
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

  it("balanced mode runs a test command directly first (with a timeout), then redirects it once it proved verbose", async () => {
    const { fire } = boot("balanced", ["condensed test output"]);
    await fire("session_start", {});
    const first = { toolName: "bash", toolCallId: "t1", input: { command: "npm test" } as Record<string, unknown> };
    expect(await fire("tool_call", first)).toBeUndefined();
    expect(first.input.timeout).toBe(600);
    const noisy = Array.from({ length: 40 }, (_, i) => `test ${i} ok`).join("\n");
    await fire("tool_result", { toolName: "bash", toolCallId: "t1", input: first.input, content: [{ type: "text", text: noisy }], isError: false });
    const second = await fire("tool_call", { toolName: "bash", toolCallId: "t2", input: { command: "npm test" } });
    expect(second.block).toBe(true);
    expect(second.reason).toMatch(/sidekick\(/);
    expect(await fire("tool_call", { toolName: "bash", toolCallId: "t3", input: { command: "cat package.json" } })).toBeUndefined();
  });

  it("refuses a dev server on the main agent", async () => {
    const { fire } = boot("balanced");
    await fire("session_start", {});
    const blocked = await fire("tool_call", { toolName: "bash", toolCallId: "d1", input: { command: "npm run dev" } });
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toMatch(/does not exit/);
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

  it("caps long sidekick results and keeps the full text in a file", async () => {
    const long = Array.from({ length: 60 }, (_, i) => `finding ${i}: something in src/file${i}.ts`).join("\n");
    const { rec, fire, ctx } = boot("balanced", [long]);
    await fire("session_start", {});
    const result = await rec.tools.get("sidekick").execute("c1", { task: "audit" }, undefined, undefined, ctx);
    const text = result.content[0].text as string;
    expect(text.length).toBeLessThan(500);
    const file = text.match(/full result: (\S+)/)![1];
    expect(fs.readFileSync(file, "utf8")).toBe(long);
  });

  it("attaches the files the main agent read to the sidekick's brief", async () => {
    let brief = "";
    const { rec, fire, ctx } = boot("balanced", [
      (context: any) => {
        brief = JSON.stringify(context.messages.at(-1)?.content ?? "");
        return fauxAssistantMessage([fauxText("done")]);
      },
    ]);
    await fire("session_start", {});
    await fire("tool_call", { toolName: "read", toolCallId: "r1", input: { path: "src/parser.ts", offset: 10, limit: 20 } });
    await rec.tools.get("sidekick").execute("c1", { task: "fix the parser" }, undefined, undefined, ctx);
    expect(brief).toContain("Files the main agent has already read");
    expect(brief).toContain("src/parser.ts (lines 10–29)");
  });

  it("blocks the main agent from editing a file a background delegation is changing, and can cancel it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { rec, fire, ctx } = boot("balanced", [
      async () => {
        await gate;
        return fauxAssistantMessage([fauxText("edited")]);
      },
    ]);
    await fire("session_start", {});
    await rec.tools.get("sidekick").execute("c1", { task: "refactor", files: ["src/a.ts"], background: true }, undefined, undefined, ctx);
    const blocked = await fire("tool_call", { toolName: "edit", toolCallId: "e1", input: { path: "src/a.ts" } });
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toMatch(/D1 is changing src\/a\.ts/);
    expect(await fire("tool_call", { toolName: "edit", toolCallId: "e2", input: { path: "src/b.ts" } })).toBeUndefined();

    await rec.commands.get("fusion").handler("cancel D1", ctx);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(await fire("tool_call", { toolName: "edit", toolCallId: "e3", input: { path: "src/a.ts" } })).toBeUndefined();
    expect(rec.messages).toHaveLength(0);
    await rec.commands.get("fusion").handler("tasks", ctx);
    const list = rec.entries.filter((e) => e.type === "fusion-tasks").at(-1) as any;
    expect(list.data.lines[0]).toMatch(/D1 cancelled/);
  });

  it("refuses never-exiting commands in the sidekick's own shell", async () => {
    let toolResult = "";
    const { rec, fire, ctx } = boot("balanced", [
      fauxAssistantMessage([fauxToolCall("bash", { command: "npm run dev" }, { id: "s1" })], { stopReason: "toolUse" }),
      (context: any) => {
        toolResult = JSON.stringify(context.messages.at(-1)?.content ?? "");
        return fauxAssistantMessage([fauxText("could not start the dev server")]);
      },
    ]);
    await fire("session_start", {});
    await rec.tools.get("sidekick").execute("c1", { task: "start the app" }, undefined, undefined, ctx);
    expect(toolResult).toContain("Blocked by Fusion");
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
