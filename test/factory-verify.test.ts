/** M6: integration and verification, the new-contributor check, release notes, tag and retrospective. */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restoreAfter, untrackedFiles } from "../src/factory/git.js";
import { FactoryRun, newState } from "../src/factory/pipeline.js";
import type { PipelineDeps } from "../src/factory/pipeline.js";
import { loadRoles } from "../src/factory/roles.js";
import { FactoryStore } from "../src/factory/store.js";
import { buildTeam } from "../src/factory/team.js";
import type { FactoryState, SetupAnswers, Ticket, WorkerRequest } from "../src/factory/types.js";
import {
  atLeast,
  bugTickets,
  judgeContributor,
  nextBugId,
  normalizeContributorReport,
  normalizeQaReport,
  projectVersion,
  releaseNotes,
  retrospective,
} from "../src/factory/verify.js";
import { fakeRegistry, makeModel, tempDir, useTempAgentDir } from "./helpers.js";
import { json, ScriptedRunner, scriptedUi } from "./factory-helpers.js";
import type { Script } from "./factory-helpers.js";

let agent: ReturnType<typeof useTempAgentDir>;
beforeEach(() => {
  agent = useTempAgentDir();
});
afterEach(() => agent.restore());

const price = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 });
const registry = fakeRegistry([
  makeModel({ id: "gpt-small", provider: "openai", cost: price(0.2, 0.8) }),
  makeModel({ id: "claude-daily", provider: "anthropic", reasoning: true, cost: price(1, 5) }),
  makeModel({ id: "claude-frontier", provider: "anthropic", reasoning: true, contextWindow: 400_000, cost: price(5, 25) }),
  makeModel({ id: "gemini-pro", provider: "google", reasoning: true, contextWindow: 400_000, cost: price(2, 12) }),
]);

function answers(overrides: Partial<SetupAnswers> = {}): SetupAnswers {
  return { teamPreset: "balanced", pins: {}, autonomy: "auto", projectMode: "new", stack: "auto", research: "off", deploy: "none", budgetUsd: 0, budgetTokens: 0, ...overrides };
}

function ticket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return { id, title: id, role: "backend", dependsOn: [], requirements: [], brief: "", acceptance: [], writeScope: [`src/${id}/**`], status: "todo", attempts: [], ...overrides };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("exploratory QA reports", () => {
  it("validates the reply and defaults unknown severities to major", () => {
    expect(normalizeQaReport({ summary: "x" }).error).toMatch(/bugs/);
    expect(normalizeQaReport({ bugs: [{ severity: "major" }] }).error).toMatch(/title/);
    const { value } = normalizeQaReport({
      summary: "tried it",
      checks: [{ requirement: "FR-001", result: "pass" }, { requirement: "FR-002", result: "weird" }],
      bugs: [{ title: "Crash on empty input", severity: "catastrophic", steps: "run it with no args", expected: "usage", actual: "stack trace" }],
    });
    expect(value!.checks.map((c) => c.result)).toEqual(["pass", "untested"]);
    expect(value!.bugs[0]).toMatchObject({ severity: "major", steps: ["run it with no args"] });
    expect(atLeast("critical", "major")).toBe(true);
    expect(atLeast("minor", "major")).toBe(false);
  });

  it("turns findings into bug tickets owned by the requirement's tickets, above the threshold, without duplicates", () => {
    const tickets = [
      ticket("T-001", { requirements: ["FR-001"], writeScope: ["src/cli/**", "test/cli/**"], status: "done" }),
      ticket("T-002", { role: "frontend", requirements: ["FR-002"], writeScope: ["web/**"], status: "done" }),
      ticket("B-001", { kind: "bug", title: "Fix: Crash on empty input", status: "todo" }),
    ];
    const report = normalizeQaReport({
      bugs: [
        { title: "Wrong total", severity: "major", requirement: "FR-001", steps: ["add 1 2"], expected: "3", actual: "12" },
        { title: "Button misaligned", severity: "minor", requirement: "FR-002" },
        { title: "Crash on empty input", severity: "critical" },
        { title: "Page blank on reload", severity: "critical", requirement: "FR-002" },
      ],
    }).value!;
    const created = bugTickets(report, tickets, "major", 1);
    expect(created.map((t) => [t.id, t.title, t.role, t.writeScope])).toEqual([
      ["B-002", "Fix: Wrong total", "backend", ["src/cli/**", "test/cli/**"]],
      ["B-003", "Fix: Page blank on reload", "frontend", ["web/**"]],
    ]);
    expect(created[0]).toMatchObject({ kind: "bug", severity: "major", foundInRound: 1, requirements: ["FR-001"], status: "todo" });
    expect(created[0].brief).toMatch(/Steps to reproduce:\n1\. add 1 2/);
    expect(created[0].acceptance.join(" ")).toMatch(/regression test/);
    expect(nextBugId([...tickets, ...created])).toBe("B-004");
  });
});

describe("new-contributor check", () => {
  const report = normalizeContributorReport({ setup: ["npm i"], test: "npm test", extension: { description: "add --version", files: ["src/cli.js"] }, gaps: [], ok: true }).value!;

  it("requires the documented test command", () => {
    expect(normalizeContributorReport({ setup: [] }).error).toMatch(/test/);
    expect(report.test).toEqual(["npm test"]);
  });

  it("is judged on evidence: documented commands, gates and a real change", () => {
    const base = { round: 1, report, docCommands: [{ command: "npm test", ok: true, output: "" }], gatesOk: true, gatesSummary: "test ✓", changedFiles: ["src/cli.js"] };
    expect(judgeContributor(base).passed).toBe(true);
    expect(judgeContributor({ ...base, docCommands: [{ command: "npm test", ok: false, output: "" }] }).reasons).toEqual(["documented test command failed: `npm test`"]);
    expect(judgeContributor({ ...base, changedFiles: [] }).reasons).toEqual(["no extension was made"]);
    expect(judgeContributor({ ...base, gatesOk: false }).passed).toBe(false);
    const gaps = { ...report, ok: false, gaps: [{ doc: "README.md", problem: "no install step", blocking: true }] };
    expect(judgeContributor({ ...base, report: gaps }).reasons).toEqual(["the contributor could not finish from the docs alone", "1 blocking documentation gap(s)"]);
    expect(judgeContributor({ ...base, report: undefined }).reasons[0]).toMatch(/no usable report/);
  });
});

describe("cleanup after a read-only worker", () => {
  it("restores tracked files and removes only the files the worker added", async () => {
    const dir = tempDir("factory-restore-");
    const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    g("init", "-q");
    fs.writeFileSync(path.join(dir, "a.txt"), "original\n");
    g("add", "a.txt");
    g("-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "-m", "a");
    fs.mkdirSync(path.join(dir, ".venv"));
    fs.writeFileSync(path.join(dir, ".venv/dep.py"), "installed\n"); // not git-ignored
    const before = new Set(await untrackedFiles(dir));
    fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
    fs.writeFileSync(path.join(dir, "scratch.log"), "x\n");
    expect(await restoreAfter(dir, before)).toEqual(["scratch.log"]);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("original\n");
    expect(fs.existsSync(path.join(dir, ".venv/dep.py"))).toBe(true);
  });
});

describe("release and retrospective", () => {
  it("reads the version from the manifest", () => {
    const dir = tempDir("factory-version-");
    expect(projectVersion(dir)).toBe("0.1.0");
    fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "x"\nversion = "1.4.2"\n');
    expect(projectVersion(dir)).toBe("1.4.2");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "2.0.0" }));
    expect(projectVersion(dir)).toBe("2.0.0");
  });

  const state: FactoryState = {
    ...newState("A CLI calculator", "run-m6", answers()),
    tickets: [
      ticket("T-001", { title: "Add", requirements: ["FR-001"], status: "done", attempts: [{ model: "a/x", outcome: "gate_fail", costUsd: 0.1, at: "" }, { model: "b/y", outcome: "ok", costUsd: 0.2, at: "" }], escalated: true }),
      ticket("T-002", { title: "Export", status: "skipped" }),
      ticket("B-001", { title: "Fix: Wrong total", kind: "bug", severity: "major", foundInRound: 1, status: "done" }),
    ],
  };
  const contributor = judgeContributor({ round: 1, report: { setup: [], test: ["npm test"], run: [], extension: { description: "x", files: [] }, gaps: [{ doc: "README.md", problem: "no usage example", blocking: false }], ok: true }, docCommands: [], gatesOk: true, gatesSummary: "ok", changedFiles: ["a"] });

  it("writes release notes with fixes and known issues", () => {
    const notes = releaseNotes({ state, version: "0.1.0", gatesSummary: "test ✓", qaRounds: 2, openBugs: [{ title: "Slow on big input", severity: "major", steps: [], expected: "", actual: "" }], contributor });
    expect(notes).toMatch(/# Release 0\.1\.0/);
    expect(notes).toMatch(/## Delivered\n\n- Add \(FR-001\)/);
    expect(notes).toMatch(/## Fixed during verification\n\n- Wrong total \(major\)/);
    expect(notes).toMatch(/T-002 Export — skipped/);
    expect(notes).toMatch(/major: Slow on big input/);
    expect(notes).toMatch(/New-contributor check: passed/);
  });

  it("writes a retrospective with cost by phase, escalations, failures and follow-ups", () => {
    const ledger = [
      { kind: "worker", runId: "run-m6", phase: "build", role: "backend", model: "a/x", tokens: 1000, costUsd: 0.3 },
      { kind: "worker", runId: "run-m6", phase: "verify", role: "qa", model: "a/x", tokens: 500, costUsd: 0.1 },
      { kind: "worker", runId: "other", phase: "build", role: "backend", model: "a/x", tokens: 9, costUsd: 9 },
    ];
    const retro = retrospective({ state, ledger, merged: true, gatesOk: true, qaRounds: 2, openBugs: [], minorBugs: [{ title: "Typo in help", severity: "minor", steps: [], expected: "", actual: "" }], untested: ["FR-009"], contributor });
    expect(retro).toMatch(/2\/3 tickets done \(1 features, 1 bug fixes\)/);
    expect(retro).toMatch(/\| build \| 1 \| .* \| \$0\.30 \|/);
    expect(retro).toMatch(/\| verify \| 1 \|/);
    expect(retro).not.toMatch(/\$9/);
    expect(retro).toMatch(/T-001 Add: a\/x → b\/y/);
    expect(retro).toMatch(/T-001: gate_fail → ok/);
    for (const followUp of ["T-002 Export (skipped)", "Fix (minor): Typo in help", "end-to-end check for FR-009", "Docs (README.md): no usage example"]) {
      expect(retro).toContain(followUp);
    }
  });
});

// ---------------------------------------------------------------------------
// End to end: build → verify (bug loop) → docs → contributor check → release
// ---------------------------------------------------------------------------

const SPEC = `# Spec

## Functional requirements
- FR-001 Add two numbers given on the command line.
  - Given "1" and "2" When added Then 3 is printed. Source: brief.
`;

const addTest = "import test from 'node:test';\nimport assert from 'node:assert';\nimport { add } from '../src/add.js';\ntest('add', () => assert.equal(add(1, 2), 3));\n";
const regressionTest = "import test from 'node:test';\nimport assert from 'node:assert';\nimport { add } from '../src/add.js';\ntest('adds numeric strings', () => assert.equal(add('1', '2'), 3));\n";
const bugOf = (req: WorkerRequest) => /-(B-\d+)(?:-qa|-review)?$/.exec(req.sessionId)?.[1];

function scripts(overrides: Record<string, Script> = {}): Record<string, Script> {
  return {
    analyst: (req) => (req.prompt.includes("interview round") ? { text: json({ ready: true, questions: [] }) } : { text: "Spec written.", files: { ".factory/spec/spec.md": SPEC } }),
    architect: () => ({
      text: json({ stack: "Node 22 + node:test", gates: { install: "true", test: "node --test" }, manifests: ["package.json"] }),
      files: { ".factory/adr/0001-architecture.md": "# ADR 1\nNode, node:test.\n" },
    }),
    planner: () => ({
      text: json({ tickets: [{ id: "T-001", title: "Add command", role: "backend", dependsOn: [], requirements: ["FR-001"], brief: "src/add.js", acceptance: ["Given 1,2 When add Then 3"], writeScope: ["src/**", "test/**"] }] }),
    }),
    devops: () => ({
      text: "Skeleton ready.",
      files: { "package.json": JSON.stringify({ name: "calc", type: "module" }), "test/smoke.test.js": "import test from 'node:test';\ntest('smoke', () => {});\n", ".gitignore": "node_modules/\n.factory/\n" },
    }),
    // QA: no QA-first tests for T-001; a regression test for bug tickets; exploratory QA finds the string bug once.
    qa: (req) => {
      if (req.prompt.startsWith("Exploratory QA, round 1")) {
        return {
          // Leftovers a read-only QA must not leave behind: a scratch file and an edited tracked file.
          files: { "scratch.txt": "notes\n", "test/smoke.test.js": "broken" },
          text: json({
            summary: "The CLI concatenates numbers given as strings.",
            checks: [{ requirement: "FR-001", result: "fail", evidence: "add('1','2') → '12'" }],
            bugs: [
              { title: "Numbers from the command line are concatenated", severity: "major", requirement: "FR-001", steps: ["add('1', '2')"], expected: "3", actual: "'12'" },
              { title: "No --help text", severity: "minor" },
            ],
          }),
        };
      }
      if (req.prompt.startsWith("Exploratory QA")) {
        return { text: json({ summary: "All good now.", checks: [{ requirement: "FR-001", result: "pass" }], bugs: [{ title: "No --help text", severity: "minor" }] }) };
      }
      return bugOf(req) ? { text: "Regression test written.", files: { "test/regression.test.js": regressionTest } } : { text: "Nothing to add." };
    },
    backend: (req) =>
      bugOf(req)
        ? { text: "Fixed.", files: { "src/add.js": "export const add = (a, b) => Number(a) + Number(b);\n" } }
        : { text: "Implemented.", files: { "src/add.js": "export const add = (a, b) => a + b;\n", "test/add.test.js": addTest } },
    reviewer: () => ({ text: json({ verdict: "approve", findings: [] }) }),
    docs: (req) =>
      req.prompt.includes("A new contributor tried")
        ? { text: "Added the setup section.", files: { "README.md": "# Calc\n\n## Setup\n\nNode 22, no install needed.\n\n## Test\n\n`node --test`\n" } }
        : { text: "Docs written.", files: { "README.md": "# Calc\n\nRun `node --test`.\n", "AGENTS.md": "# Agents\n\nTests in test/, run `node --test`.\n" } },
    // The contributor works in a fresh clone: round 1 gets stuck on the docs, round 2 succeeds.
    contributor: (req, n) =>
      n === 1
        ? {
            text: json({ setup: [], test: ["node --test"], run: [], extension: { description: "none yet", files: [] }, gaps: [{ doc: "README.md", problem: "no setup section", blocking: true }], ok: false }),
            files: { "src/sub.js": "export const sub = (a, b) => a - b;\n" },
          }
        : {
            text: json({ setup: [], test: ["node --test"], run: [], extension: { description: "sub()", files: ["src/sub.js", "test/sub.test.js"] }, gaps: [], ok: true }),
            files: {
              "src/sub.js": "export const sub = (a, b) => a - b;\n",
              "test/sub.test.js": "import test from 'node:test';\nimport assert from 'node:assert';\nimport { sub } from '../src/sub.js';\ntest('sub', () => assert.equal(sub(3, 1), 2));\n",
            },
          },
    ...overrides,
  };
}

function makeDeps(cwd: string, runner: ScriptedRunner, ui: ReturnType<typeof scriptedUi>["ui"], a: SetupAnswers): PipelineDeps {
  const roles = loadRoles();
  return { cwd, ui, runner, roles, team: buildTeam(registry, roles, a), answers: a, store: new FactoryStore(cwd), webAccess: false, gateTimeoutMs: 60_000 };
}

const gitIn = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

describe("integration, verification and release", () => {
  it("loops a QA bug back to the build, fixes the docs a new contributor got stuck on, tags and writes the retrospective", async () => {
    const cwd = tempDir("factory-m6-");
    const runner = new ScriptedRunner(scripts());
    const { ui, logs } = scriptedUi();
    const a = answers();
    const deps = makeDeps(cwd, runner, ui, a);
    const final = await new FactoryRun(deps, newState("A CLI calculator", "run-m6", a)).run();

    expect(final.lastError).toBeUndefined();
    expect(final.status).toBe("done");

    // Verification round 1 opened a bug ticket for the major finding only; round 2 was clean.
    expect(final.tickets.map((t) => [t.id, t.status, t.kind ?? "feature"])).toEqual([
      ["T-001", "done", "feature"],
      ["B-001", "done", "bug"],
    ]);
    const bug = final.tickets[1];
    expect(bug).toMatchObject({ title: "Fix: Numbers from the command line are concatenated", severity: "major", foundInRound: 1, role: "backend", writeScope: ["src/**", "test/**"], qa: "written" });
    const qaPrompts = runner.calls.filter((c) => c.role === "qa" && c.prompt.startsWith("Exploratory QA")).map((c) => c.prompt);
    expect(qaPrompts).toHaveLength(2);
    expect(qaPrompts[1]).toMatch(/Bugs fixed since the last round[\s\S]*B-001/);
    // Exploratory QA is read-only.
    expect(runner.calls.find((c) => c.prompt.startsWith("Exploratory QA"))!.writeScope).toEqual([]);
    expect(fs.readFileSync(path.join(cwd, ".factory/qa/round-1.md"), "utf8")).toMatch(/\*\*major\*\* Numbers from the command line are concatenated \(FR-001\) → B-001[\s\S]*\*\*minor\*\* No --help text \(below threshold: follow-up\)/);

    // QA's leftovers were undone before the fix round.
    expect(fs.existsSync(path.join(cwd, "scratch.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(cwd, "test/smoke.test.js"), "utf8")).toContain("node:test");
    // The fix is merged; the regression test came from QA-first on the bug ticket.
    expect(fs.readFileSync(path.join(cwd, "src/add.js"), "utf8")).toContain("Number(a)");
    expect(fs.existsSync(path.join(cwd, "test/regression.test.js"))).toBe(true);
    expect(gitIn(cwd, ["log", "--oneline"])).toMatch(/feat\(B-001\): Fix: Numbers/);

    // New-contributor check: round 1 failed on a blocking gap, the docs were fixed, round 2 passed.
    const contributorCalls = runner.calls.filter((c) => c.role === "contributor");
    expect(contributorCalls).toHaveLength(2);
    expect(contributorCalls[0].cwd).not.toBe(cwd);
    expect(contributorCalls[0].cwd.startsWith(cwd)).toBe(false);
    expect(fs.existsSync(contributorCalls[0].cwd)).toBe(false); // the clone is thrown away
    const contributorReport = fs.readFileSync(path.join(cwd, ".factory/contributor.md"), "utf8");
    expect(contributorReport).toMatch(/Round 1: FAILED[\s\S]*1 blocking documentation gap[\s\S]*Round 2: PASSED/);
    expect(fs.readFileSync(path.join(cwd, "README.md"), "utf8")).toContain("## Setup");
    expect(fs.existsSync(path.join(cwd, "src/sub.js"))).toBe(false); // the contributor's extension never ships
    expect(gitIn(cwd, ["log", "--oneline"])).toMatch(/docs: fix gaps found by the new-contributor check/);

    // Release: tag, notes, report and retrospective.
    expect(gitIn(cwd, ["tag"]).trim()).toBe("v0.1.0");
    const notes = fs.readFileSync(path.join(cwd, ".factory/release-notes.md"), "utf8");
    expect(notes).toMatch(/## Fixed during verification\n\n- Numbers from the command line are concatenated \(major\)/);
    expect(notes).toMatch(/Exploratory QA rounds: 2/);
    const report = fs.readFileSync(path.join(cwd, ".factory/report.md"), "utf8");
    expect(report).toMatch(/B-001 Fix: Numbers .* \[major, QA round 1\]/);
    expect(report).toMatch(/Exploratory QA: 2 round\(s\), 1 bug\(s\) fixed, 0 known issue\(s\)/);
    expect(report).toMatch(/New-contributor check: passed/);
    expect(report).toMatch(/Tag: v0\.1\.0/);
    expect(report).not.toMatch(/verify:\d/);
    const retro = fs.readFileSync(path.join(cwd, ".factory/retro.md"), "utf8");
    expect(retro).toMatch(/\| verify \|/);
    expect(retro).toContain("Fix (minor): No --help text");
    expect(logs.some((l) => l.kind === "qa")).toBe(true);
    expect(deps.store.readLedger().filter((e) => e.kind === "verify").map((e) => e.opened)).toEqual([["B-001"], []]);
  }, 180_000);

  it("after the last fix round, asks whether to release with known issues (balanced)", async () => {
    const cwd = tempDir("factory-m6-known-");
    // QA keeps finding the same major bug: the builder never fixes it.
    const stubborn: Script = (req) =>
      req.prompt.startsWith("Exploratory QA")
        ? { text: json({ summary: "still broken", checks: [], bugs: [{ title: "Slow on big input", severity: "major" }] }) }
        : { text: "Nothing to add." };
    const runner = new ScriptedRunner(scripts({ qa: stubborn, backend: () => ({ text: "Implemented.", files: { "src/add.js": "export const add = (a, b) => a + b;\n", "test/add.test.js": addTest } }) }));
    const { ui, selects } = scriptedUi({ select: (title, options) => (title.startsWith("Verification still finds") ? "Release with these as known issues" : options[0]) });
    const a = answers({ autonomy: "balanced", build: { qaRounds: 1, contributorCheck: false } });
    const final = await new FactoryRun(makeDeps(cwd, runner, ui, a), newState("A CLI calculator", "run-m6b", a)).run();

    expect(final.status).toBe("done");
    expect(final.tickets.map((t) => t.id)).toEqual(["T-001", "B-001"]); // one fix round only
    expect(selects.some((s) => s.title.startsWith("Verification still finds 1 bug(s) after 1 fix round(s)"))).toBe(true);
    expect(runner.count("contributor")).toBe(0);
    const notes = fs.readFileSync(path.join(cwd, ".factory/release-notes.md"), "utf8");
    expect(notes).toMatch(/## Known issues\n\n- major: Slow on big input/);
    expect(fs.readFileSync(path.join(cwd, ".factory/retro.md"), "utf8")).toContain("Fix (major): Slow on big input");
    expect(final.notes).toContain("released with 1 known bug(s) after 1 fix round(s)");
  }, 180_000);

  it("never fails the run when QA or the contributor return no usable report", async () => {
    const cwd = tempDir("factory-m6-quiet-");
    const runner = new ScriptedRunner(scripts({ qa: () => ({ text: "ok" }), contributor: () => ({ text: "I could not do it." }) }));
    const { ui } = scriptedUi();
    const a = answers({ build: { tagRelease: false } });
    const final = await new FactoryRun(makeDeps(cwd, runner, ui, a), newState("A CLI calculator", "run-m6c", a)).run();
    expect(final.status).toBe("done");
    expect(final.notes).toContain("exploratory QA round 1 returned no usable report");
    expect(fs.readFileSync(path.join(cwd, ".factory/contributor.md"), "utf8")).toMatch(/Round 1: FAILED[\s\S]*no usable report/);
    expect(runner.count("contributor")).toBe(3); // one round, three JSON attempts, no docs loop without a report
    expect(gitIn(cwd, ["tag"]).trim()).toBe("");
  }, 180_000);
});
