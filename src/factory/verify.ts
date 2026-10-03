/**
 * Integration, verification, release and retrospective (plan §8 phases 7–9, M6).
 *
 * Pure helpers the pipeline uses after the build loop:
 *   - the exploratory QA report a QA worker writes after trying the integrated
 *     build like a user, and the bug tickets it turns into;
 *   - the "new contributor" report from a fresh agent that sets up, tests and
 *     extends a clean clone using only the docs;
 *   - release notes, the version to tag, and the retrospective.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { truncate } from "../shared/text.js";
import { formatCost, formatTokens } from "../shared/usage.js";
import { buildCostReport } from "./cost.js";
import type { LedgerEntry } from "./cost.js";
import { BUG_SEVERITIES } from "./types.js";
import type { BugSeverity, FactoryState, Ticket } from "./types.js";

// ---------------------------------------------------------------------------
// Exploratory QA
// ---------------------------------------------------------------------------

export interface QaCheck {
  requirement: string;
  result: "pass" | "fail" | "untested";
  evidence?: string;
}

export interface QaBug {
  title: string;
  severity: BugSeverity;
  requirement?: string;
  steps: string[];
  expected: string;
  actual: string;
  evidence?: string;
}

export interface QaReport {
  summary: string;
  checks: QaCheck[];
  bugs: QaBug[];
}

const text = (v: unknown, max = 2000): string => (typeof v === "string" ? truncate(v.trim(), max) : "");

/** Validate a QA worker's JSON reply. Unknown severities count as "major". */
export function normalizeQaReport(raw: any): { value?: QaReport; error?: string } {
  if (!raw || typeof raw !== "object") return { error: "expected a JSON object with summary, checks and bugs" };
  if (!Array.isArray(raw.bugs)) return { error: '"bugs" must be an array (use [] when you found none)' };
  const checks: QaCheck[] = (Array.isArray(raw.checks) ? raw.checks : [])
    .filter((c: any) => c && typeof c.requirement === "string")
    .map((c: any) => ({
      requirement: c.requirement.trim(),
      result: ["pass", "fail", "untested"].includes(c.result) ? c.result : "untested",
      evidence: text(c.evidence, 400) || undefined,
    }));
  const bugs: QaBug[] = [];
  for (const b of raw.bugs) {
    if (!b || typeof b.title !== "string" || !b.title.trim()) return { error: "every bug needs a title" };
    bugs.push({
      title: truncate(b.title.trim(), 120),
      severity: BUG_SEVERITIES.includes(b.severity) ? b.severity : "major",
      requirement: typeof b.requirement === "string" && b.requirement.trim() ? b.requirement.trim() : undefined,
      steps: (Array.isArray(b.steps) ? b.steps : typeof b.steps === "string" ? [b.steps] : []).map((s: unknown) => text(s, 300)).filter(Boolean),
      expected: text(b.expected, 400),
      actual: text(b.actual, 400),
      evidence: text(b.evidence, 800) || undefined,
    });
  }
  return { value: { summary: text(raw.summary, 1000), checks, bugs } };
}

const SEVERITY_RANK: Record<BugSeverity, number> = { critical: 0, major: 1, minor: 2 };

/** True when `severity` is at least as serious as `threshold`. */
export function atLeast(severity: BugSeverity, threshold: BugSeverity): boolean {
  return SEVERITY_RANK[severity] <= SEVERITY_RANK[threshold];
}

/** Comparable title: "Fix: X" (a bug ticket) and "X" (a QA finding) are the same bug. */
const normalizeTitle = (t: string) => t.replace(/^fix:\s*/i, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Next free "B-00n" id. */
export function nextBugId(tickets: Ticket[]): string {
  const max = tickets.reduce((m, t) => {
    const match = /^B-(\d+)$/.exec(t.id);
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
  return `B-${String(max + 1).padStart(3, "0")}`;
}

function bugBrief(bug: QaBug): string {
  const steps = bug.steps.length ? bug.steps.map((s, i) => `${i + 1}. ${s}`).join("\n") : "(no steps recorded)";
  return [
    `Bug found by exploratory QA on the integrated build${bug.requirement ? ` (${bug.requirement})` : ""}: ${bug.title}`,
    "",
    "Steps to reproduce:",
    steps,
    "",
    `Expected: ${bug.expected || "(see the requirement)"}`,
    `Actual: ${bug.actual || "(see evidence)"}`,
    ...(bug.evidence ? ["", "Evidence:", bug.evidence] : []),
    "",
    "Fix the root cause (not the symptom) and add a regression test that reproduces these steps.",
  ].join("\n");
}

/**
 * Bug tickets for the findings at or above `threshold`. Each inherits the role
 * and write scope of the tickets that delivered its requirement, so the
 * scheduler keeps it away from unrelated work. A finding whose title matches a
 * bug ticket still waiting to be built is skipped.
 */
export function bugTickets(report: QaReport, tickets: Ticket[], threshold: BugSeverity, round: number): Ticket[] {
  const open = new Set(tickets.filter((t) => t.kind === "bug" && t.status !== "done").map((t) => normalizeTitle(t.title)));
  const all = [...tickets];
  const created: Ticket[] = [];
  for (const bug of report.bugs) {
    if (!atLeast(bug.severity, threshold) || open.has(normalizeTitle(bug.title))) continue;
    const owners = bug.requirement ? tickets.filter((t) => t.kind !== "bug" && t.requirements.includes(bug.requirement!)) : [];
    const source = owners.length ? owners : tickets.filter((t) => t.kind !== "bug" && ["backend", "frontend"].includes(t.role));
    const scope = [...new Set(source.flatMap((t) => t.writeScope))];
    const ticket: Ticket = {
      id: nextBugId(all),
      title: `Fix: ${bug.title}`,
      role: owners[0]?.role ?? source[0]?.role ?? "backend",
      dependsOn: [],
      requirements: bug.requirement ? [bug.requirement] : [],
      brief: bugBrief(bug),
      acceptance: [
        `Given the reproduction steps When they are repeated Then ${bug.expected || "the behaviour matches the requirement"}`,
        "A regression test reproduces the bug, failed before the fix and passes after it",
      ],
      writeScope: scope.length ? scope : ["**"],
      status: "todo",
      attempts: [],
      kind: "bug",
      severity: bug.severity,
      foundInRound: round,
    };
    all.push(ticket);
    created.push(ticket);
    open.add(normalizeTitle(bug.title));
  }
  return created;
}

/** A bug ticket for an integration build whose gates fail. */
export function integrationBugTicket(failure: string, tickets: Ticket[], round: number): Ticket {
  return {
    id: nextBugId(tickets),
    title: "Fix: the integrated build fails its gates",
    role: "backend",
    dependsOn: [],
    requirements: [],
    brief: `The gates fail on the integration branch after all tickets merged.\n\n${failure}\n\nFix the cause so every gate passes; do not weaken or skip tests.`,
    acceptance: ["Every profile gate passes on the integrated build"],
    writeScope: ["**"],
    status: "todo",
    attempts: [],
    kind: "bug",
    severity: "critical",
    foundInRound: round,
  };
}

export function qaReportMarkdown(report: QaReport, round: number, threshold: BugSeverity, created: Ticket[]): string {
  const mark = { pass: "✓", fail: "✗", untested: "?" } as const;
  const lines = [`# Exploratory QA — round ${round}`, "", report.summary || "(no summary)", ""];
  if (report.checks.length) {
    lines.push("## Requirements tried", "", ...report.checks.map((c) => `- ${mark[c.result]} ${c.requirement}${c.evidence ? ` — ${c.evidence}` : ""}`), "");
  }
  lines.push(`## Bugs (${report.bugs.length})`, "");
  if (report.bugs.length === 0) lines.push("None found.");
  for (const bug of report.bugs) {
    const ticket = created.find((t) => t.title === `Fix: ${bug.title}`);
    const fate = ticket ? `→ ${ticket.id}` : atLeast(bug.severity, threshold) ? "(already open)" : "(below threshold: follow-up)";
    lines.push(`- **${bug.severity}** ${bug.title}${bug.requirement ? ` (${bug.requirement})` : ""} ${fate}`);
    if (bug.steps.length) lines.push(`  - steps: ${bug.steps.join(" → ")}`);
    if (bug.expected || bug.actual) lines.push(`  - expected: ${bug.expected || "?"}; actual: ${bug.actual || "?"}`);
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// New-contributor check
// ---------------------------------------------------------------------------

export interface ContributorGap {
  doc: string;
  problem: string;
  blocking: boolean;
}

export interface ContributorReport {
  setup: string[];
  test: string[];
  run: string[];
  extension: { description: string; files: string[] };
  gaps: ContributorGap[];
  /** The contributor's own verdict. */
  ok: boolean;
}

const commands = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).filter((c): c is string => typeof c === "string" && c.trim() !== "").map((c) => c.trim()).slice(0, 5);

export function normalizeContributorReport(raw: any): { value?: ContributorReport; error?: string } {
  if (!raw || typeof raw !== "object") return { error: "expected a JSON object" };
  const test = commands(raw.test);
  if (test.length === 0) return { error: '"test" must list the test command(s) you found in the docs' };
  const ext = raw.extension && typeof raw.extension === "object" ? raw.extension : {};
  return {
    value: {
      setup: commands(raw.setup),
      test,
      run: commands(raw.run),
      extension: { description: text(ext.description, 400), files: commands(ext.files) },
      gaps: (Array.isArray(raw.gaps) ? raw.gaps : [])
        .filter((g: any) => g && typeof g.problem === "string" && g.problem.trim())
        .map((g: any) => ({ doc: text(g.doc, 80) || "docs", problem: text(g.problem, 400), blocking: g.blocking === true || g.severity === "blocking" })),
      ok: raw.ok !== false,
    },
  };
}

export interface ContributorOutcome {
  round: number;
  report?: ContributorReport;
  /** Test commands from the docs, re-run by the harness in the clone. */
  docCommands: Array<{ command: string; ok: boolean; output: string }>;
  gatesOk: boolean;
  gatesSummary: string;
  changedFiles: string[];
  passed: boolean;
  reasons: string[];
}

/** Decide the check from evidence, not the agent's verdict alone. */
export function judgeContributor(outcome: Omit<ContributorOutcome, "passed" | "reasons">): ContributorOutcome {
  const reasons: string[] = [];
  if (!outcome.report) reasons.push("the contributor returned no usable report");
  else {
    if (!outcome.report.ok) reasons.push("the contributor could not finish from the docs alone");
    const blocking = outcome.report.gaps.filter((g) => g.blocking);
    if (blocking.length) reasons.push(`${blocking.length} blocking documentation gap(s)`);
  }
  const failed = outcome.docCommands.filter((c) => !c.ok);
  if (failed.length) reasons.push(`documented test command failed: ${failed.map((c) => `\`${c.command}\``).join(", ")}`);
  if (!outcome.gatesOk) reasons.push(`gates fail after the contributor's change (${outcome.gatesSummary})`);
  if (outcome.changedFiles.length === 0) reasons.push("no extension was made");
  return { ...outcome, passed: reasons.length === 0, reasons };
}

export function contributorMarkdown(outcomes: ContributorOutcome[]): string {
  const lines = ["# New-contributor check", "", "A fresh agent cloned the build and used only its docs to set it up, test it and extend it.", ""];
  for (const o of outcomes) {
    lines.push(`## Round ${o.round}: ${o.passed ? "PASSED" : "FAILED"}`, "");
    if (o.reasons.length) lines.push(...o.reasons.map((r) => `- ${r}`), "");
    if (o.report) {
      const list = (label: string, items: string[]) => lines.push(`- ${label}: ${items.length ? items.map((c) => `\`${c}\``).join(", ") : "(none)"}`);
      list("setup", o.report.setup);
      list("test", o.report.test);
      list("run", o.report.run);
      lines.push(`- extension: ${o.report.extension.description || "(not described)"}${o.changedFiles.length ? ` — ${o.changedFiles.slice(0, 8).join(", ")}` : ""}`);
      if (o.report.gaps.length) lines.push("", "Gaps:", ...o.report.gaps.map((g) => `- ${g.blocking ? "**blocking**" : "minor"} ${g.doc}: ${g.problem}`));
    }
    for (const c of o.docCommands) lines.push(`- harness re-ran \`${c.command}\`: ${c.ok ? "ok" : "FAILED"}`);
    lines.push(`- gates after the extension: ${o.gatesSummary}`, "");
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

/** The project's version from its manifest, or 0.1.0 for a first release. */
export function projectVersion(dir: string): string {
  const read = (name: string) => {
    try {
      return fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      return undefined;
    }
  };
  const pkg = read("package.json");
  if (pkg) {
    try {
      const v = JSON.parse(pkg).version;
      if (typeof v === "string" && /^\d+\.\d+\.\d+/.test(v)) return v;
    } catch {
      /* not JSON */
    }
  }
  for (const name of ["pyproject.toml", "Cargo.toml"]) {
    const match = read(name)?.match(/^\s*version\s*=\s*"(\d+\.\d+\.\d+[^"]*)"/m);
    if (match) return match[1];
  }
  return "0.1.0";
}

export function releaseNotes(args: {
  state: FactoryState;
  version: string;
  gatesSummary: string;
  qaRounds: number;
  openBugs: QaBug[];
  contributor?: ContributorOutcome;
}): string {
  const { state } = args;
  const features = state.tickets.filter((t) => t.kind !== "bug" && t.status === "done");
  const fixes = state.tickets.filter((t) => t.kind === "bug" && t.status === "done");
  const notDone = state.tickets.filter((t) => t.status !== "done");
  const lines = [`# Release ${args.version}`, "", truncate(state.idea, 300), "", "## Delivered", ""];
  lines.push(...(features.length ? features.map((t) => `- ${t.title}${t.requirements.length ? ` (${t.requirements.join(", ")})` : ""}`) : ["- (nothing)"]));
  if (fixes.length) lines.push("", "## Fixed during verification", "", ...fixes.map((t) => `- ${t.title.replace(/^Fix: /, "")} (${t.severity ?? "bug"})`));
  if (notDone.length || args.openBugs.length) {
    lines.push("", "## Known issues", "");
    lines.push(...notDone.map((t) => `- ${t.id} ${t.title} — ${t.status}`));
    lines.push(...args.openBugs.map((b) => `- ${b.severity}: ${b.title}`));
  }
  lines.push(
    "",
    "## Verification",
    "",
    `- Gates: ${args.gatesSummary}`,
    `- Exploratory QA rounds: ${args.qaRounds}`,
    `- New-contributor check: ${args.contributor ? (args.contributor.passed ? "passed" : `failed — ${args.contributor.reasons.join("; ")}`) : "not run"}`,
  );
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Retrospective (plan §8 phase 9)
// ---------------------------------------------------------------------------

export function retrospective(args: {
  state: FactoryState;
  ledger: LedgerEntry[];
  merged: boolean;
  gatesOk: boolean;
  qaRounds: number;
  openBugs: QaBug[];
  minorBugs: QaBug[];
  untested: string[];
  contributor?: ContributorOutcome;
}): string {
  const { state } = args;
  const cost = buildCostReport(args.ledger, { runId: state.runId });
  const done = state.tickets.filter((t) => t.status === "done");
  const bugs = state.tickets.filter((t) => t.kind === "bug");
  const escalated = state.tickets.filter((t) => t.escalated);
  const outcomes = new Map<string, number>();
  for (const t of state.tickets) for (const a of t.attempts) outcomes.set(a.outcome, (outcomes.get(a.outcome) ?? 0) + 1);
  const troubled = state.tickets.filter((t) => t.attempts.filter((a) => a.outcome !== "ok").length > 0);

  const lines = [
    `# Retrospective — ${state.runId}`,
    "",
    "## Outcome",
    "",
    `- ${done.length}/${state.tickets.length} tickets done (${done.filter((t) => t.kind !== "bug").length} features, ${done.filter((t) => t.kind === "bug").length} bug fixes)`,
    `- Final gates: ${args.gatesOk ? "passing" : "FAILING"} · merged: ${args.merged ? "yes" : "no"}`,
    `- Exploratory QA: ${args.qaRounds} round(s), ${bugs.length} bug ticket(s), ${args.openBugs.length} open`,
    `- New-contributor check: ${args.contributor ? (args.contributor.passed ? "passed" : "failed") : "not run"}`,
    `- Spent: ${formatCost(cost.totalUsd)} · ${formatTokens(cost.totalTokens)} tokens · ${cost.workerRuns} worker runs`,
    "",
    "## Cost by phase",
    "",
    "| Phase | Runs | Tokens | Cost |",
    "|---|---|---|---|",
    ...cost.byPhase.map((r) => `| ${r.key} | ${r.runs} | ${formatTokens(r.tokens)} | ${formatCost(r.costUsd)} |`),
    "",
    "## Escalations",
    "",
    ...(escalated.length
      ? escalated.map((t) => `- ${t.id} ${t.title}: ${[...new Set(t.attempts.map((a) => a.model))].join(" → ")}`)
      : ["- none"]),
    "",
    "## What failed along the way",
    "",
    ...(outcomes.size
      ? [`- attempt outcomes: ${[...outcomes.entries()].map(([k, v]) => `${k} ${v}`).join(", ")}`]
      : ["- no ticket attempts recorded"]),
    ...troubled.map((t) => `- ${t.id}: ${t.attempts.map((a) => a.outcome).join(" → ")}`),
  ];

  const followUps = [
    ...state.tickets.filter((t) => t.status === "skipped" || t.status === "blocked").map((t) => `${t.id} ${t.title} (${t.status})`),
    ...args.openBugs.map((b) => `Fix (${b.severity}): ${b.title}`),
    ...args.minorBugs.map((b) => `Fix (minor): ${b.title}`),
    ...args.untested.map((r) => `Add an end-to-end check for ${r} (exploratory QA could not test it)`),
    ...(args.contributor?.report?.gaps ?? []).map((g) => `Docs (${g.doc}): ${g.problem}`),
  ];
  lines.push("", "## Suggested follow-up tickets", "", ...(followUps.length ? followUps.map((f) => `- ${f}`) : ["- none"]));
  return `${lines.join("\n")}\n`;
}
