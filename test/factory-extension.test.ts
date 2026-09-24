import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFactoryExtension, registerWorkerGuard } from "../src/factory/extension.js";
import { FactoryStore } from "../src/factory/store.js";
import { factoryConfigPath } from "../src/shared/config.js";
import { fakeRegistry, fakeUi, makeModel, recordingPi, tempDir, useTempAgentDir } from "./helpers.js";
import { json, ScriptedRunner } from "./factory-helpers.js";

let agent: ReturnType<typeof useTempAgentDir>;
beforeEach(() => {
  agent = useTempAgentDir();
  // Don't try to install pi-web-access from a test.
  fs.writeFileSync(factoryConfigPath(), JSON.stringify({ research: "off" }));
});
afterEach(() => agent.restore());

const price = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 });
const models = [
  makeModel({ id: "small-model", provider: "p1", cost: price(0.2, 0.8) }),
  makeModel({ id: "big-model", provider: "p2", reasoning: true, cost: price(5, 25) }),
];

const SCRIPTS = {
  analyst: (req: any) =>
    req.prompt.includes("interview round")
      ? { text: json({ ready: true, questions: [] }) }
      : { text: "ok", files: { ".factory/spec/spec.md": "- FR-001 x\n  Given a When b Then c\n" } },
  architect: () => ({ text: json({ stack: "node", gates: { install: "true", test: "node --test" } }), files: { ".factory/adr/0001-architecture.md": "# ADR\n" } }),
  planner: () => ({ text: json({ tickets: [{ id: "T-001", title: "x", role: "backend", requirements: ["FR-001"], brief: "b", writeScope: ["src/**", "test/**"] }] }) }),
  devops: () => ({ text: "ok", files: { "package.json": "{\"type\":\"module\"}", "test/a.test.js": "import t from 'node:test'; t('a', () => {});\n" } }),
  backend: () => ({ text: "ok", files: { "src/x.js": "export const x = 1;\n" } }),
  reviewer: () => ({ text: json({ verdict: "approve", findings: [] }) }),
  docs: () => ({ text: "ok", files: { "README.md": "# x\n" } }),
};

function setup(cwd: string) {
  const rec = recordingPi();
  const runner = new ScriptedRunner(SCRIPTS);
  createFactoryExtension({ runner })(rec.api);
  const { ui, notes, selects } = fakeUi();
  const ctx: any = { hasUI: true, mode: "tui", ui, cwd, modelRegistry: fakeRegistry(models), sessionManager: { getBranch: () => [] } };
  return { rec, runner, ctx, notes, selects };
}

async function waitFor(check: () => boolean, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("/factory command", () => {
  it("runs quick setup (one Enter) and builds in the background", async () => {
    const cwd = tempDir("factory-cmd-");
    const { rec, runner, ctx, selects } = setup(cwd);
    await rec.commands.get("factory").handler("new a tiny library", ctx);
    expect(selects[0].title).toMatch(/Factory setup/);
    const store = new FactoryStore(cwd);
    await waitFor(() => store.loadState()?.status === "done");
    expect(runner.count("backend")).toBe(1);
    expect(fs.existsSync(path.join(cwd, "src/x.js"))).toBe(true);
    // Answers remembered: project-level and user-level.
    expect(store.loadProject()?.autonomy).toBe("balanced");
    expect(JSON.parse(fs.readFileSync(factoryConfigPath(), "utf8")).teamPreset).toBe("balanced");

    await rec.commands.get("factory").handler("status", ctx);
    const status = rec.entries.filter((e) => e.type === "factory" && (e.data as any).kind === "status").at(-1);
    expect((status?.data as any).lines[0]).toMatch(/done/);
  }, 60_000);

  it("refuses to start without logged-in models", async () => {
    const cwd = tempDir("factory-nomodels-");
    const { rec, ctx, notes } = setup(cwd);
    ctx.modelRegistry = fakeRegistry(models, []);
    await rec.commands.get("factory").handler("new something", ctx);
    expect(notes.at(-1)?.message).toMatch(/\/login/);
    expect(new FactoryStore(cwd).loadState()).toBeNull();
  });

  it("switches autonomy and shows the team", async () => {
    const cwd = tempDir("factory-autonomy-");
    const { rec, ctx } = setup(cwd);
    await rec.commands.get("factory").handler("autonomy careful", ctx);
    expect(JSON.parse(fs.readFileSync(factoryConfigPath(), "utf8")).autonomy).toBe("careful");
    await rec.commands.get("factory").handler("team cheap", ctx);
    const team = rec.entries.filter((e) => (e.data as any).kind === "status").at(-1);
    expect((team?.data as any).lines[0]).toBe("team preset: cheap");
  });

  it("offers completions", () => {
    const { rec } = setup(tempDir());
    const complete = rec.commands.get("factory").getArgumentCompletions;
    expect(complete("re").map((i: any) => i.value)).toEqual(["resume"]);
    expect(complete("autonomy c").map((i: any) => i.label)).toEqual(["careful"]);
  });
});

describe("worker mode", () => {
  it("registers only the guard, which blocks out-of-scope writes and pushes", async () => {
    const rec = recordingPi();
    registerWorkerGuard(rec.api, { PI_FACTORY_WRITE_SCOPE: JSON.stringify(["src/**"]) });
    const [handler] = rec.handlers.get("tool_call")!;
    const ctx = { cwd: "/w" };
    expect(await handler({ toolName: "write", input: { path: "src/a.ts" } }, ctx)).toBeUndefined();
    expect((await handler({ toolName: "edit", input: { path: "lib/a.ts" } }, ctx)).block).toBe(true);
    expect((await handler({ toolName: "bash", input: { command: "git push" } }, ctx)).block).toBe(true);
    expect(await handler({ toolName: "bash", input: { command: "npm test" } }, ctx)).toBeUndefined();
    expect(rec.commands.size).toBe(0);
  });
});
