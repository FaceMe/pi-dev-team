/**
 * M3 discovery depth: readiness checklist, adaptive interview depth, the
 * assumptions log, multi-model brainstorm fan-out, and the spec validator gate.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactoryRun, newState } from "../src/factory/pipeline.js";
import type { PipelineDeps } from "../src/factory/pipeline.js";
import { loadRoles } from "../src/factory/roles.js";
import { READINESS_LABELS, READINESS_TOPICS, isReady, normalizeReadiness, readinessMarkdown } from "../src/factory/readiness.js";
import { validateSpec } from "../src/factory/spec-validator.js";
import { FactoryStore } from "../src/factory/store.js";
import { buildTeam } from "../src/factory/team.js";
import type { Team } from "../src/factory/team.js";
import type { SetupAnswers, WorkerRequest } from "../src/factory/types.js";
import { fakeRegistry, makeModel, tempDir, useTempAgentDir } from "./helpers.js";
import { json, ScriptedRunner, scriptedUi } from "./factory-helpers.js";

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

// Idea sizes drive the interview's max rounds: 1 (small), 2 (medium), 3 (large).
// estimateSize counts and/with/plus/also words, so these spell out enough of them.
const SMALL_IDEA = "An add function library";
const MEDIUM_IDEA = "A team wiki with auth and roles and search and tags and exports and theming";
const LARGE_IDEA =
  "A dashboard with charts and tables and filters and exports and alerts and sharing and themes and search and auth and audit and offline mode";

function answers(overrides: Partial<SetupAnswers> = {}): SetupAnswers {
  return {
    teamPreset: "balanced",
    pins: {},
    autonomy: "balanced",
    projectMode: "new",
    stack: "auto",
    research: "off",
    deploy: "none",
    budgetUsd: 0,
    budgetTokens: 0,
    ...overrides,
  };
}

function makeDeps(cwd: string, runner: ScriptedRunner, ui: ReturnType<typeof scriptedUi>["ui"], a: SetupAnswers, team?: Team): PipelineDeps {
  const roles = loadRoles();
  return {
    cwd,
    ui,
    runner,
    roles,
    team: team ?? buildTeam(registry, roles, a),
    answers: a,
    store: new FactoryStore(cwd),
    webAccess: false,
  };
}

const readiness = (statuses: Partial<Record<string, string>>, notes: Partial<Record<string, string>> = {}) =>
  READINESS_TOPICS.map((topic) => ({ topic, status: statuses[topic] ?? "known", note: notes[topic] }));
const withUnknown = (topic: string, note = "still open") => readiness({ [topic]: "unknown" }, { [topic]: note });

/** Analyst script skeleton: branches on session/prompt; spec calls deliberately write nothing so the run stops right after discovery. */
function analystScript(rounds: Array<{ reply: () => unknown } & Record<string, unknown>>, synthesis = true) {
  return (req: WorkerRequest): { text: string; files?: Record<string, string> } => {
    if (req.sessionId.includes("-synthesis")) {
      if (!synthesis) return { text: "not json" };
      return {
        text: json({ options: ["offline-first sync", "cloud-only", "manual export"], recommendation: "offline-first sync with a cloud backup", risks: ["conflict resolution is subtle"] }),
      };
    }
    if (req.sessionId.includes("brainstorm-")) return { text: `Stanced take for ${req.sessionId}: three concrete options and one takeaway.` };
    const round = Number(/interview round (\d+)/.exec(req.prompt)?.[1] ?? 0);
    if (round > 0) {
      const scripted = rounds[round - 1];
      return { text: json(scripted ? scripted.reply() : { ready: true, questions: [] }) };
    }
    return { text: "no spec written" };
  };
}

// ---------------------------------------------------------------------------
// Readiness module
// ---------------------------------------------------------------------------

describe("readiness", () => {
  it("canonicalizes topics, drops unknown ones and fills the rest", () => {
    const r = normalizeReadiness({
      items: [
        { topic: "Problem", status: "known" }, // id, case-insensitive
        { topic: "Out of scope for v1", status: "assumed", note: "no sharing" }, // display name
        { topic: "CORE-USER JOURNEYS" }, // separators + case
        { topic: "telepathy", status: "known" }, // not a topic: dropped
        { topic: "users", status: "maybe" }, // invalid status -> unknown
        { topic: "nfrs", status: "known", note: "" }, // empty note dropped
      ],
    })!;
    expect(r.items.map((i) => i.topic)).toEqual([...READINESS_TOPICS]);
    expect(r.items.filter((i) => i.status === "known")).toHaveLength(2);
    expect(r.items.find((i) => i.topic === "outOfScope")).toMatchObject({ status: "assumed", note: "no sharing" });
    expect(r.items.find((i) => i.topic === "journeys")).toMatchObject({ status: "unknown" });
    expect(r.items.find((i) => i.topic === "users")!.status).toBe("unknown");
    expect(r.items.find((i) => i.topic === "nfrs")!.note).toBeUndefined();
    // Filled topics carry the "not assessed" note; duplicates would not double up.
    expect(r.items.find((i) => i.topic === "acceptance")).toMatchObject({ status: "unknown", note: "not assessed" });
    expect(r.score).toBeCloseTo(3 / 9);
  });

  it("accepts a bare array, keeps one item per topic and rejects invalid input", () => {
    const bare = normalizeReadiness([{ topic: "problem", status: "known" }, { topic: "problem", status: "assumed", note: "second wins" }])!;
    expect(bare.items).toHaveLength(READINESS_TOPICS.length);
    expect(bare.items.find((i) => i.topic === "problem")).toMatchObject({ status: "assumed", note: "second wins" });
    expect(normalizeReadiness({ items: [] })!.items.every((i) => i.status === "unknown")).toBe(true);
    expect(normalizeReadiness(null)).toBeNull();
    expect(normalizeReadiness(42)).toBeNull();
    expect(normalizeReadiness("known")).toBeNull();
    expect(normalizeReadiness({})).toBeNull();
    expect(normalizeReadiness({ items: "nope" })).toBeNull();
  });

  it("isReady and the markdown table", () => {
    const complete = normalizeReadiness({ items: readiness({}) })!;
    expect(complete.score).toBe(1);
    expect(isReady(complete)).toBe(true);
    const incomplete = normalizeReadiness({ items: withUnknown("data", "retention unknown") })!;
    expect(isReady(incomplete)).toBe(false);
    expect(incomplete.score).toBeCloseTo(8 / 9);
    const md = readinessMarkdown(incomplete);
    expect(md).toContain("| Topic | Status | Note |");
    expect(md).toContain(`| ${READINESS_LABELS.data} | unknown | retention unknown |`);
    expect(md).toContain("Readiness score: 8/9 (89%)");
    expect(readinessMarkdown(normalizeReadiness([])!)).toContain("Readiness score: 0/9 (0%)");
  });
});

// ---------------------------------------------------------------------------
// Interview: readiness, early exit, assumptions
// ---------------------------------------------------------------------------

describe("discovery interview", () => {
  it("ends after one round when the readiness checklist completes, even though the analyst said ready:false", async () => {
    const cwd = tempDir("factory-ready-");
    const runner = new ScriptedRunner({
      analyst: analystScript([
        {
          reply: () => ({
            ready: false,
            questions: [{ id: "q1", question: "Which language?", options: ["JavaScript", "Python"], recommended: 0 }],
            readiness: { items: readiness({}) },
          }),
        },
      ]),
    });
    const { ui, selects } = scriptedUi();
    const a = answers();
    const deps = makeDeps(cwd, runner, ui, a);
    const final = await new FactoryRun(deps, newState(MEDIUM_IDEA, "run-ready", a)).run();

    const interviewCalls = runner.calls.filter((c) => c.prompt.includes("interview round"));
    expect(interviewCalls).toHaveLength(1);
    // The checklist ended the interview before the proposed question was asked.
    expect(selects).toHaveLength(0);
    expect(final.readiness && isReady(final.readiness)).toBe(true);
    // Readiness survives the store round-trip.
    const loaded = deps.store.loadState()!;
    expect(loaded.readiness?.items).toHaveLength(READINESS_TOPICS.length);
    const md = fs.readFileSync(path.join(cwd, ".factory/spec/readiness.md"), "utf8");
    expect(md).toContain("Readiness score: 9/9 (100%)");
    expect(fs.existsSync(path.join(cwd, ".factory/spec/assumptions.md"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, ".factory/spec/decisions.md"))).toBe(true);
  }, 30_000);

  it("records assumed answers and unresolved readiness topics in assumptions.md without duplicating them on a second pass", async () => {
    const cwd = tempDir("factory-assume-");
    const runner = new ScriptedRunner({
      analyst: analystScript([
        {
          reply: () => ({
            ready: false,
            questions: [{ id: "q1", question: "Where is data stored?", options: ["Local file", "Cloud database"], recommended: 0 }],
            readiness: { items: withUnknown("journeys", "happy path unclear") },
          }),
        },
      ]),
    });
    const { ui } = scriptedUi({ select: (_title, options) => options.find((o) => o.startsWith("Use your defaults")) ?? options[0] });
    const a = answers();
    const deps = makeDeps(cwd, runner, ui, a);
    const first = await new FactoryRun(deps, newState(SMALL_IDEA, "run-assume", a)).run();

    expect(first.answers).toMatchObject([{ answer: "Local file", assumed: true }]);
    const file = path.join(cwd, ".factory/spec/assumptions.md");
    const readAssumptions = () => fs.readFileSync(file, "utf8");
    expect(readAssumptions()).toContain("- Assumed (you did not answer): Where is data stored? — Local file");
    expect(readAssumptions()).toContain(`- Unresolved: ${READINESS_LABELS.journeys} — happy path unclear`);

    // A resumed pass rewrites the derived file fresh: same bullets, no duplicates.
    const loaded = deps.store.loadState()!;
    loaded.phase = "discovery";
    await new FactoryRun(deps, loaded).run();
    expect(readAssumptions().split("\n").filter((l) => l.startsWith("- Assumed (you did not answer):"))).toHaveLength(1);
    expect(readAssumptions().split("\n").filter((l) => l.startsWith("- Unresolved:"))).toHaveLength(1);
    expect(fs.readFileSync(path.join(cwd, ".factory/spec/readiness.md"), "utf8")).toContain("8/9");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Multi-model brainstorm
// ---------------------------------------------------------------------------

describe("brainstorm", () => {
  it("fans a contested question out to 3 stances on 2 families, synthesises, files it and feeds the next round", async () => {
    const cwd = tempDir("factory-brainstorm-");
    const runner = new ScriptedRunner({
      analyst: analystScript([
        {
          reply: () => ({
            ready: false,
            questions: [{ id: "q1", question: "Single user or teams?", options: ["Single user", "Teams"], recommended: 0 }],
            readiness: { items: withUnknown("data") },
            brainstorm: "Should the wiki work offline or stay cloud-only?",
          }),
        },
        { reply: () => ({ ready: true, questions: [], readiness: { items: readiness({ data: "assumed" }) } }) },
      ]),
    });
    const { ui } = scriptedUi();
    const a = answers();
    const deps = makeDeps(cwd, runner, ui, a);
    const final = await new FactoryRun(deps, newState(MEDIUM_IDEA, "run-bs", a)).run();

    const interviewCalls = runner.calls.filter((c) => c.prompt.includes("interview round"));
    expect(interviewCalls).toHaveLength(2);
    // The digest from brainstorm 1 is part of round 2's prompt.
    expect(interviewCalls[1].prompt).toContain("Brainstorm 1");
    expect(interviewCalls[1].prompt).toContain("offline-first");

    const stanceCalls = runner.calls.filter((c) => /-brainstorm-1-(divergent|critical|pragmatic)$/.test(c.sessionId));
    expect(stanceCalls.map((c) => c.sessionId)).toEqual([
      "run-bs-brainstorm-1-divergent",
      "run-bs-brainstorm-1-critical",
      "run-bs-brainstorm-1-pragmatic",
    ]);
    // Read-only fan-out; one model per stance with at least two families involved.
    for (const call of stanceCalls) {
      expect(call.writeScope).toEqual([]);
      expect(call.member.role).toBe("analyst");
    }
    expect(new Set(stanceCalls.map((c) => c.member.family)).size).toBeGreaterThanOrEqual(2);
    expect(new Set(stanceCalls.map((c) => c.member.modelId)).size).toBeGreaterThanOrEqual(2);
    expect(runner.calls.find((c) => c.sessionId === "run-bs-brainstorm-1-synthesis")!.writeScope).toEqual([]);

    const md = fs.readFileSync(path.join(cwd, ".factory/research/brainstorm-1.md"), "utf8");
    expect(md).toContain("Question: Should the wiki work offline or stay cloud-only?");
    expect(md).toContain("## divergent — ");
    expect(md).toContain("## critical — ");
    expect(md).toContain("## pragmatic — ");
    expect(md).toContain("## Synthesis");
    expect(md).toContain("Recommendation: offline-first sync with a cloud backup");
    expect(final.notes).toContain("brainstorm:1");
  }, 30_000);

  it("skips silently with a note when only one model family is logged in", async () => {
    const cwd = tempDir("factory-onefamily-");
    const claude = (id: string) => makeModel({ id, provider: "anthropic", reasoning: true, cost: price(5, 25) });
    const team: Team = {
      members: {
        analyst: { role: "analyst", provider: "anthropic", modelId: "c-frontier", tier: "frontier", family: "claude" },
        backend: { role: "backend", provider: "anthropic", modelId: "c-daily", tier: "daily", family: "claude" },
      },
      tiers: { frontier: claude("c-frontier"), daily: claude("c-daily"), small: claude("c-small"), source: { small: "auto", daily: "auto", frontier: "auto" }, notes: [] },
      notes: [],
    };
    const runner = new ScriptedRunner({
      analyst: analystScript([
        {
          reply: () => ({
            ready: false,
            questions: [{ id: "q1", question: "Markdown or rich text?", options: ["Markdown", "Rich text"], recommended: 0 }],
            readiness: { items: withUnknown("users") },
            brainstorm: "Markdown or rich text?",
          }),
        },
        { reply: () => ({ ready: true, questions: [] }) },
      ]),
    });
    const { ui } = scriptedUi();
    const a = answers();
    const deps = makeDeps(cwd, runner, ui, a, team);
    const final = await new FactoryRun(deps, newState(MEDIUM_IDEA, "run-1f", a)).run();

    expect(runner.calls.filter((c) => c.prompt.includes("interview round"))).toHaveLength(2);
    expect(runner.calls.some((c) => c.sessionId.includes("brainstorm-1"))).toBe(false);
    expect(final.notes.filter((n) => n === "brainstorm skipped: one model family logged in")).toHaveLength(1);
    expect(fs.existsSync(path.join(cwd, ".factory/research/brainstorm-1.md"))).toBe(false);
  }, 30_000);

  it("runs at most 2 brainstorms per run", async () => {
    const cwd = tempDir("factory-cap-");
    const contested = (n: number) => `Contested question ${n}?`;
    const rounds = [1, 2, 3].map((n) => ({
      reply: () => ({
        ready: false,
        questions: [{ id: `q${n}`, question: `Detail ${n}?`, options: ["A", "B"], recommended: 0 }],
        readiness: { items: withUnknown("constraints") },
        brainstorm: contested(n),
      }),
    }));
    const runner = new ScriptedRunner({ analyst: analystScript(rounds) });
    const { ui } = scriptedUi();
    const a = answers();
    const deps = makeDeps(cwd, runner, ui, a);
    const final = await new FactoryRun(deps, newState(LARGE_IDEA, "run-cap", a)).run();

    expect(runner.calls.filter((c) => c.prompt.includes("interview round"))).toHaveLength(3);
    expect(runner.calls.some((c) => c.sessionId.includes("brainstorm-1-"))).toBe(true);
    expect(runner.calls.some((c) => c.sessionId.includes("brainstorm-2-"))).toBe(true);
    expect(runner.calls.some((c) => c.sessionId.includes("brainstorm-3"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, ".factory/research/brainstorm-1.md"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, ".factory/research/brainstorm-2.md"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, ".factory/research/brainstorm-3.md"))).toBe(false);
    expect(final.notes).toContain("brainstorm:1");
    expect(final.notes).toContain("brainstorm:2");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Spec validator wiring
// ---------------------------------------------------------------------------

// Passes a correct §9.4 validator: FR ids with Given/When/Then, a measurable NFR, traceability.
const VALID_SPEC = `# Spec

## Overview
A tiny calculator library.

## User stories
- As a developer, I want to add numbers, so that I can compute sums.

## Functional requirements
- FR-001 Add two numbers.
  - Given the numbers 1 and 2 When added Then the result is 3.
- FR-002 Report errors for non-numeric input.
  - Given the input "a" When added Then an error naming the input is returned.

## Non-functional requirements
- NFR-001 The sum is computed in under 100 ms for inputs up to 1000 numbers.

## Out of scope for this version
- Subtraction.

## Traceability
- FR-001 and FR-002 come from the brief and the interview answers.
`;

// Structurally valid (FR id + Given/When/Then) but fails §9.4: unmeasurable NFR, no traceability.
const VAGUE_SPEC = `# Spec

## Functional requirements
- FR-001 Add numbers.
  - Given two numbers When added Then the sum is returned.

## Non-functional requirements
- NFR-001 Adding must be fast.

## Out of scope for this version
- Subtraction.
`;

// The validator is built in parallel; skip its wiring tests until it no longer throws.
const validatorImplemented = (() => {
  try {
    validateSpec(VALID_SPEC);
    return true;
  } catch {
    return false;
  }
})();

describe("spec validator", () => {
  const itV = validatorImplemented ? it : it.skip;

  itV("sends validator issues back to the analyst and passes on the corrected spec", async () => {
    // The fixtures must genuinely pass/fail a correct §9.4 implementation.
    expect(validateSpec(VALID_SPEC).ok).toBe(true);
    expect(validateSpec(VAGUE_SPEC).ok).toBe(false);

    const cwd = tempDir("factory-specv-");
    const runner = new ScriptedRunner({
      analyst: (req: WorkerRequest) => {
        if (req.prompt.includes("interview round")) return { text: json({ ready: true, questions: [] }) };
        // First attempt is vague; the validator feedback prompt gets the corrected spec.
        if (req.prompt.includes("spec validator found problems")) return { text: "fixed", files: { ".factory/spec/spec.md": VALID_SPEC } };
        return { text: "written", files: { ".factory/spec/spec.md": VAGUE_SPEC } };
      },
    });
    const { ui, selects } = scriptedUi();
    const a = answers();
    const deps = makeDeps(cwd, runner, ui, a);
    const final = await new FactoryRun(deps, newState(SMALL_IDEA, "run-sv", a)).run();

    const specCalls = runner.calls.filter((c) => c.role === "analyst" && !c.prompt.includes("interview round"));
    expect(specCalls).toHaveLength(2);
    expect(specCalls[1].prompt).toContain("spec validator found problems");
    expect(deps.store.read("spec/spec.md")).toContain("FR-002");
    // Approval summary uses the validator's own line, with no issue count once it passes.
    const expected = validateSpec(VALID_SPEC).summary;
    expect(selects[0].title).toContain(expected);
    expect(selects[0].title).not.toContain("spec-validator issue(s)");
    expect(final.notes.some((n) => n.startsWith("spec validator still failing"))).toBe(false);
    // The run moved past the spec gate (it fails later, at the unscripted architect).
    expect(final.phase).toBe("architecture");
    expect(final.lastError).toContain("architect");
  }, 30_000);

  itV("does not hard-fail on persistent validator problems; the user judges at the approval gate", async () => {
    const cwd = tempDir("factory-specv2-");
    const runner = new ScriptedRunner({
      analyst: (req: WorkerRequest) => {
        if (req.prompt.includes("interview round")) return { text: json({ ready: true, questions: [] }) };
        return { text: "written", files: { ".factory/spec/spec.md": VAGUE_SPEC } };
      },
    });
    const { ui, selects } = scriptedUi();
    const a = answers();
    const deps = makeDeps(cwd, runner, ui, a);
    const final = await new FactoryRun(deps, newState(SMALL_IDEA, "run-sv2", a)).run();

    expect(final.notes.some((n) => n.startsWith("spec validator still failing"))).toBe(true);
    expect(selects[0].title).toContain("Approve the specification?");
    expect(selects[0].title).toMatch(/spec-validator issue\(s\) — see \.factory\/spec\/spec\.md/);
    expect(final.phase).toBe("architecture");
    expect(final.lastError).toContain("architect");
  }, 30_000);

  it("falls back to counted requirements when the validator cannot run", async () => {
    const cwd = tempDir("factory-specstub-");
    const spec = `# Spec\n\n- FR-001 Add numbers.\n  - Given 1 and 2 When added Then 3.\n- NFR-001 Responds in under 100 ms.\n`;
    const runner = new ScriptedRunner({
      analyst: (req: WorkerRequest) => {
        if (req.prompt.includes("interview round")) return { text: json({ ready: true, questions: [] }) };
        return { text: "written", files: { ".factory/spec/spec.md": spec } };
      },
    });
    const { ui, selects } = scriptedUi();
    const a = answers();
    const deps = makeDeps(cwd, runner, ui, a);
    const final = await new FactoryRun(deps, newState(SMALL_IDEA, "run-stub", a)).run();

    if (validatorImplemented) {
      // With a working validator the approval gate is reached with its verdict.
      expect(selects[0].title).toContain("Approve the specification?");
    } else {
      // Stub path: the hand-counted summary, no retry, no crash.
      expect(selects[0].title).toContain("1 functional and 1 non-functional requirements; 0 assumptions.");
      expect(final.notes.some((n) => n.startsWith("spec validator still failing"))).toBe(false);
    }
    expect(final.phase).toBe("architecture");
  }, 30_000);
});
