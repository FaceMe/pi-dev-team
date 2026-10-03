import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFactoryExtension, registerWorkerGuard } from "../src/factory/extension.js";
import { newState } from "../src/factory/pipeline.js";
import { loadRoles } from "../src/factory/roles.js";
import { FactoryStore } from "../src/factory/store.js";
import type { FactoryState, SetupAnswers, Ticket } from "../src/factory/types.js";
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

const baseAnswers: SetupAnswers = {
  teamPreset: "balanced",
  pins: {},
  autonomy: "balanced",
  projectMode: "new",
  stack: "auto",
  research: "off",
  deploy: "none",
  budgetUsd: 0,
  budgetTokens: 0,
};

function ticket(id: string, status: Ticket["status"]): Ticket {
  return {
    id,
    title: `ticket ${id}`,
    role: "backend",
    dependsOn: [],
    requirements: [],
    brief: "",
    acceptance: [],
    writeScope: [],
    status,
    attempts: [],
  };
}

function runState(runId: string, overrides: Partial<FactoryState> = {}): FactoryState {
  const state = newState("a tiny library", runId, baseAnswers);
  return { ...state, ...overrides };
}

function lastEntry(rec: ReturnType<typeof recordingPi>, kind: string): any {
  return rec.entries.filter((e) => e.type === "factory" && (e.data as any).kind === kind).at(-1)?.data;
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

  it("completes trace with ticket ids and role names", () => {
    const cwd = tempDir("factory-trace-complete-");
    const { rec } = setup(cwd);
    const store = new FactoryStore(cwd);
    const state = runState("run-c");
    state.tickets = [ticket("T-001", "done"), ticket("T-002", "todo")];
    store.saveState(state);
    const complete = rec.commands.get("factory").getArgumentCompletions;
    // The completion callback has no ctx, so it reads the process cwd.
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      expect(complete("trace T").map((i: any) => i.label)).toEqual(["T-001", "T-002"]);
      expect(complete("trace arch").map((i: any) => i.label)).toEqual(["architect"]);
      expect(complete("trace nope-")).toBeNull();
    } finally {
      process.chdir(previous);
    }
  });

  it("shows the cost report for all runs with a frontier savings estimate", async () => {
    const cwd = tempDir("factory-cost-cmd-");
    const { rec, ctx } = setup(cwd);
    const store = new FactoryStore(cwd);
    store.ledger({ kind: "worker", runId: "run-a", phase: "build", role: "backend", model: "p1/small-model", ticket: "T-1", turns: 1, tokens: 1_200_000, tokensIn: 1_000_000, tokensOut: 200_000, costUsd: 0.5, ok: true });
    store.ledger({ kind: "gates", runId: "run-a", phase: "build", ok: true, summary: "install+test" });
    await rec.commands.get("factory").handler("cost", ctx);
    const lines = lastEntry(rec, "status").lines as string[];
    expect(lines[0]).toBe("cost, all runs");
    expect(lines[1]).toBe("total $0.50 · 1.20M tokens · 1 worker run(s)");
    // The registry's frontier model is p2/big-model ($5/M in, $25/M out): 1M+0.2M tokens ≈ $10.
    expect(lines).toContain("savings vs all-frontier: $9.50 (95%, estimate)");
    expect(lines).toContain("by ticket:");
    expect(lines).toContain("  T-1: 1 run(s) · 1.20M tok · $0.50");
  });

  it("scopes cost to the current run and notes hidden ones", async () => {
    const cwd = tempDir("factory-cost-run-");
    const { rec, ctx } = setup(cwd);
    const store = new FactoryStore(cwd);
    store.saveState(runState("run-a"));
    store.ledger({ kind: "worker", runId: "run-a", phase: "build", role: "backend", model: "p1/small-model", tokens: 1000, costUsd: 0.25, ok: true });
    store.ledger({ kind: "worker", runId: "run-b", phase: "docs", role: "docs", model: "p1/small-model", tokens: 1000, costUsd: 0.75, ok: true });
    await rec.commands.get("factory").handler("cost", ctx);
    const lines = lastEntry(rec, "status").lines as string[];
    expect(lines[0]).toBe("cost for run run-a");
    expect(lines[1]).toBe("total $0.25 · 1.0k tokens · 1 worker run(s)");
    expect(lines.at(-1)).toBe("other runs: 1 worker run(s) not shown (start a run to filter)");

    const empty = tempDir("factory-cost-empty-");
    const fresh = setup(empty);
    await fresh.rec.commands.get("factory").handler("cost", fresh.ctx);
    expect(fresh.notes.at(-1)?.message).toBe("Nothing spent yet in this folder.");
  });

  it("shows the last traced worker run for a ticket or role, and notifies on no match", async () => {
    const cwd = tempDir("factory-trace-cmd-");
    const { rec, ctx, notes } = setup(cwd);
    const store = new FactoryStore(cwd);
    const trace = [
      { kind: "tool", title: "edit", detail: "edit src/x.ts" },
      { kind: "thinking", title: "turn 2 thinking" },
    ];
    store.ledger({ kind: "worker", runId: "run-a", phase: "build", role: "backend", model: "p1/small-model", ticket: "T-1", tokens: 10, costUsd: 0.01, ok: true, trace });
    store.ledger({ kind: "worker", runId: "run-a", phase: "build", role: "backend", model: "p1/small-model", ticket: "T-1", tokens: 10, costUsd: 0.01, ok: true });
    store.ledger({ kind: "worker", runId: "run-b", phase: "build", role: "reviewer", model: "p2/big-model", ticket: "T-2", tokens: 10, costUsd: 0.01, ok: true, trace });

    // No run state in the folder: every run's entries are eligible.
    await rec.commands.get("factory").handler("trace T-1", ctx);
    expect(lastEntry(rec, "trace")).toMatchObject({ role: "backend", ticket: "T-1", model: "p1/small-model" });
    expect(lastEntry(rec, "trace").steps).toHaveLength(2);
    await rec.commands.get("factory").handler("trace reviewer", ctx);
    expect(lastEntry(rec, "trace")).toMatchObject({ role: "reviewer", model: "p2/big-model" });

    // With a run locked, only that run's entries match.
    store.saveState(runState("run-a"));
    await rec.commands.get("factory").handler("trace T-2", ctx);
    expect(notes.at(-1)?.message).toBe('No traced worker run found for "T-2".');
    await rec.commands.get("factory").handler("trace backend", ctx);
    expect(lastEntry(rec, "trace")).toMatchObject({ role: "backend", ticket: "T-1" });
  });

  it("notifies when no traced worker runs exist at all", async () => {
    const cwd = tempDir("factory-trace-none-");
    const { rec, ctx, notes } = setup(cwd);
    await rec.commands.get("factory").handler("trace", ctx);
    expect(notes.at(-1)?.message).toBe("No traced worker runs yet.");
  });

  it("shows the board for the stored run", async () => {
    const cwd = tempDir("factory-board-cmd-");
    const { rec, ctx, notes } = setup(cwd);
    const store = new FactoryStore(cwd);
    const state = runState("run-board-1");
    state.tickets = [ticket("T-001", "done"), ticket("T-002", "in_progress"), ticket("T-003", "todo")];
    store.saveState(state);
    await rec.commands.get("factory").handler("board", ctx);
    const lines = lastEntry(rec, "status").lines as string[];
    expect(lines[0]).toBe("🏭 factory · discovery · 1/3 tickets · $0.00");
    expect(lines.some((l) => l.includes("T-002"))).toBe(true);

    const empty = tempDir("factory-board-none-");
    const fresh = setup(empty);
    await fresh.rec.commands.get("factory").handler("board", fresh.ctx);
    expect(fresh.notes.at(-1)?.message).toBe("No factory run in this folder.");
  });

  it("resume applies the lock's settings snapshot over changed user defaults", async () => {
    const cwd = tempDir("factory-resume-settings-");
    const { rec, runner, ctx, selects } = setup(cwd);
    fs.writeFileSync(factoryConfigPath(), JSON.stringify({ research: "off", autonomy: "careful", teamPreset: "balanced" }));
    const store = new FactoryStore(cwd);
    const state = runState("run-settings", {
      status: "paused",
      settings: { autonomy: "auto", projectMode: "new", stack: "Rust 2024", research: "off", deploy: "none" },
    });
    store.saveState(state);

    await rec.commands.get("factory").handler("resume", ctx);
    await waitFor(() => ["done", "failed"].includes(store.loadState()?.status ?? ""));
    expect(store.loadState()?.status).toBe("done");

    // The snapshotted settings reach the workers (every system prompt carries them).
    const architect = runner.calls.find((c) => c.role === "architect")!;
    expect(architect.systemPrompt).toContain("Stack preference: Rust 2024");
    // Snapshotted autonomy "auto": only the spec approval is asked, not careful's extra gates.
    expect(selects.filter((s) => s.title.startsWith("Approve"))).toHaveLength(1);
  }, 60_000);

  it("session_start offers to resume an interrupted run", async () => {
    const cwd = tempDir("factory-session-");
    const rec = recordingPi();
    createFactoryExtension({ runner: new ScriptedRunner(SCRIPTS) })(rec.api);
    const { ui, notes, selects } = fakeUi({ select: ["Show status"] });
    const ctx: any = { hasUI: true, mode: "tui", ui, cwd, modelRegistry: fakeRegistry(models), sessionManager: { getBranch: () => [] } };
    new FactoryStore(cwd).saveState(runState("run-sess", { status: "paused", phase: "build" }));

    const [handler] = rec.handlers.get("session_start")!;
    await handler(undefined, ctx);

    expect(selects[0]).toMatchObject({ title: "Factory", options: ["Resume the run now", "Show status", "Not now"] });
    const lines = lastEntry(rec, "status").lines as string[];
    expect(lines[0]).toBe("run run-sess · build · paused");
    expect(notes).toHaveLength(0);
  });

  it("assigns a model to a role with the picker (fallback flow)", async () => {
    const cwd = tempDir("factory-roles-cmd-");
    const rec = recordingPi();
    const runner = new ScriptedRunner(SCRIPTS);
    createFactoryExtension({ runner })(rec.api);
    const reviewer = loadRoles({ projectDir: cwd }).get("reviewer")!;
    const roleChoice = reviewer.description ? `reviewer - ${reviewer.description}` : "reviewer";
    const { ui, notes, selects } = fakeUi({ select: [roleChoice, "p2/big-model"] });
    const ctx: any = { hasUI: true, mode: "print", ui, cwd, modelRegistry: fakeRegistry(models), sessionManager: { getBranch: () => [] } };

    await rec.commands.get("factory").handler("roles", ctx);
    expect(selects.map((s) => s.title)).toEqual(["Assign models to factory roles", "Model for the reviewer role"]);
    const saved = JSON.parse(fs.readFileSync(factoryConfigPath(), "utf8"));
    expect(saved.pins.reviewer).toMatchObject({ provider: "p2", modelId: "big-model" });
    expect(notes.at(-1)?.message).toMatch(/Role reviewer assigned to p2\/big-model/);
    // No project answers in this folder: nothing project-level was written.
    expect(new FactoryStore(cwd).loadProject()).toBeNull();
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
