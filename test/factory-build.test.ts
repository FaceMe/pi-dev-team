/** M5: parallel build loop and safety — scheduler, gate parsing, secret scan, guard, QA-first, integration merges. */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatGateFailureDetails, parseGateOutput } from "../src/factory/gate-parse.js";
import { commitAll, mergeBranch } from "../src/factory/git.js";
import { describeGateFailure } from "../src/factory/gates.js";
import { blockedCommand, inWriteScope } from "../src/factory/guard.js";
import { historyOverview, ticketHistory } from "../src/factory/history.js";
import { Mutex } from "../src/factory/mutex.js";
import { FactoryRun, newState } from "../src/factory/pipeline.js";
import type { PipelineDeps } from "../src/factory/pipeline.js";
import { loadRoles } from "../src/factory/roles.js";
import { nextRunnable } from "../src/factory/scheduler.js";
import { scanDiff, scanText, secretFiles } from "../src/factory/secrets.js";
import { defaultAnswers } from "../src/factory/settings.js";
import { FactoryStore } from "../src/factory/store.js";
import { buildTeam } from "../src/factory/team.js";
import { buildSettings } from "../src/factory/types.js";
import type { SetupAnswers, Ticket, WorkerRequest, WorkerResult, WorkerRunner } from "../src/factory/types.js";
import { fakeRegistry, makeModel, tempDir, useTempAgentDir } from "./helpers.js";
import { json, ScriptedRunner, scriptedUi } from "./factory-helpers.js";
import type { Script } from "./factory-helpers.js";

let agent: ReturnType<typeof useTempAgentDir>;
beforeEach(() => {
  agent = useTempAgentDir();
});
afterEach(() => agent.restore());

const price = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 });
const small = makeModel({ id: "gpt-small", provider: "openai", cost: price(0.2, 0.8) });
const daily = makeModel({ id: "claude-daily", provider: "anthropic", reasoning: true, cost: price(1, 5) });
const frontier = makeModel({ id: "claude-frontier", provider: "anthropic", reasoning: true, contextWindow: 400_000, cost: price(5, 25) });
const gemini = makeModel({ id: "gemini-pro", provider: "google", reasoning: true, contextWindow: 400_000, cost: price(2, 12) });
const registry = fakeRegistry([small, daily, frontier, gemini]);

function answers(overrides: Partial<SetupAnswers> = {}): SetupAnswers {
  return {
    teamPreset: "balanced",
    pins: {},
    autonomy: "auto",
    projectMode: "new",
    stack: "auto",
    research: "off",
    deploy: "none",
    budgetUsd: 0,
    budgetTokens: 0,
    ...overrides,
  };
}

function ticket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return { id, title: id, role: "backend", dependsOn: [], requirements: [], brief: "", acceptance: [], writeScope: [`src/${id}/**`], status: "todo", attempts: [], ...overrides };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

describe("scheduler", () => {
  it("starts independent tickets in parallel up to maxParallel", () => {
    const tickets = [ticket("T-001"), ticket("T-002"), ticket("T-003"), ticket("T-004")];
    expect(nextRunnable(tickets, new Set(), 3).map((t) => t.id)).toEqual(["T-001", "T-002", "T-003"]);
    expect(nextRunnable(tickets, new Set(["T-001", "T-002"]), 3).map((t) => t.id)).toEqual(["T-003"]);
    expect(nextRunnable(tickets, new Set(["T-001", "T-002", "T-003"]), 3)).toEqual([]);
  });

  it("waits for dependencies to settle; skipped dependencies count as settled", () => {
    const tickets = [ticket("T-001"), ticket("T-002", { dependsOn: ["T-001"] }), ticket("T-003", { dependsOn: ["T-001", "T-002"] })];
    expect(nextRunnable(tickets, new Set(), 3).map((t) => t.id)).toEqual(["T-001"]);
    tickets[0].status = "done";
    expect(nextRunnable(tickets, new Set(), 3).map((t) => t.id)).toEqual(["T-002"]);
    tickets[1].status = "skipped";
    expect(nextRunnable(tickets, new Set(), 3).map((t) => t.id)).toEqual(["T-003"]);
  });

  it("never runs tickets with overlapping write scopes at the same time", () => {
    const tickets = [
      ticket("T-001", { writeScope: ["src/api/**"] }),
      ticket("T-002", { writeScope: ["src/api/users/**"] }),
      ticket("T-003", { writeScope: ["web/**"] }),
    ];
    expect(nextRunnable(tickets, new Set(), 3).map((t) => t.id)).toEqual(["T-001", "T-003"]);
    expect(nextRunnable(tickets, new Set(["T-001"]), 3).map((t) => t.id)).toEqual(["T-003"]);
    // A custom scope function (the pipeline adds lockfiles to manifest-owning tickets).
    const withLock = (t: Ticket) => [...t.writeScope, "package-lock.json"];
    expect(nextRunnable([ticket("T-001"), ticket("T-002")], new Set(), 3, withLock).map((t) => t.id)).toEqual(["T-001"]);
  });

  it("resumes in-progress tickets and leaves blocked ones alone", () => {
    const tickets = [ticket("T-001", { status: "in_progress" }), ticket("T-002", { status: "blocked" }), ticket("T-003", { dependsOn: ["T-002"] })];
    expect(nextRunnable(tickets, new Set(), 3).map((t) => t.id)).toEqual(["T-001"]);
  });
});

describe("build settings", () => {
  it("defaults, clamps and reads factory.json / project.json", () => {
    const m6 = { exploratoryQa: true, qaRounds: 2, bugSeverity: "major", contributorCheck: true, tagRelease: true };
    expect(buildSettings(undefined)).toEqual({ maxParallel: 3, budgetBreaker: 0.8, escalationBreaker: 0.3, qa: true, ...m6 });
    expect(buildSettings({ maxParallel: 0, budgetBreaker: 2, escalationBreaker: 0.5, qa: false })).toEqual({ maxParallel: 3, budgetBreaker: 0.8, escalationBreaker: 0.5, qa: false, ...m6 });
    expect(buildSettings({ qaRounds: 9, bugSeverity: "minor", exploratoryQa: false } as any)).toMatchObject({ qaRounds: 5, bugSeverity: "minor", exploratoryQa: false });
    expect(buildSettings({ qaRounds: -1, bugSeverity: "huge" } as any)).toMatchObject({ qaRounds: 2, bugSeverity: "major" });
    expect(buildSettings({ maxParallel: 99 }).maxParallel).toBe(16);
    const ctx = { cwd: tempDir("factory-settings-"), toolNames: [], budget: { usd: 0, tokens: 0, priced: false, size: "small" as const }, deployTargets: [] };
    expect(defaultAnswers(ctx, {}, null).build).toBeUndefined();
    expect(defaultAnswers(ctx, { build: { maxParallel: 2, qa: false } }, { build: { maxParallel: 5 } }).build).toEqual({ maxParallel: 5, qa: false });
  });

  it("serialises work through the mutex, even after a failure", async () => {
    const mutex = new Mutex();
    const order: string[] = [];
    const slow = mutex.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("a");
      throw new Error("boom");
    });
    const fast = mutex.run(async () => {
      order.push("b");
      return 2;
    });
    await expect(slow).rejects.toThrow("boom");
    expect(await fast).toBe(2);
    expect(order).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// Structured gate failures
// ---------------------------------------------------------------------------

describe("gate output parsing", () => {
  it("reads TypeScript errors in both formats", () => {
    const out = parseGateOutput(
      "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/b.ts:10:1 - error TS2304: Cannot find name 'foo'.\nFound 2 errors.",
    );
    expect(out.errors).toEqual([
      { file: "src/a.ts", line: 3, col: 5, code: "TS2322", message: "Type 'string' is not assignable to type 'number'." },
      { file: "src/b.ts", line: 10, col: 1, code: "TS2304", message: "Cannot find name 'foo'." },
    ]);
  });

  it("reads eslint stylish output, gcc/go/mypy-style lines and rustc", () => {
    const eslint = parseGateOutput("/repo/src/x.js\n  12:5  error  'y' is not defined  no-undef\n   3:1  warning  Unexpected console  no-console\n\n✖ 1 problem");
    expect(eslint.errors).toEqual([{ file: "/repo/src/x.js", line: 12, col: 5, code: "no-undef", message: "'y' is not defined" }]);
    const generic = parseGateOutput("main.c:4:10: error: expected ';'\n./cmd/main.go:7:2: undefined: foo\napp.py:3: error: Incompatible types  [assignment]\nmain.c:9:1: warning: unused");
    expect(generic.errors.map((e) => `${e.file}:${e.line}`)).toEqual(["main.c:4", "./cmd/main.go:7", "app.py:3"]);
    const rust = parseGateOutput("error[E0308]: mismatched types\n  --> src/main.rs:3:18\n   |\nerror: could not compile `demo`");
    expect(rust.errors).toEqual([{ file: "src/main.rs", line: 3, col: 18, code: "E0308", message: "mismatched types" }]);
  });

  it("reads failing test names from common runners", () => {
    const out = parseGateOutput(
      [
        "not ok 1 - adds numbers",
        "  location: '/tmp/x/test/a.test.js:3:1'",
        "✖ subtracts numbers (1.2ms)",
        "✖ failing tests:",
        " FAIL  test/todo.test.ts > todos > creates a todo",
        "● api › rejects empty titles",
        "FAILED tests/test_api.py::test_create - AssertionError: 1 != 2",
        "--- FAIL: TestCreate (0.00s)",
        "test store::tests::insert ... FAILED",
      ].join("\n"),
    );
    expect(out.tests).toEqual([
      "adds numbers",
      "subtracts numbers",
      "test/todo.test.ts > todos > creates a todo",
      "api › rejects empty titles",
      "tests/test_api.py::test_create",
      "TestCreate",
      "store::tests::insert",
    ]);
    // The TAP location line is indented and is not mistaken for a compiler error.
    expect(out.errors).toEqual([]);
  });

  it("puts the structured summary ahead of the raw tail in gate feedback", () => {
    const output = "not ok 1 - adds numbers\nsrc/a.ts(1,1): error TS1005: ';' expected.";
    const text = describeGateFailure([{ gate: "test", command: "npm test", ok: false, exitCode: 1, durationMs: 1, output, details: parseGateOutput(output) }]);
    expect(text).toMatch(/Failing tests \(1\):\n- adds numbers/);
    expect(text).toMatch(/Errors \(1\):\n- src\/a\.ts:1:1 TS1005 ';' expected\./);
    expect(text.indexOf("Failing tests")).toBeLessThan(text.indexOf("Output (tail)"));
    expect(formatGateFailureDetails({ tests: [], errors: [] })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Secret scan
// ---------------------------------------------------------------------------

describe("secret scan", () => {
  const awsKey = `AKIA${"Z7QF3K2M9TXW4B8R"}`;

  it("finds high-confidence credentials in added lines, redacted", () => {
    const diff = [
      "diff --git a/src/config.js b/src/config.js",
      "--- a/src/config.js",
      "+++ b/src/config.js",
      "@@ -1,2 +1,3 @@",
      " export const region = 'eu';",
      `+export const key = '${awsKey}';`,
      `-export const old = 'ghp_${"a".repeat(36)}';`,
      "+export const db = 'postgres://app:s3cr3tP4ss@db:5432/app';",
    ].join("\n");
    const findings = scanDiff(diff);
    expect(findings.map((f) => [f.file, f.line, f.kind])).toEqual([
      ["src/config.js", 2, "AWS access key"],
      ["src/config.js", 3, "connection string with password"],
    ]);
    expect(findings[0].preview).not.toContain(awsKey);
  });

  it("ignores placeholders and flags committed dotenv files", () => {
    expect(scanText("a.js", "const key = 'sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxx';")).toEqual([]);
    expect(scanText("a.js", "DATABASE_URL=postgres://user:password@localhost/db")).toEqual([]);
    expect(scanText("a.js", "-----BEGIN OPENSSH PRIVATE KEY-----")).toHaveLength(1);
    expect(secretFiles([".env", "api/.env.local", ".env.example", "web/.env.sample"]).map((f) => f.file)).toEqual([".env", "api/.env.local"]);
  });
});

// ---------------------------------------------------------------------------
// Destructive-command gate
// ---------------------------------------------------------------------------

describe("destructive-command gate", () => {
  it("blocks git operations the factory owns, credential access and block devices", () => {
    for (const command of ["git merge main", "git switch -c x", "git stash", "git cherry-pick abc", "git rebase -i HEAD~2", "cat ~/.ssh/id_rsa", "cp $HOME/.aws/credentials .", "dd if=/dev/zero of=/dev/sda", "mkfs.ext4 /dev/sdb1", "doas rm x"]) {
      expect(blockedCommand(command), command).toBeDefined();
    }
    for (const command of ["git status", "git diff HEAD", "git log --oneline", "git show HEAD:src/a.ts", "git checkout -- src/a.ts", "npm test"]) {
      expect(blockedCommand(command), command).toBeUndefined();
    }
  });

  it("blocks recursive deletes of absolute paths outside the worktree", () => {
    const cwd = "/work/project";
    expect(blockedCommand("rm -rf /work/other", { cwd })).toMatch(/outside the project \(\/work\/other\)/);
    expect(blockedCommand("rm -r -f /etc/nginx", { cwd })).toBeDefined();
    expect(blockedCommand("rm -rf /work/project/dist /work/project/node_modules", { cwd })).toBeUndefined();
    expect(blockedCommand("rm -rf dist", { cwd })).toBeUndefined();
    expect(blockedCommand("rm /tmp/x.txt", { cwd })).toBeUndefined();
  });

  it("protects the run lock", () => {
    expect(inWriteScope("/p", ".factory/factory.lock.json", ["**"])).toBe(false);
  });
});

describe("git helpers", () => {
  it("concludes a merge whose resolution equals HEAD (keep-ours) instead of reporting it empty", async () => {
    const repo = tempDir("factory-git-merge-");
    const g = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
    g(["init", "-q", "-b", "main"]);
    g(["commit", "-q", "--allow-empty", "-m", "init"]);
    g(["checkout", "-q", "-b", "other"]);
    fs.writeFileSync(path.join(repo, "h.js"), "theirs\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "theirs"]);
    g(["checkout", "-q", "main"]);
    fs.writeFileSync(path.join(repo, "h.js"), "ours\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "ours"]);
    const merge = await mergeBranch(repo, "other", "sync", { keepConflicts: true });
    expect(merge).toMatchObject({ ok: false, conflicts: ["h.js"] });
    fs.writeFileSync(path.join(repo, "h.js"), "ours\n");
    const commit = await commitAll(repo, "resolve");
    expect(commit.empty).toBeUndefined();
    expect(g(["log", "-1", "--format=%P"]).trim().split(" ")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Ticket history
// ---------------------------------------------------------------------------

describe("ticket history", () => {
  it("renders worker runs, gates and events for one ticket", () => {
    const at = "2026-10-03T10:00:00.000Z";
    const entries = [
      { at, kind: "ticket", runId: "r", ticket: "T-001", event: "started", branch: "factory/r-T-001", base: "abcdef123" },
      { at, kind: "ticket", runId: "r", ticket: "T-001", event: "qa", result: "red", tests: ["test/a.test.js"] },
      { at, kind: "worker", runId: "r", ticket: "T-001", role: "backend", model: "anthropic/claude-daily", turns: 3, tokens: 1200, costUsd: 0.02, ok: true },
      { at, kind: "gates", runId: "r", ticket: "T-001", ok: false, summary: "✗ test (1.0s)", failures: { tests: ["adds numbers"], errors: [] } },
      { at, kind: "ticket", runId: "r", ticket: "T-001", event: "attempt", attempt: 1, model: "anthropic/claude-daily", outcome: "gate_fail" },
      { at, kind: "ticket", runId: "r", ticket: "T-001", event: "merged", commit: "1234567890", files: 3 },
      { at, kind: "ticket", runId: "other", ticket: "T-001", event: "done", attempts: 9 },
      { at, kind: "ticket", runId: "r", ticket: "T-002", event: "done", attempts: 1 },
    ];
    const lines = ticketHistory(entries, "T-001", "r");
    expect(lines[0]).toMatch(/^history of T-001 — \$0\.02/);
    expect(lines.slice(1).map((l) => l.slice(10))).toEqual([
      "started on factory/r-T-001 from abcdef1",
      "QA: red — test/a.test.js",
      expect.stringMatching(/^backend · anthropic\/claude-daily · 3 turn\(s\)/),
      "gates FAILED: ✗ test (1.0s) — failing: adds numbers",
      "attempt 1: gate_fail · anthropic/claude-daily",
      "merged into integration 1234567 (3 files)",
    ]);
    expect(ticketHistory(entries, "T-009", "r")).toEqual(["No history for T-009 in r."]);
    const overview = historyOverview(entries, [{ ...ticket("T-001"), status: "done", attempts: [{ outcome: "gate_fail" }, { outcome: "ok" }] }], "r");
    expect(overview[1]).toMatch(/^✓ T-001 T-001 · 2 attempt\(s\) \(gate_fail → ok\) · \$0\.02/);
  });
});

// ---------------------------------------------------------------------------
// The parallel build loop, end to end (real git, real gates, scripted workers)
// ---------------------------------------------------------------------------

const TODO_SPEC = `# Spec

## Functional requirements
- FR-001 Store todos.
  - Given a title When a todo is added Then it is listed. Source: brief.
- FR-002 HTTP API lists todos.
  - Given stored todos When GET /todos Then they are returned as JSON. Source: brief.
- FR-003 Web UI renders todos.
  - Given todos When the page renders Then each todo is a list item. Source: brief.
`;

const TODO_TICKETS = [
  { id: "T-001", title: "Todo store", role: "backend", dependsOn: [], requirements: ["FR-001"], brief: "In-memory store in src/store/store.js", acceptance: ["Given a title When added Then listed"], writeScope: ["src/store/**", "test/store/**"] },
  { id: "T-002", title: "Todo HTTP handlers", role: "backend", dependsOn: ["T-001"], requirements: ["FR-002"], brief: "Handlers in src/api/handlers.js", acceptance: ["Given todos When GET /todos Then JSON"], writeScope: ["src/api/**", "test/api/**"] },
  { id: "T-003", title: "Web UI list", role: "frontend", dependsOn: ["T-001"], requirements: ["FR-003"], brief: "Render todos in web/render.js", acceptance: ["Given todos When rendered Then list items"], writeScope: ["web/**", "test/web/**"] },
];

const testFile = (imp: string, body: string) => `import test from 'node:test';\nimport assert from 'node:assert';\n${imp}\n${body}\n`;

/** Acceptance tests QA writes (they fail until the builder implements the module). */
const QA_TESTS: Record<string, Record<string, string>> = {
  "T-001": { "test/store/store.test.js": testFile("import { addTodo, listTodos } from '../../src/store/store.js';", "test('adds a todo', () => { addTodo('a'); assert.deepEqual(listTodos(), ['a']); });") },
  "T-002": { "test/api/handlers.test.js": testFile("import { getTodos } from '../../src/api/handlers.js';", "test('lists todos as JSON', () => assert.equal(getTodos([\"a\"]), '[\"a\"]'));") },
  "T-003": { "test/web/render.test.js": testFile("import { render } from '../../web/render.js';", "test('renders list items', () => assert.equal(render(['a']), '<li>a</li>'));") },
};

const IMPLEMENTATIONS: Record<string, Record<string, string>> = {
  "T-001": { "src/store/store.js": "const todos = [];\nexport const addTodo = (t) => todos.push(t);\nexport const listTodos = () => [...todos];\n" },
  "T-002": { "src/api/handlers.js": "export const getTodos = (todos) => JSON.stringify(todos);\n" },
  "T-003": { "web/render.js": "export const render = (todos) => todos.map((t) => `<li>${t}</li>`).join('');\n" },
};

const ticketOf = (req: WorkerRequest) => /-(T-\d+)(?:-qa|-review)?$/.exec(req.sessionId)?.[1] ?? "";

function todoScripts(overrides: Record<string, Script> = {}): Record<string, Script> {
  const builder: Script = (req) => ({ text: "Implemented.", files: IMPLEMENTATIONS[ticketOf(req)] });
  return {
    analyst: (req) =>
      req.prompt.includes("interview round")
        ? { text: json({ ready: true, questions: [] }) }
        : { text: "Spec written.", files: { ".factory/spec/spec.md": TODO_SPEC } },
    architect: () => ({
      text: json({ stack: "Node 22 + node:test", gates: { install: "true", test: "node --test" }, manifests: ["package.json"], contracts: ["todo-api.md"] }),
      files: { ".factory/adr/0001-architecture.md": "# ADR 1\nNode, node:test.\n", ".factory/contracts/todo-api.md": "# API\nGET /todos -> string[]\n" },
    }),
    designer: () => ({ text: "Design ready.", files: {
      ".factory/design/design-system.md": "# Design system\nAccessible neutral palette.",
      ".factory/design/handoff.md": "# Handoff\nRender todos as semantic list items.",
      ".factory/design/preview.html": "<!doctype html><ul><li>Example todo</li></ul>",
      ".factory/design/evidence.json": JSON.stringify({ status: "untested", reason: "No browser integration configured" }),
    } }),
    planner: () => ({ text: json({ tickets: TODO_TICKETS }) }),
    devops: () => ({
      text: "Skeleton ready.",
      files: {
        "package.json": JSON.stringify({ name: "todo", type: "module" }),
        "test/smoke.test.js": "import test from 'node:test';\ntest('smoke', () => {});\n",
        ".gitignore": "node_modules/\n.factory/\n",
      },
    }),
    qa: (req) => {
      const id = ticketOf(req);
      // T-002's QA also writes implementation code, which is outside its test-only scope.
      return { text: "Tests written.", files: { ...QA_TESTS[id], ...(id === "T-002" ? { "src/api/handlers.js": "export const getTodos = () => 'cheat';\n" } : {}) } };
    },
    backend: builder,
    frontend: req => {
      expect(fs.readFileSync(path.join(req.cwd, "docs/design/handoff.md"), "utf8")).toContain("semantic list items");
      expect(fs.readFileSync(path.join(req.cwd, "docs/design/design-system.md"), "utf8")).toContain("neutral palette");
      expect(fs.readFileSync(path.join(req.cwd, "docs/design/preview.html"), "utf8")).toContain("Example todo");
      expect(req.prompt).toContain("docs/design/handoff.md");
      return builder(req, 1);
    },
    reviewer: () => ({ text: json({ verdict: "approve", findings: [] }) }),
    docs: () => ({ text: "Docs written.", files: { "README.md": "# Todo\n\nRun `node --test`.\n" } }),
    ...overrides,
  };
}

/** Wraps a runner with a delay on ticket work and records how many tickets were in flight at once. */
class ConcurrencyRunner implements WorkerRunner {
  private active = new Map<string, number>();
  maxTickets = 0;

  constructor(readonly inner: ScriptedRunner, private readonly delayMs = 150) {}

  async run(request: WorkerRequest): Promise<WorkerResult> {
    const id = ticketOf(request);
    if (!id) return this.inner.run(request);
    this.active.set(id, (this.active.get(id) ?? 0) + 1);
    this.maxTickets = Math.max(this.maxTickets, this.active.size);
    try {
      await new Promise((r) => setTimeout(r, this.delayMs));
      return await this.inner.run(request);
    } finally {
      const n = (this.active.get(id) ?? 1) - 1;
      if (n === 0) this.active.delete(id);
      else this.active.set(id, n);
    }
  }
}

function makeDeps(cwd: string, runner: WorkerRunner, ui: ReturnType<typeof scriptedUi>["ui"], a: SetupAnswers): PipelineDeps {
  const roles = loadRoles();
  return { cwd, ui, runner, roles, team: buildTeam(registry, roles, a), answers: a, store: new FactoryStore(cwd), webAccess: false, gateTimeoutMs: 60_000 };
}

const gitIn = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

describe("parallel build loop", () => {
  it("builds a TODO API with a web UI: QA first, parallel tickets, integration merges, history in the ledger", async () => {
    const cwd = tempDir("factory-m5-");
    const scripted = new ScriptedRunner(todoScripts());
    const runner = new ConcurrencyRunner(scripted);
    const { ui } = scriptedUi();
    const a = answers();
    const deps = makeDeps(cwd, runner, ui, a);
    const final = await new FactoryRun(deps, newState("A TODO API with a web UI", "run-m5", a)).run();

    expect(final.lastError).toBeUndefined();
    expect(final.status).toBe("done");
    expect(final.tickets.map((t) => [t.id, t.status, t.qa])).toEqual([
      ["T-001", "done", "written"],
      ["T-002", "done", "written"],
      ["T-003", "done", "written"],
    ]);
    expect(scripted.calls.findIndex(call => call.role === "designer")).toBeLessThan(scripted.calls.findIndex(call => call.role === "planner"));
    expect(deps.store.read("design/handoff.md")).toContain("semantic list items");
    expect(deps.store.read("design/inputs.json")).toContain("Web UI renders todos");
    // T-002 and T-003 both depend only on T-001 and have disjoint scopes: they were built at the same time.
    expect(runner.maxTickets).toBe(2);

    // Merged into the user's branch with one integration merge per ticket.
    for (const files of [...Object.values(IMPLEMENTATIONS), ...Object.values(QA_TESTS)]) {
      for (const [rel, content] of Object.entries(files)) expect(fs.readFileSync(path.join(cwd, rel), "utf8")).toBe(content);
    }
    const log = gitIn(cwd, ["log", "--oneline"]);
    for (const t of TODO_TICKETS) {
      expect(log).toContain(`Merge ${t.id}: ${t.title}`);
      expect(log).toContain(`test(${t.id}): acceptance tests (QA)`);
      expect(log).toContain(`feat(${t.id}): ${t.title}`);
    }
    // QA's out-of-scope implementation was reverted, never committed.
    expect(gitIn(cwd, ["log", "--all", "--format=%s", "--", "src/api/handlers.js"]).trim().split("\n")).toEqual(["feat(T-002): Todo HTTP handlers"]);
    // QA ran with only the ticket's test globs; the builder was told about the QA tests.
    const qaCall = scripted.calls.find((c) => c.role === "qa" && ticketOf(c) === "T-003")!;
    expect(qaCall.writeScope).toEqual(["test/web/**"]);
    const builderCall = scripted.calls.find((c) => c.role === "frontend")!;
    expect(builderCall.prompt).toContain("QA already wrote failing acceptance tests for this ticket: test/web/render.test.js");
    expect(builderCall.cwd).toBe(deps.store.path("worktrees", "run-m5-T-003"));

    // Ticket worktrees and branches are cleaned up.
    expect(fs.readdirSync(deps.store.path("worktrees"))).toEqual([]);
    // Ticket branches are deleted; the factory branch itself stays, as before M5.
    expect(gitIn(cwd, ["branch", "--list", "factory/*"]).trim()).toBe("factory/run-m5");

    // Each ticket's history is in the ledger.
    const ledger = deps.store.readLedger();
    for (const t of TODO_TICKETS) {
      const events = ledger.filter((e) => e.kind === "ticket" && e.ticket === t.id).map((e) => e.event);
      expect(events).toEqual(["started", "qa", "review", "merged", "attempt", "done"]);
      const qa = ledger.find((e) => e.kind === "ticket" && e.ticket === t.id && e.event === "qa")!;
      expect(qa.result).toBe("red");
      expect(ledger.some((e) => e.kind === "gates" && e.ticket === t.id && e.where === "integration" && e.ok)).toBe(true);
      expect(ledger.some((e) => e.kind === "gates" && e.ticket === t.id && e.where === "qa" && !e.ok && e.failures)).toBe(true);
    }
    const history = ticketHistory(ledger, "T-002", "run-m5");
    expect(history.join("\n")).toMatch(/QA: red — test\/api\/handlers\.test\.js/);
    expect(history.join("\n")).toMatch(/merged into integration/);
    expect(fs.readFileSync(path.join(cwd, ".factory/report.md"), "utf8")).toContain("Secret scan: clean");
  }, 120_000);

  it("runs tickets one at a time when maxParallel is 1, and skips QA when disabled", async () => {
    const cwd = tempDir("factory-m5-serial-");
    const scripted = new ScriptedRunner(todoScripts());
    const runner = new ConcurrencyRunner(scripted, 20);
    const { ui } = scriptedUi();
    const a = answers({ build: { maxParallel: 1, qa: false } });
    const deps = makeDeps(cwd, runner, ui, a);
    const final = await new FactoryRun(deps, newState("A TODO API with a web UI", "run-serial", a)).run();
    expect(final.status).toBe("done");
    expect(runner.maxTickets).toBe(1);
    // QA-first is off; exploratory QA after the build is a separate setting.
    expect(scripted.calls.filter((c) => c.role === "qa" && !/-verify-\d+$/.test(c.sessionId)).length).toBe(0);
    expect(final.tickets.every((t) => t.qa === "skipped")).toBe(true);
    expect(scripted.calls.find((c) => c.role === "backend")!.prompt).toContain("Write the tests for the acceptance criteria first");
  }, 120_000);

  it("careful autonomy: approves each ticket commit, and sends requested changes back to the builder", async () => {
    const cwd = tempDir("factory-m5-careful-");
    const scripted = new ScriptedRunner(todoScripts());
    let asked = false;
    const { ui, selects } = scriptedUi({
      select: (title, options) => {
        if (title.startsWith("Commit T-002") && !asked) {
          asked = true;
          return "Request changes…";
        }
        return options[0];
      },
      input: (title) => (title.includes("T-002") ? "name the handler listTodosJson" : undefined),
    });
    const a = answers({ autonomy: "careful", build: { maxParallel: 1 } });
    const deps = makeDeps(cwd, scripted, ui, a);
    const final = await new FactoryRun(deps, newState("A TODO API with a web UI", "run-careful", a)).run();
    expect(final.status).toBe("done");
    expect(selects.filter((s) => s.title.startsWith("Commit ")).map((s) => s.title.split(":")[0])).toEqual(["Commit T-001", "Commit T-002", "Commit T-002", "Commit T-003"]);
    const t2 = scripted.calls.filter((c) => c.role === "backend" && ticketOf(c) === "T-002");
    expect(t2).toHaveLength(2);
    expect(t2[1].prompt).toContain("name the handler listTodosJson");
  }, 120_000);

  it("blocks a ticket with a leaked credential from merging until it is removed", async () => {
    const cwd = tempDir("factory-m5-secret-");
    const key = `AKIA${"Z7QF3K2M9TXW4B8R"}`;
    const calls = new Map<string, number>();
    const scripted = new ScriptedRunner(
      todoScripts({
        backend: (req) => {
          const id = ticketOf(req);
          const n = (calls.get(id) ?? 0) + 1;
          calls.set(id, n);
          if (id === "T-001" && n === 1) return { text: "done", files: { ...IMPLEMENTATIONS[id], "src/store/config.js": `export const key = '${key}';\n` } };
          if (id === "T-001" && n === 2) return { text: "removed", files: { "src/store/config.js": "export const key = process.env.STORE_KEY;\n" } };
          return { text: "done", files: IMPLEMENTATIONS[id] };
        },
      }),
    );
    const { ui } = scriptedUi();
    const a = answers();
    const deps = makeDeps(cwd, scripted, ui, a);
    const final = await new FactoryRun(deps, newState("A TODO API with a web UI", "run-secret", a)).run();
    expect(final.status).toBe("done");
    const t1 = final.tickets.find((t) => t.id === "T-001")!;
    expect(t1.attempts.map((x) => x.outcome)).toEqual(["secret", "ok"]);
    expect(t1.attempts[0].note).toContain("AWS access key");
    const second = scripted.calls.filter((c) => c.role === "backend" && ticketOf(c) === "T-001")[1];
    expect(second.prompt).toContain("secret scan blocked T-001");
    expect(second.prompt).not.toContain(key);
    expect(gitIn(cwd, ["log", "--all", "-p"]).includes(key)).toBe(false);
  }, 120_000);

  it("undoes a merge that turns integration red and hands the failure back to the builder", async () => {
    const cwd = tempDir("factory-m5-integration-");
    // T-003's test asserts src/api/flag.txt does not exist; T-002 creates it. Each passes alone.
    const calls = new Map<string, number>();
    const scripted = new ScriptedRunner(
      todoScripts({
        backend: (req) => {
          const id = ticketOf(req);
          const n = (calls.get(id) ?? 0) + 1;
          calls.set(id, n);
          if (id !== "T-002") return { text: "done", files: IMPLEMENTATIONS[id] };
          if (req.prompt.includes("integration branch")) return { text: "removed the flag", files: { "src/api/flag.txt": null } };
          return { text: "done", files: { ...IMPLEMENTATIONS[id], "src/api/flag.txt": "on\n" } };
        },
        frontend: (req) => {
          const guard = testFile("import fs from 'node:fs';", "test('no api flag', () => assert.equal(fs.existsSync('src/api/flag.txt'), false));");
          if (req.prompt.includes("integration branch")) return { text: "fixed", files: { "test/web/flag.test.js": testFile("", "test('no-op', () => {});") } };
          return { text: "done", files: { ...IMPLEMENTATIONS["T-003"], "test/web/flag.test.js": guard } };
        },
      }),
    );
    const runner = new ConcurrencyRunner(scripted, 50);
    const { ui } = scriptedUi();
    const a = answers({ build: { qa: false } });
    const deps = makeDeps(cwd, runner, ui, a);
    const final = await new FactoryRun(deps, newState("A TODO API with a web UI", "run-integration", a)).run();
    expect(final.status).toBe("done");
    const outcomes = final.tickets.filter((t) => t.id !== "T-001").map((t) => t.attempts.map((x) => x.outcome).join(","));
    // Whichever of T-002 / T-003 merged second hit the red integration and fixed it.
    expect(outcomes.sort()).toEqual(["integration_fail,ok", "ok"]);
    const failed = final.tickets.find((t) => t.attempts[0]?.outcome === "integration_fail")!;
    const retry = scripted.calls.filter((c) => ticketOf(c) === failed.id && c.role !== "reviewer").at(-1)!;
    expect(retry.prompt).toContain("gates failed after it was merged");
    expect(retry.prompt).toMatch(/Failing tests \(1\):\n- no api flag/);
    const ledger = deps.store.readLedger();
    expect(ledger.some((e) => e.kind === "ticket" && e.event === "integration_fail" && e.ticket === failed.id)).toBe(true);
    // Integration is green at the end and everything reached the user's branch.
    expect(fs.existsSync(path.join(cwd, "src/api/flag.txt"))).toBe(failed.id === "T-003");
    expect(fs.readFileSync(path.join(cwd, "web/render.js"), "utf8")).toContain("<li>");
  }, 120_000);

  it("hands a merge conflict with the integration branch to the builder to resolve", async () => {
    const cwd = tempDir("factory-m5-conflict-");
    const runId = "run-conflict";
    let injected = false;
    const scripted = new ScriptedRunner(
      todoScripts({
        backend: (req) => {
          const id = ticketOf(req);
          if (id !== "T-002") return { text: "done", files: IMPLEMENTATIONS[id] };
          if (!injected) {
            // Someone lands a change to the same file on integration while T-002 is in flight.
            injected = true;
            const integration = path.join(cwd, ".factory", "worktrees", runId);
            fs.mkdirSync(path.join(integration, "src/api"), { recursive: true });
            fs.writeFileSync(path.join(integration, "src/api/handlers.js"), "export const getTodos = () => 'integration';\n");
            gitIn(integration, ["add", "-A"]);
            gitIn(integration, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "hotfix on integration"]);
            return { text: "done", files: IMPLEMENTATIONS[id] };
          }
          expect(req.prompt).toContain("these files\nconflict:\n- src/api/handlers.js");
          expect(fs.readFileSync(path.join(req.cwd, "src/api/handlers.js"), "utf8")).toMatch(/^<<<<<<< /m);
          return { text: "resolved", files: IMPLEMENTATIONS[id] };
        },
      }),
    );
    const { ui } = scriptedUi();
    const a = answers({ build: { qa: false } });
    const deps = makeDeps(cwd, scripted, ui, a);
    const final = await new FactoryRun(deps, newState("A TODO API with a web UI", runId, a)).run();
    expect(final.lastError).toBeUndefined();
    expect(final.status).toBe("done");
    expect(final.tickets.find((t) => t.id === "T-002")!.attempts.map((x) => x.outcome)).toEqual(["conflict", "ok"]);
    expect(fs.readFileSync(path.join(cwd, "src/api/handlers.js"), "utf8")).toBe(IMPLEMENTATIONS["T-002"]["src/api/handlers.js"]);
    expect(deps.store.readLedger().some((e) => e.kind === "ticket" && e.event === "conflict" && e.files?.includes("src/api/handlers.js"))).toBe(true);
  }, 120_000);

  it("pauses every in-flight ticket when one is blocked, then resumes from the ticket worktrees", async () => {
    const cwd = tempDir("factory-m5-blocked-");
    let broken = true;
    const scripted = new ScriptedRunner(
      todoScripts({
        frontend: () =>
          broken
            ? { text: "attempt", files: { "web/render.js": "export const render = () => '';\n" } }
            : { text: "fixed", files: IMPLEMENTATIONS["T-003"] },
      }),
    );
    const runner = new ConcurrencyRunner(scripted, 30);
    const { ui, selects } = scriptedUi({
      select: (title, options) => (title.includes("still fails") ? options.find((o) => o.startsWith("Pause"))! : options[0]),
    });
    const a = answers();
    const deps = makeDeps(cwd, runner, ui, a);
    const first = await new FactoryRun(deps, newState("A TODO API with a web UI", "run-blocked", a)).run();
    expect(first.status).toBe("paused");
    expect(first.phase).toBe("build");
    const t3 = first.tickets.find((t) => t.id === "T-003")!;
    expect(t3.status).toBe("blocked");
    expect(t3.escalated).toBe(true);
    // 1 of 3 tickets escalated (> 30%): the breaker asked once and the run continued.
    expect(selects.filter((s) => s.title.includes("needed a stronger model"))).toHaveLength(1);
    expect(fs.existsSync(t3.worktree!)).toBe(true);

    broken = false;
    const second = await new FactoryRun(deps, deps.store.loadState()!).run();
    expect(second.status).toBe("done");
    expect(second.tickets.every((t) => t.status === "done")).toBe(true);
    // Acknowledged once per run: the breaker did not ask again.
    expect(selects.filter((s) => s.title.includes("needed a stronger model"))).toHaveLength(1);
    expect(fs.readFileSync(path.join(cwd, "web/render.js"), "utf8")).toBe(IMPLEMENTATIONS["T-003"]["web/render.js"]);
  }, 120_000);
});
