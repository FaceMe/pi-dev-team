/**
 * The factory pipeline: a resumable phase machine that drives role workers.
 *
 *   discovery → spec → architecture → planning → skeleton → build → verify → docs → release → done
 *
 * verify can loop back to build: bugs found by exploratory QA (or a red
 * integration) become bug tickets, up to the configured number of fix rounds.
 *
 * Every step persists to .factory/ before moving on, so a run can pause (user
 * choice, budget breaker, blocker, abort) and resume later from the same phase.
 * Human gates follow the autonomy preset; "done" is decided by the profile's
 * gate commands and the reviewer, never by a worker's own claim.
 */

import type { Model } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clampEffort, modelFamily } from "../shared/models.js";
import { truncate } from "../shared/text.js";
import type { Tier } from "../shared/tiers.js";
import { formatCost, formatTokens } from "../shared/usage.js";
import { boardLines } from "./board.js";
import { outOfScope } from "./guard.js";
import { describeGateFailure, gatesPassed, normalizeProfile, runCommand, runGates, summarizeGates } from "./gates.js";
import { blockedCommand } from "./guard.js";
import {
  changedFiles,
  changedSince,
  commitAll,
  commitDiff,
  currentBranch,
  deleteBranch,
  ensureRepo,
  ensureWorktree,
  filesBetween,
  git,
  headCommit,
  isClean,
  mergeBranch,
  mergeInto,
  removeWorktree,
  resetTo,
  restoreAfter,
  revertToBase,
  untrackedFiles,
  workingDiff,
} from "./git.js";
import { Mutex } from "./mutex.js";
import { nextRunnable } from "./scheduler.js";
import { describeSecrets, scanDiff } from "./secrets.js";
import { extractJson } from "./json-reply.js";
import { requirementIds, validatePlan } from "./plan.js";
import { matchProfileTemplates, templatesForPrompt } from "./profiles.js";
import type { BrainstormStance } from "./prompts.js";
import * as prompts from "./prompts.js";
import { READINESS_LABELS, isReady, normalizeReadiness, readinessMarkdown } from "./readiness.js";
import type { Readiness } from "./readiness.js";
import { estimateSize } from "./settings.js";
import { validateSpec } from "./spec-validator.js";
import type { SpecValidation } from "./spec-validator.js";
import type { FactoryStore } from "./store.js";
import { escalate } from "./team.js";
import type { Team } from "./team.js";
import { buildTraceability, traceabilityJson, traceabilitySummary } from "./traceability.js";
import type {
  Answer,
  BuildSettings,
  FactoryState,
  FactoryUI,
  GateResult,
  Phase,
  Profile,
  Question,
  RoleDef,
  SetupAnswers,
  TeamMember,
  Ticket,
  WorkerResult,
  WorkerRunner,
} from "./types.js";
import { PHASE_ORDER, buildSettings } from "./types.js";
import { orderTickets } from "./order.js";
import {
  bugTickets,
  contributorMarkdown,
  integrationBugTicket,
  judgeContributor,
  normalizeContributorReport,
  normalizeQaReport,
  projectVersion,
  qaReportMarkdown,
  releaseNotes,
  retrospective,
} from "./verify.js";
import type { ContributorOutcome, QaBug, QaReport } from "./verify.js";

export { orderTickets };

export interface PipelineDeps {
  cwd: string;
  ui: FactoryUI;
  runner: WorkerRunner;
  roles: Map<string, RoleDef>;
  team: Team;
  answers: SetupAnswers;
  store: FactoryStore;
  /** pi-web-access tools are available to workers. */
  webAccess: boolean;
  signal?: AbortSignal;
  workerTimeoutMs?: number;
  gateTimeoutMs?: number;
}

/** Thrown to stop the run cleanly (pause, stop, budget, abort). */
export class StopRun extends Error {
  constructor(readonly status: FactoryState["status"], message: string) {
    super(message);
  }
}

const OTHER = "Other — type my own answer";
const DEFAULTS = "Use your defaults for the remaining questions";
const MAX_ATTEMPTS_PER_MODEL = 2;
/** Brainstorms per run (plan §9.2); tracked via "brainstorm:<n>" notes so the cap survives resume. */
const MAX_BRAINSTORMS = 2;
/** Roles whose tickets get QA-first acceptance tests. */
const QA_ROLES = new Set(["backend", "frontend"]);
/** Write-scope globs that hold tests (the QA worker's scope is the ticket's test globs). */
const TEST_GLOB = /(^|\/|[._-])(tests?|specs?|__tests__|e2e)([._/-]|$)/i;

type IntegrationResult = { kind: "merged"; commit?: string } | { kind: "conflict"; files: string[] } | { kind: "integration_fail"; failure: string };

/** Lockfiles a package manager may touch whenever the manifest is in scope. */
const LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "poetry.lock",
  "uv.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
];

export function newState(idea: string, runId: string, answers: SetupAnswers): FactoryState {
  const now = new Date().toISOString();
  return {
    version: 1,
    runId,
    idea,
    phase: "discovery",
    status: "running",
    createdAt: now,
    updatedAt: now,
    answers: [],
    interviewRounds: 0,
    tickets: [],
    spentUsd: 0,
    spentTokens: 0,
    budgetUsd: answers.budgetUsd,
    budgetTokens: answers.budgetTokens,
    notes: [],
  };
}

export function makeRunId(date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  return `run-${stamp}`;
}

/** An AbortSignal that fires when any of the given signals does. */
function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => s !== undefined);
  if (live.length <= 1) return live[0];
  const controller = new AbortController();
  for (const s of live) {
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

export class FactoryRun {
  private activity: string[] = [];
  /** One prompt at a time, whichever parallel ticket asks. */
  private readonly uiLock = new Mutex();
  /** One merge into the integration branch at a time. */
  private readonly mergeLock = new Mutex();
  /** Aborts the sibling tickets when one stops the run (pause, blocker, failure). */
  private buildStop?: AbortController;
  /** Tickets being built right now. */
  private readonly inFlight = new Set<string>();
  /** Worktrees whose dependencies were installed by this process. */
  private readonly installed = new Set<string>();

  constructor(
    private readonly deps: PipelineDeps,
    readonly state: FactoryState,
  ) {}

  // -------------------------------------------------------------------------
  // Driver
  // -------------------------------------------------------------------------

  async run(): Promise<FactoryState> {
    const { ui } = this.deps;
    this.state.status = "running";
    this.save();
    try {
      while (this.state.phase !== "done") {
        this.checkAbort();
        const phase = this.state.phase;
        this.showStatus();
        ui.log("phase", { phase, runId: this.state.runId });
        await this.runPhase(phase);
        if (this.state.phase === phase) this.advance();
      }
      this.state.status = "done";
      this.save();
      this.showStatus();
      return this.state;
    } catch (error) {
      if (error instanceof StopRun) {
        this.state.status = error.status;
        this.state.lastError = error.message;
        this.save();
        ui.notify(error.message, error.status === "failed" ? "error" : "info");
      } else {
        this.state.status = "failed";
        this.state.lastError = error instanceof Error ? error.message : String(error);
        this.save();
        ui.notify(`Factory stopped: ${this.state.lastError}. Fix the cause, then /factory resume.`, "error");
      }
      this.showStatus();
      return this.state;
    }
  }

  private async runPhase(phase: Phase): Promise<void> {
    switch (phase) {
      case "setup":
      case "discovery":
        return this.discovery();
      case "spec":
        return this.spec();
      case "architecture":
        return this.architecture();
      case "planning":
        return this.planning();
      case "skeleton":
        return this.skeleton();
      case "build":
        return this.build();
      case "verify":
        return this.verify();
      case "docs":
        return this.docs();
      case "release":
        return this.release();
      case "done":
        return;
    }
  }

  private advance(): void {
    const index = PHASE_ORDER.indexOf(this.state.phase);
    this.state.phase = PHASE_ORDER[Math.min(PHASE_ORDER.length - 1, index + 1)];
    this.save();
  }

  private save(): void {
    this.deps.store.saveState(this.state);
  }

  private checkAbort(): void {
    if (this.deps.signal?.aborted || this.buildStop?.signal.aborted) throw new StopRun("paused", "Factory paused. Run /factory resume to continue.");
  }

  private get signal(): AbortSignal | undefined {
    return anySignal([this.deps.signal, this.buildStop?.signal]);
  }

  private get autonomy() {
    return this.deps.answers.autonomy;
  }

  private get settings(): BuildSettings {
    return buildSettings(this.deps.answers.build);
  }

  /** A user prompt, serialised so parallel tickets never ask at the same time. */
  private ask(title: string, options: string[]): Promise<string | undefined> {
    return this.uiLock.run(() => this.deps.ui.select(title, options));
  }

  // -------------------------------------------------------------------------
  // Status UI
  // -------------------------------------------------------------------------

  private budgetLine(): string {
    const { state } = this;
    if (state.budgetUsd > 0) return `${formatCost(state.spentUsd)}/$${state.budgetUsd}`;
    if (state.budgetTokens > 0) return `${formatTokens(state.spentTokens)}/${formatTokens(state.budgetTokens)} tok`;
    return formatCost(state.spentUsd);
  }

  showStatus(extra?: string): void {
    const { state, deps } = this;
    const done = state.tickets.filter((t) => t.status === "done").length;
    const tickets = state.tickets.length ? ` · ${done}/${state.tickets.length} tickets` : "";
    const label = state.status === "running" ? state.phase : `${state.phase} (${state.status})`;
    deps.ui.status(`🏭 ${label}${tickets} · ${this.budgetLine()}`);
    deps.ui.widget(state.status === "done" ? undefined : boardLines(state, { activity: this.activity, extra }));
  }

  // -------------------------------------------------------------------------
  // Workers
  // -------------------------------------------------------------------------

  private role(name: string): RoleDef {
    const role = this.deps.roles.get(name) ?? this.deps.roles.get("backend");
    if (!role) throw new StopRun("failed", `No "${name}" role is defined.`);
    return role;
  }

  private member(roleName: string): TeamMember {
    const member = this.deps.team.members[roleName] ?? this.deps.team.members.backend;
    if (!member) throw new StopRun("failed", `No model is available for the ${roleName} role. Run /login, then /factory resume.`);
    return member;
  }

  private tools(role: RoleDef): string[] {
    const web = new Set(["web_search", "fetch_content"]);
    return role.tools.filter((tool) => !web.has(tool) || (this.deps.webAccess && this.deps.answers.research !== "off"));
  }

  private systemPrompt(role: RoleDef): string {
    return `${role.systemPrompt}

## Factory context
You are one member of an automated software team (the pi software factory).
You cannot talk to the user; the factory relays questions and results.
${prompts.settingsSummary(this.deps.answers)}
Work only inside the current working directory.`;
  }

  /** Stop at the budget breaker (80% by default) and ask to raise it or pause. */
  private async checkBudget(): Promise<void> {
    const { state } = this;
    const over = () => {
      const fraction = this.settings.budgetBreaker;
      return {
        usd: state.budgetUsd > 0 && state.spentUsd >= state.budgetUsd * fraction,
        tokens: state.budgetTokens > 0 && state.spentTokens >= state.budgetTokens * fraction,
      };
    };
    if (!over().usd && !over().tokens) return;
    await this.uiLock.run(async () => {
      // A parallel ticket may have raised the budget while this one waited.
      const { usd, tokens } = over();
      if (!usd && !tokens) return;
      this.checkAbort();
      const spent = usd ? `${formatCost(state.spentUsd)} of $${state.budgetUsd}` : `${formatTokens(state.spentTokens)} of ${formatTokens(state.budgetTokens)} tokens`;
      const choice = await this.deps.ui.select(`Budget: ${spent} used (${state.phase}). Continue?`, [
        "Raise the budget by 50% and continue",
        "Pause the factory",
      ]);
      if (choice?.startsWith("Raise")) {
        if (usd) state.budgetUsd = Math.ceil(state.budgetUsd * 1.5);
        if (tokens) state.budgetTokens = Math.ceil(state.budgetTokens * 1.5);
        this.save();
        return;
      }
      throw new StopRun("paused", "Factory paused at the budget limit. Run /factory resume to continue.");
    });
  }

  /** Stop and ask when more than the configured share of tickets has escalated (asked once per run). */
  private async checkEscalationBreaker(): Promise<void> {
    const { state } = this;
    const tripped = () => {
      if (state.notes.includes("breaker:escalation")) return undefined;
      const escalated = state.tickets.filter((t) => t.escalated).length;
      return state.tickets.length > 0 && escalated / state.tickets.length > this.settings.escalationBreaker ? escalated : undefined;
    };
    if (tripped() === undefined) return;
    await this.uiLock.run(async () => {
      const escalated = tripped();
      if (escalated === undefined) return;
      this.checkAbort();
      const choice = await this.deps.ui.select(
        `${escalated} of ${state.tickets.length} tickets needed a stronger model — the tickets may be too large or the briefs unclear. Continue?`,
        ["Continue building", "Pause the factory (review .factory/tickets.json, then /factory resume)"],
      );
      if (!choice?.startsWith("Continue")) throw new StopRun("paused", "Factory paused at the escalation breaker. Run /factory resume to continue.");
      state.notes.push("breaker:escalation");
      this.save();
    });
  }

  async work(
    roleName: string,
    options: { prompt: string; cwd: string; session: string; writeScope: string[]; member?: TeamMember; allowDeploy?: boolean; ticket?: string },
  ): Promise<WorkerResult> {
    this.checkAbort();
    await this.checkBudget();
    const role = this.role(roleName);
    const member = options.member ?? this.member(roleName);
    const label = () =>
      this.inFlight.size > 1
        ? `building ${[...this.inFlight].join(", ")} in parallel`
        : `${roleName} · ${member.provider}/${member.modelId}${options.ticket ? ` · ${options.ticket}` : ""}`;
    this.showStatus(label());
    const result = await this.deps.runner.run({
      role: roleName,
      member,
      tools: this.tools(role),
      systemPrompt: this.systemPrompt(role),
      prompt: options.prompt,
      cwd: options.cwd,
      sessionId: `${this.state.runId}-${options.session}`,
      sessionDir: this.deps.store.sessionsDir,
      writeScope: options.writeScope,
      sidekick: role.sidekick,
      allowDeploy: options.allowDeploy,
      timeoutMs: this.deps.workerTimeoutMs ?? 30 * 60_000,
      signal: this.signal,
      onActivity: (line) => {
        this.activity.push(`${options.ticket ? `${options.ticket} ` : ""}${roleName}: ${line}`);
        if (this.activity.length > 20) this.activity.shift();
        this.showStatus(label());
      },
    });
    this.state.spentUsd += result.usage.cost.total;
    this.state.spentTokens += result.usage.totalTokens;
    this.save();
    this.deps.store.ledger({
      kind: "worker",
      runId: this.state.runId,
      phase: this.state.phase,
      role: roleName,
      model: `${member.provider}/${member.modelId}`,
      ticket: options.ticket,
      turns: result.turns,
      tokens: result.usage.totalTokens,
      tokensIn: result.usage.input,
      tokensOut: result.usage.output,
      costUsd: result.usage.cost.total,
      ok: !result.isError,
      error: result.errorMessage,
      trace: result.trace.length ? result.trace : undefined,
    });
    this.checkAbort();
    return result;
  }

  /** Run a worker that must reply with JSON; retries in the same session with the parse/validation error. */
  async workJson<T>(
    roleName: string,
    options: { prompt: string; cwd: string; session: string; writeScope: string[] },
    validate: (value: any) => { value?: T; error?: string },
  ): Promise<T> {
    const outcome = await this.jsonWorker(roleName, options, validate);
    if ("value" in outcome) return outcome.value;
    throw new StopRun("failed", outcome.failure);
  }

  /** Like workJson, but a worker that never returns usable JSON yields undefined (for optional checks). */
  async tryWorkJson<T>(
    roleName: string,
    options: { prompt: string; cwd: string; session: string; writeScope: string[] },
    validate: (value: any) => { value?: T; error?: string },
  ): Promise<T | undefined> {
    const outcome = await this.jsonWorker(roleName, options, validate);
    return "value" in outcome ? outcome.value : undefined;
  }

  private async jsonWorker<T>(
    roleName: string,
    options: { prompt: string; cwd: string; session: string; writeScope: string[] },
    validate: (value: any) => { value?: T; error?: string },
  ): Promise<{ value: T } | { failure: string }> {
    let prompt = options.prompt;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await this.work(roleName, { ...options, prompt });
      if (result.isError) {
        if (attempt < 2) continue;
        return { failure: `The ${roleName} worker failed: ${result.errorMessage}` };
      }
      const parsed = extractJson(result.text);
      const checked = parsed.error ? { error: parsed.error } : validate(parsed.value);
      if (checked.value !== undefined && !checked.error) return { value: checked.value };
      prompt = `Your reply could not be used: ${checked.error}\nReply again with only the corrected fenced json block.`;
    }
    return { failure: `The ${roleName} worker did not return usable JSON after 3 attempts.` };
  }

  private approve(title: string, summary: string, extraOptions: string[] = []): Promise<string> {
    return this.uiLock.run(async () => {
      this.checkAbort();
      const options = ["Approve", ...extraOptions, "Pause the factory"];
      this.deps.ui.log("approval", { title, summary });
      this.state.status = "waiting";
      this.save();
      this.showStatus("waiting for your approval");
      const choice = await this.deps.ui.select(`${title}\n\n${summary}`, options);
      this.state.status = "running";
      this.save();
      if (!choice || choice === "Pause the factory") throw new StopRun("paused", "Factory paused. Run /factory resume to continue.");
      return choice;
    });
  }

  // -------------------------------------------------------------------------
  // Phases
  // -------------------------------------------------------------------------

  private async discovery(): Promise<void> {
    const { deps, state } = this;
    deps.store.ensure();
    if (!deps.store.read("brief.md")) deps.store.write("brief.md", state.idea);

    const size = estimateSize(state.idea);
    const maxRounds = size === "small" ? 1 : size === "medium" ? 2 : 3;
    let useDefaults = false;
    const brainstormDigests: string[] = [];

    while (state.interviewRounds < maxRounds && !useDefaults) {
      const round = state.interviewRounds + 1;
      const reply = await this.workJson<{ ready: boolean; questions: Question[]; readiness?: Readiness; brainstorm?: string }>(
        "analyst",
        {
          prompt: prompts.interviewPrompt({
            idea: state.idea,
            settings: deps.answers,
            answers: state.answers,
            round,
            maxRounds,
            readiness: state.readiness,
            brainstorms: brainstormDigests.slice(-2),
          }),
          cwd: deps.cwd,
          session: "analyst",
          writeScope: [".factory/spec/**"],
        },
        (value) => {
          if (!value || typeof value !== "object") return { error: "expected an object" };
          const questions: Question[] = (Array.isArray(value.questions) ? value.questions : [])
            .filter((q: any) => q && typeof q.question === "string" && Array.isArray(q.options) && q.options.length > 0)
            .slice(0, 4)
            .map((q: any, i: number) => ({
              id: typeof q.id === "string" ? q.id : `q${round}-${i + 1}`,
              question: q.question,
              why: typeof q.why === "string" ? q.why : undefined,
              options: q.options.filter((o: unknown) => typeof o === "string").slice(0, 4),
              recommended: Number.isInteger(q.recommended) && q.recommended >= 0 && q.recommended < q.options.length ? q.recommended : 0,
            }));
          const readiness = value.readiness === undefined ? undefined : (normalizeReadiness(value.readiness) ?? undefined);
          const brainstorm = typeof value.brainstorm === "string" && value.brainstorm.trim() ? value.brainstorm.trim() : undefined;
          return { value: { ready: value.ready === true || questions.length === 0, questions, readiness, brainstorm } };
        },
      );
      state.interviewRounds = round;
      if (reply.readiness) state.readiness = reply.readiness;
      this.save();

      // The readiness checklist, not the analyst's own "ready", decides when discovery is deep enough.
      if (reply.ready || (state.readiness && isReady(state.readiness))) break;

      for (const q of reply.questions) {
        const recommended = q.options[q.recommended] ?? q.options[0];
        if (useDefaults) {
          state.answers.push({ id: q.id, question: q.question, answer: recommended, assumed: true });
          continue;
        }
        const others = q.options.filter((_, i) => i !== q.recommended);
        const options = [`${recommended} (recommended)`, ...others, OTHER, DEFAULTS];
        const title = q.why ? `${q.question}\n${q.why}` : q.question;
        const choice = await deps.ui.select(title, options);
        let answer: Answer;
        if (choice === undefined || choice === DEFAULTS) {
          useDefaults = true;
          answer = { id: q.id, question: q.question, answer: recommended, assumed: true };
        } else if (choice === OTHER) {
          const typed = await deps.ui.input(q.question, recommended);
          answer = typed?.trim()
            ? { id: q.id, question: q.question, answer: typed.trim(), assumed: false }
            : { id: q.id, question: q.question, answer: recommended, assumed: true };
        } else {
          answer = { id: q.id, question: q.question, answer: choice.replace(/ \(recommended\)$/, ""), assumed: false };
        }
        state.answers.push(answer);
      }

      if (reply.brainstorm && !useDefaults && this.brainstormCount() < MAX_BRAINSTORMS) {
        const digest = await this.runBrainstorm(reply.brainstorm);
        if (digest) brainstormDigests.push(digest);
      }
      this.save();
    }

    if (state.readiness) deps.store.write("spec/readiness.md", readinessMarkdown(state.readiness));
    deps.store.write("spec/decisions.md", prompts.decisionsMarkdown(state.idea, state.answers));
    this.writeAssumptions();

    if (deps.answers.research !== "off" && !deps.store.read("research/notes.md")) {
      const result = await this.work("researcher", {
        prompt: prompts.researchPrompt({ idea: state.idea, decisionsPath: ".factory/spec/decisions.md", webAccess: deps.webAccess }),
        cwd: deps.cwd,
        session: "researcher",
        writeScope: [".factory/research/**"],
      });
      if (result.isError) state.notes.push(`research skipped: ${truncate(result.errorMessage ?? "", 160)}`);
    }
  }

  /** spec/assumptions.md is derived data: every silently accepted default plus every unresolved readiness topic. Rewritten fresh each pass. */
  private writeAssumptions(): void {
    const { state, deps } = this;
    const lines = ["# Assumptions", "", "## Accepted defaults", ""];
    const assumed = state.answers.filter((a) => a.assumed);
    if (assumed.length === 0) lines.push("_No defaults were accepted without an answer._");
    for (const a of assumed) lines.push(`- Assumed (you did not answer): ${a.question} — ${a.answer}`);
    lines.push("", "## Unresolved topics", "");
    const unresolved = state.readiness?.items.filter((item) => item.status === "unknown") ?? [];
    if (unresolved.length === 0) lines.push("_Every readiness topic is known or assumed._");
    for (const item of unresolved) {
      const label = READINESS_LABELS[item.topic] ?? item.topic;
      lines.push(`- Unresolved: ${label} — ${item.note ?? label}`);
    }
    deps.store.write("spec/assumptions.md", `${lines.join("\n")}\n`);
  }

  // -- brainstorm (plan §9.2) --------------------------------------------------

  /** Brainstorms already run in this run ("brainstorm:<n>" notes survive resume). */
  private brainstormCount(): number {
    return this.state.notes.filter((n) => /^brainstorm:\d+$/.test(n)).length;
  }

  /** The tier models (frontier, daily, small order) deduplicated by model family, up to 3. */
  private brainstormCandidates(): TeamMember[] {
    const tiers = this.deps.team.tiers;
    const effort = this.role("analyst").effort;
    const byTier: Array<[Tier, Model<any> | undefined]> = [
      ["frontier", tiers.frontier],
      ["daily", tiers.daily],
      ["small", tiers.small],
    ];
    const seen = new Set<string>();
    const members: TeamMember[] = [];
    for (const [tier, model] of byTier) {
      if (!model) continue;
      const family = modelFamily(model);
      if (seen.has(family)) continue;
      seen.add(family);
      members.push({ role: "analyst", provider: model.provider, modelId: model.id, tier, family, effort: clampEffort(model, effort) });
    }
    return members.slice(0, 3);
  }

  /**
   * Fan one contested interview question out to a model per stance, synthesise,
   * and file .factory/research/brainstorm-<n>.md. Returns a digest for the next
   * interview round, or undefined when skipped (one family) or failed.
   */
  private async runBrainstorm(question: string): Promise<string | undefined> {
    const { deps, state } = this;
    const candidates = this.brainstormCandidates();
    if (candidates.length < 2) {
      state.notes.push("brainstorm skipped: one model family logged in");
      this.save();
      return undefined;
    }
    const n = this.brainstormCount() + 1;
    const stances: BrainstormStance[] = ["divergent", "critical", "pragmatic"];
    const takes = stances.map((stance, i) => ({ stance, member: candidates[i % candidates.length] }));
    const outputs = await Promise.all(
      takes.map(({ stance, member }) =>
        this.work("analyst", {
          prompt: prompts.brainstormStancePrompt({ question, stance, idea: state.idea, answers: state.answers }),
          cwd: deps.cwd,
          session: `brainstorm-${n}-${stance}`,
          writeScope: [],
          member,
        }),
      ),
    );

    let synthesis: { options: string[]; recommendation: string; risks: string[] };
    try {
      synthesis = await this.workJson<{ options: string[]; recommendation: string; risks: string[] }>(
        "analyst",
        {
          prompt: prompts.brainstormSynthesisPrompt({
            question,
            stances: takes.map((take, i) => ({
              stance: take.stance,
              model: `${take.member.provider}/${take.member.modelId}`,
              output: outputs[i].isError
                ? `(this take failed: ${truncate(outputs[i].errorMessage ?? "", 120)})`
                : truncate(outputs[i].text, 600),
            })),
          }),
          cwd: deps.cwd,
          session: `brainstorm-${n}-synthesis`,
          writeScope: [],
        },
        (value) => {
          const options = Array.isArray(value?.options) ? value.options.filter((o: unknown) => typeof o === "string" && o.trim()) : [];
          const recommendation = typeof value?.recommendation === "string" ? value.recommendation.trim() : "";
          const risks = Array.isArray(value?.risks) ? value.risks.filter((r: unknown) => typeof r === "string" && r.trim()) : [];
          if (options.length < 1 || options.length > 8 || !recommendation) {
            return { error: 'reply needs "options" (1-8 strings) and a non-empty "recommendation"' };
          }
          return { value: { options, recommendation, risks } };
        },
      );
    } catch (error) {
      // An optional enhancement must not take the run down; a pause/abort still propagates.
      if (!(error instanceof StopRun) || error.status !== "failed") throw error;
      state.notes.push(`brainstorm ${n} failed: ${truncate(error.message, 160)}`);
      this.save();
      return undefined;
    }

    const lines = [
      `# Brainstorm ${n}`,
      "",
      `Question: ${question}`,
      "",
      ...takes.flatMap((take, i) => [`## ${take.stance} — ${take.member.provider}/${take.member.modelId}`, "", outputs[i].isError ? `(failed: ${truncate(outputs[i].errorMessage ?? "", 200)})` : truncate(outputs[i].text, 600), ""]),
      "## Synthesis",
      "",
      `Recommendation: ${synthesis.recommendation}`,
      "",
      "Options:",
      ...synthesis.options.map((option) => `- ${option}`),
      "",
      "Risks:",
      ...(synthesis.risks.length ? synthesis.risks.map((risk) => `- ${risk}`) : ["- (none listed)"]),
    ];
    deps.store.write(`research/brainstorm-${n}.md`, `${lines.join("\n")}\n`);
    state.notes.push(`brainstorm:${n}`);
    this.save();
    return truncate(`Brainstorm ${n} on "${question}": recommend ${synthesis.recommendation}; options: ${synthesis.options.join("; ")}`, 500);
  }

  private async spec(): Promise<void> {
    const { deps } = this;
    const specPath = deps.store.path("spec", "spec.md");
    let feedback: string | undefined;
    if (fs.existsSync(specPath) && this.state.notes.includes("spec:written")) {
      // Resumed after writing: go straight to approval.
    } else {
      await this.writeSpec();
    }

    for (;;) {
      const spec = deps.store.read("spec/spec.md") ?? "";
      const ids = requirementIds(spec);
      const validation = this.checkSpec(spec);
      const assumptions = (deps.store.read("spec/assumptions.md") ?? "").split("\n").filter((l) => l.trim().startsWith("-")).length;
      const requirements = validation?.summary
        ?? `${ids.filter((id) => id.startsWith("FR-")).length} functional and ${ids.filter((id) => id.startsWith("NFR-")).length} non-functional requirements`;
      const summary = [
        `${requirements}; ${assumptions} assumptions.`,
        ...(validation && !validation.ok ? [`${validation.issues.length} spec-validator issue(s) — see .factory/spec/spec.md`] : []),
        `Read it in .factory/spec/spec.md (assumptions in .factory/spec/assumptions.md).`,
        "",
        truncate(spec.split("\n").filter((l) => l.trim() && !l.startsWith("#")).slice(0, 6).join(" "), 400),
      ].join("\n");
      const choice = await this.approve("Approve the specification?", summary, ["Request changes…"]);
      if (choice === "Approve") break;
      feedback = await deps.ui.input("What should change in the spec?", "e.g. drop user accounts; add CSV export");
      if (!feedback?.trim()) continue;
      await this.writeSpec(feedback.trim());
    }
  }

  private async writeSpec(feedback?: string): Promise<void> {
    const { deps } = this;
    let retry: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.work("analyst", {
        prompt:
          attempt === 0
            ? prompts.specPrompt({
                idea: this.state.idea,
                decisionsPath: ".factory/spec/decisions.md",
                researchPath: deps.store.read("research/notes.md") ? ".factory/research/notes.md" : undefined,
                feedback,
              })
            : (retry ??
              "The file .factory/spec/spec.md is missing or has no FR-xxx requirements with Given/When/Then acceptance criteria. Write it now as instructed."),
        cwd: deps.cwd,
        session: "analyst",
        writeScope: [".factory/spec/**"],
      });
      if (result.isError) throw new StopRun("failed", `The analyst failed to write the spec: ${result.errorMessage}`);
      const spec = deps.store.read("spec/spec.md") ?? "";
      if (!/\bFR-\d+/.test(spec) || !/\bGiven\b/i.test(spec)) {
        retry = "The file .factory/spec/spec.md is missing or has no FR-xxx requirements with Given/When/Then acceptance criteria. Write it now as instructed.";
        continue;
      }
      const validation = this.checkSpec(spec);
      if (!validation || validation.ok) {
        this.markSpecWritten();
        return;
      }
      if (attempt === 1) {
        // Persistent validator failure is surfaced at the approval gate, not a hard stop.
        this.state.notes.push(`spec validator still failing: ${truncate(validation.summary, 200)}`);
        this.markSpecWritten();
        return;
      }
      retry = prompts.specValidatorFeedback(validation);
    }
    throw new StopRun("failed", "The analyst did not produce a valid .factory/spec/spec.md.");
  }

  private markSpecWritten(): void {
    if (!this.state.notes.includes("spec:written")) this.state.notes.push("spec:written");
    this.save();
  }

  /** validateSpec is a quality gate; when the validator itself cannot run, spec quality is judged at the approval gate instead. */
  private checkSpec(spec: string): SpecValidation | undefined {
    try {
      return validateSpec(spec);
    } catch {
      return undefined;
    }
  }

  private async architecture(): Promise<void> {
    const { deps } = this;
    let feedback: string | undefined;
    for (;;) {
      await this.designArchitecture(feedback);
      if (this.autonomy !== "careful") return;
      const profile = deps.store.loadProfile()!;
      const choice = await this.approve(
        "Approve the architecture?",
        `Stack: ${profile.stack}\nGates: ${profile.gates.map((g) => g.name).join(", ")}\nRead .factory/adr/0001-architecture.md.`,
        ["Request changes…"],
      );
      if (choice === "Approve") return;
      feedback = (await deps.ui.input("What should change in the architecture?"))?.trim() || undefined;
    }
  }

  private async designArchitecture(feedback?: string): Promise<Profile> {
    const { deps } = this;
    const spec = deps.store.read("spec/spec.md") ?? "";
    const templateBlock = templatesForPrompt(matchProfileTemplates(deps.answers.stack === "auto" ? "" : deps.answers.stack, spec));
    const profile = await this.workJson<Profile>(
      "architect",
      {
        prompt: prompts.architecturePrompt({
          settings: deps.answers,
          specPath: ".factory/spec/spec.md",
          researchPath: deps.store.read("research/notes.md") ? ".factory/research/notes.md" : undefined,
          templates: templateBlock || undefined,
          feedback,
        }),
        cwd: deps.cwd,
        session: "architect",
        writeScope: [".factory/adr/**", ".factory/contracts/**"],
      },
      (value) => {
        const res = normalizeProfile(value);
        if (res.error) return { error: res.error };
        if (!res.profile) return { error: "profile is not an object" };
        if (!deps.store.read("adr/0001-architecture.md")) return { error: "write .factory/adr/0001-architecture.md before replying" };
        const badName = (name: string) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
        const contracts = res.profile.contracts ?? [];
        if (contracts.some(badName)) return { error: "contracts must be plain file names under .factory/contracts/ (no paths)" };
        const missingContracts = contracts.filter((name) => !deps.store.read(`contracts/${name}`));
        if (missingContracts.length) return { error: `the reply lists contract files you did not write: ${missingContracts.join(", ")}` };
        const adrs = (res.profile.adrs ?? []).filter((name) => name !== "0001-architecture.md");
        if (adrs.some(badName)) return { error: "adrs must be plain file names under .factory/adr/ (no paths)" };
        const missingAdrs = adrs.filter((name) => !deps.store.read(`adr/${name}`));
        if (missingAdrs.length) return { error: `the reply lists ADR files you did not write: ${missingAdrs.join(", ")}` };
        if (!contracts.length && /\b(api|rest|graphql|endpoint|http|web app|web ui|frontend|database|schema)\b/i.test(spec)) {
          return { error: 'the spec describes an API/UI/data surface: write at least one contract file under .factory/contracts/ and list it as "contracts"' };
        }
        return { value: res.profile };
      },
    );
    deps.store.saveProfile(profile);
    return profile;
  }

  private async planning(): Promise<void> {
    const { deps, state } = this;
    let feedback: string | undefined;
    for (;;) {
      const profile = deps.store.loadProfile();
      if (!profile) throw new StopRun("failed", "No stack profile found; run the architecture phase again.");
      let planWarnings: string[] = [];
      if (state.tickets.length === 0 || feedback) {
        const ids = requirementIds(deps.store.read("spec/spec.md") ?? "");
        const tickets = await this.workJson<Ticket[]>(
          "planner",
          { prompt: prompts.planningPrompt({ profile, feedback, contracts: profile.contracts }), cwd: deps.cwd, session: "planner", writeScope: [] },
          (value) => {
            const check = validatePlan(value, ids);
            planWarnings = check.warnings;
            return check.errors.length ? { error: check.errors.join("; ") } : { value: check.tickets };
          },
        );
        state.tickets = orderTickets(tickets);
        deps.store.write("tickets.json", JSON.stringify(state.tickets, null, 2));
        deps.store.write("traceability.json", traceabilityJson(buildTraceability(state.tickets, ids)));
        this.save();
      }
      if (this.autonomy === "auto") return;

      const coverage = traceabilitySummary(buildTraceability(state.tickets, requirementIds(deps.store.read("spec/spec.md") ?? "")));
      const summary = [
        `Stack: ${profile.stack}`,
        profile.contracts?.length ? `Contracts: ${profile.contracts.map((c) => `.factory/contracts/${c}`).join(", ")}` : "",
        `Gates: ${profile.gates.map((g) => `${g.name} (\`${g.command}\`)`).join(", ")}`,
        `${state.tickets.length} tickets:`,
        ...state.tickets.slice(0, 15).map((t) => `  ${t.id} [${t.role}] ${t.title}`),
        state.tickets.length > 15 ? `  … and ${state.tickets.length - 15} more (.factory/tickets.json)` : "",
        coverage,
        ...planWarnings.slice(0, 4).map((w) => `! ${w}`),
        planWarnings.length > 4 ? `! … and ${planWarnings.length - 4} more planner warnings` : "",
        `Budget: ${this.budgetLine()} spent so far.`,
        "Architecture: .factory/adr/0001-architecture.md",
      ].filter(Boolean).join("\n");
      const choice = await this.approve("Approve the build plan?", summary, ["Change the tickets…", "Change the architecture…"]);
      if (choice === "Approve") return;
      const what = choice.includes("architecture") ? "architecture" : "tickets";
      const typed = (await deps.ui.input(`What should change in the ${what}?`))?.trim();
      if (!typed) continue;
      if (what === "architecture") {
        await this.designArchitecture(typed);
        feedback = "The architecture changed; re-plan against the updated .factory/adr/0001-architecture.md.";
      } else {
        feedback = typed;
      }
    }
  }

  // -- workspace ------------------------------------------------------------

  private async ensureWorkspace(): Promise<string> {
    const { deps, state } = this;
    const repo = await ensureRepo(deps.cwd);
    if (repo.error) throw new StopRun("failed", `git: ${repo.error}`);
    if (!state.baseCommit) {
      state.baseBranch = await currentBranch(deps.cwd);
      state.baseCommit = await headCommit(deps.cwd);
    }
    state.branch ??= `factory/${state.runId}`;
    state.worktree ??= deps.store.path("worktrees", state.runId);
    const wt = await ensureWorktree(deps.cwd, state.worktree, state.branch, state.baseCommit!);
    if (wt.error) throw new StopRun("failed", `git worktree: ${wt.error}`);
    this.save();
    return state.worktree;
  }

  private copyDocsInto(worktree: string): void {
    const { store } = this.deps;
    const copies: Array<[string, string]> = [["spec/spec.md", "docs/spec.md"]];
    for (const name of this.listFiles("adr")) copies.push([`adr/${name}`, `docs/adr/${name}`]);
    for (const name of this.listFiles("contracts")) copies.push([`contracts/${name}`, `docs/contracts/${name}`]);
    for (const [from, to] of copies) {
      const text = store.read(from);
      if (!text) continue;
      const target = path.join(worktree, to);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
  }

  /** File names in a .factory/ subdirectory ([] when it does not exist). */
  private listFiles(rel: string): string[] {
    try {
      return fs.readdirSync(this.deps.store.path(rel)).filter((name) => !name.startsWith("."));
    } catch {
      return [];
    }
  }

  private profile(): Profile {
    const profile = this.deps.store.loadProfile();
    if (!profile) throw new StopRun("failed", "No stack profile found.");
    return profile;
  }

  private async gates(
    worktree: string,
    options: { skipInstall?: boolean; ticket?: string; where?: "ticket" | "integration" | "qa" } = {},
  ): Promise<{ ok: boolean; results: GateResult[] }> {
    const profile = this.profile();
    this.showStatus(options.ticket ? `running gates · ${options.ticket}${options.where === "integration" ? " on integration" : ""}` : "running gates");
    const results = await runGates(profile, worktree, { skipInstall: options.skipInstall, timeoutMs: this.deps.gateTimeoutMs });
    const ok = gatesPassed(results, profile, options.skipInstall);
    if (results.some((r) => r.gate === "install" && r.ok)) this.installed.add(worktree);
    const failed = results.find((r) => !r.ok);
    this.deps.store.ledger({
      kind: "gates",
      runId: this.state.runId,
      phase: this.state.phase,
      ticket: options.ticket,
      where: options.where,
      ok,
      summary: summarizeGates(results),
      ...(failed ? { failedGate: failed.gate, failures: failed.details } : {}),
    });
    this.deps.ui.log("gates", { ok, summary: `${options.ticket ? `${options.ticket}${options.where === "integration" ? " (integration)" : ""}: ` : ""}${summarizeGates(results)}` });
    return { ok, results };
  }

  /** Gates in a ticket worktree: install once per worktree, again only when a manifest changed. */
  private ticketGates(dir: string, ticket: Ticket, manifestsChanged: boolean, where: "ticket" | "qa" = "ticket") {
    return this.gates(dir, { skipInstall: this.installed.has(dir) && !manifestsChanged, ticket: ticket.id, where });
  }

  /** Append a ticket-history event to the ledger (/factory history <ticket>). */
  private ticketEvent(ticket: Ticket, event: string, data: Record<string, unknown> = {}): void {
    this.deps.store.ledger({ kind: "ticket", runId: this.state.runId, ticket: ticket.id, event, ...data });
  }

  private async skeleton(): Promise<void> {
    const { deps } = this;
    // Probe before ensureWorkspace(): it creates the worktree, which would make
    // a resumed run indistinguishable from a first run.
    const resuming = fs.existsSync(this.state.worktree ?? deps.store.path("worktrees", this.state.runId));
    const worktree = await this.ensureWorkspace();
    this.copyDocsInto(worktree);
    const profile = this.profile();
    if (resuming) {
      const gates = await this.gates(worktree);
      if (gates.ok) {
        await commitAll(worktree, "chore: project skeleton");
        return;
      }
    }
    const member = this.member("devops");
    const ladder: TeamMember[] = [member];
    for (let next = escalate(deps.team, this.role("devops"), member); next; next = escalate(deps.team, this.role("devops"), ladder.at(-1)!)) {
      ladder.push(next);
    }

    let feedback: string | undefined;
    for (const current of ladder) {
      for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_MODEL + 1; attempt++) {
        const result = await this.work("devops", {
          prompt: prompts.skeletonPrompt({ settings: deps.answers, profile, feedback }),
          cwd: worktree,
          session: "skeleton",
          writeScope: ["**"],
          member: current,
        });
        if (result.isError) {
          feedback = `Your previous run ended with an error: ${result.errorMessage}. Continue and finish the skeleton.`;
          continue;
        }
        const gates = await this.gates(worktree);
        if (gates.ok) {
          const commit = await commitAll(worktree, deps.answers.projectMode === "existing" ? "chore: factory tooling and docs" : "chore: project skeleton");
          if (commit.error) throw new StopRun("failed", `git commit: ${commit.error}`);
          return;
        }
        feedback = describeGateFailure(gates.results);
      }
    }
    const choice = await deps.ui.select("The skeleton's gates still fail after every model tried.", [
      "Retry with the strongest model",
      "Pause the factory (fix it yourself, then /factory resume)",
    ]);
    if (choice?.startsWith("Retry")) return this.skeleton();
    throw new StopRun("paused", `Skeleton gates failing. Worktree: ${worktree}. Fix and run /factory resume.`);
  }

  // -- build (plan §10) ---------------------------------------------------------

  /**
   * The parallel build loop: start every ticket the scheduler allows (settled
   * dependencies, disjoint write scopes, at most maxParallel), each in its own
   * worktree, and start more as tickets finish. The first ticket that stops the
   * run (pause, blocker, failure) aborts its siblings; their tickets stay
   * in progress and continue from their worktrees on resume.
   */
  private async build(): Promise<void> {
    const { state } = this;
    await this.ensureWorkspace();
    const profile = this.profile();
    // Resuming means the user dealt with whatever blocked a ticket.
    for (const t of state.tickets) if (t.status === "blocked") t.status = "todo";
    await this.cleanupTicketWorkspaces();

    const scopeOf = (t: Ticket) => this.scopeFor(t, profile);
    const running = new Map<string, Promise<void>>();
    let failure: unknown;
    this.buildStop = new AbortController();
    try {
      for (;;) {
        if (failure === undefined) {
          for (const ticket of nextRunnable(state.tickets, new Set(running.keys()), this.settings.maxParallel, scopeOf)) {
            this.noteSkippedDependencies(ticket);
            const task = this.buildTicket(ticket)
              .catch((error) => {
                if (failure === undefined) {
                  failure = error;
                  this.buildStop?.abort();
                }
              })
              .finally(() => running.delete(ticket.id));
            running.set(ticket.id, task);
          }
        }
        if (running.size === 0) break;
        await Promise.race(running.values());
      }
    } finally {
      this.buildStop = undefined;
    }
    if (failure !== undefined) throw failure;
  }

  private noteSkippedDependencies(ticket: Ticket): void {
    const skipped = ticket.dependsOn.filter((dep) => this.state.tickets.find((t) => t.id === dep)?.status === "skipped");
    const note = `${ticket.id} built without unfinished dependencies: ${skipped.join(", ")}`;
    if (skipped.length > 0 && !this.state.notes.includes(note)) this.state.notes.push(note);
  }

  private scopeFor(ticket: Ticket, profile: Profile): string[] {
    const manifestsInScope = profile.manifests.some((m) => ticket.writeScope.some((g) => g === m || g.endsWith(`/${m}`) || g === "**"));
    return manifestsInScope ? [...ticket.writeScope, ...LOCKFILES, ...LOCKFILES.map((l) => `**/${l}`)] : ticket.writeScope;
  }

  private async revertOutOfScope(worktree: string, files: string[]): Promise<void> {
    for (const file of files) {
      const tracked = await git(worktree, ["ls-files", "--error-unmatch", file]);
      if (tracked.ok) await git(worktree, ["checkout", "HEAD", "--", file]);
      else fs.rmSync(path.join(worktree, file), { force: true, recursive: true });
    }
  }

  /** The last model on a role's escalation ladder. */
  private strongest(roleName: string): TeamMember {
    const role = this.role(roleName);
    let current = this.member(roleName);
    for (let next = escalate(this.deps.team, role, current); next; next = escalate(this.deps.team, role, current)) current = next;
    return current;
  }

  // -- ticket workspaces ---------------------------------------------------------

  /** The ticket's own worktree on branch <factory branch>-<ticket id>, branched from the integration head. */
  private async ticketWorkspace(ticket: Ticket): Promise<string> {
    const { deps, state } = this;
    ticket.branch ??= `${state.branch}-${ticket.id}`;
    ticket.worktree ??= deps.store.path("worktrees", `${state.runId}-${ticket.id}`);
    if (!fs.existsSync(path.join(ticket.worktree, ".git"))) {
      const branchExists = (await git(deps.cwd, ["rev-parse", "--verify", `refs/heads/${ticket.branch}`])).ok;
      const integrationHead = await headCommit(state.worktree!);
      if (!integrationHead) throw new StopRun("failed", "The integration worktree has no commits.");
      const wt = await ensureWorktree(deps.cwd, ticket.worktree, ticket.branch, integrationHead);
      if (wt.error) throw new StopRun("failed", `git worktree for ${ticket.id}: ${wt.error}`);
      if (!branchExists || !ticket.base) ticket.base = integrationHead;
    }
    ticket.base ??= await headCommit(ticket.worktree);
    this.save();
    return ticket.worktree;
  }

  /** Remove a ticket's worktree and branch (after it merged or was skipped). */
  private async dropTicketWorkspace(ticket: Ticket): Promise<void> {
    if (ticket.worktree) await removeWorktree(this.deps.cwd, ticket.worktree);
    if (ticket.branch) await deleteBranch(this.deps.cwd, ticket.branch);
    ticket.worktree = undefined;
    ticket.branch = undefined;
    ticket.base = undefined;
    this.save();
  }

  /** On (re)entering the build: drop worktrees left behind by settled tickets (crash, manual edits). */
  private async cleanupTicketWorkspaces(): Promise<void> {
    for (const ticket of this.state.tickets) {
      if ((ticket.status === "done" || ticket.status === "skipped") && (ticket.worktree || ticket.branch)) {
        await this.dropTicketWorkspace(ticket);
      }
    }
  }

  /** Changed files that still contain merge-conflict markers. */
  private conflictMarkers(dir: string, files: string[]): string[] {
    return files.filter((file) => {
      try {
        const full = path.join(dir, file);
        if (!fs.statSync(full).isFile() || fs.statSync(full).size > 2_000_000) return false;
        return /^(<{7}|>{7}) /m.test(fs.readFileSync(full, "utf8"));
      } catch {
        return false;
      }
    });
  }

  // -- QA-first (plan §10.1) -------------------------------------------------------

  private qaScope(ticket: Ticket): string[] {
    return ticket.writeScope.filter((glob) => TEST_GLOB.test(glob));
  }

  /**
   * Before the builder starts, the QA worker turns the acceptance criteria into
   * failing tests inside the ticket's test globs; the factory commits them on
   * the ticket branch so the builder implements against them.
   */
  private async qaFirst(ticket: Ticket, dir: string, profile: Profile): Promise<void> {
    if (ticket.qa) return;
    const scope = this.qaScope(ticket);
    const why = !this.settings.qa
      ? "disabled in settings"
      : !QA_ROLES.has(ticket.role)
        ? `${ticket.role} ticket`
        : ticket.acceptance.length === 0
          ? "no acceptance criteria"
          : scope.length === 0
            ? "no test globs in the write scope"
            : !this.deps.roles.has("qa") || !this.deps.team.members.qa
              ? "no qa role or model"
              : undefined;
    if (why) {
      ticket.qa = "skipped";
      this.save();
      this.ticketEvent(ticket, "qa", { result: "skipped", reason: why });
      return;
    }

    const result = await this.work("qa", { prompt: prompts.qaPrompt(ticket, profile, scope), cwd: dir, session: `${ticket.id}-qa`, writeScope: scope, ticket: ticket.id });
    if (result.isError) {
      await resetTo(dir, "HEAD");
      ticket.qa = "none";
      this.save();
      this.ticketEvent(ticket, "qa", { result: "error", error: truncate(result.errorMessage ?? "", 200) });
      return;
    }
    const changed = await changedSince(dir, "HEAD");
    const outside = outOfScope(changed, scope);
    if (outside.length) await revertToBase(dir, "HEAD", outside);
    const tests = changed.filter((file) => !outside.includes(file));
    if (tests.length === 0) {
      ticket.qa = "none";
      this.save();
      this.ticketEvent(ticket, "qa", { result: "no tests written" });
      return;
    }
    // Red check: the new tests should fail before the implementation exists.
    const gates = await this.ticketGates(dir, ticket, false, "qa");
    const commit = await commitAll(dir, `test(${ticket.id}): acceptance tests (QA)`);
    if (commit.error) throw new StopRun("failed", `git commit: ${commit.error}`);
    ticket.qa = "written";
    ticket.qaTests = tests;
    this.save();
    this.ticketEvent(ticket, "qa", { result: gates.ok ? "tests already pass" : "red", tests, reverted: outside.length ? outside : undefined });
  }

  // -- one ticket ----------------------------------------------------------------

  private async buildTicket(ticket: Ticket, startWith?: TeamMember): Promise<void> {
    const { deps, state } = this;
    const profile = this.profile();
    const role = this.role(ticket.role);
    ticket.status = "in_progress";
    this.save();
    this.inFlight.add(ticket.id);
    try {
      const dir = await this.ticketWorkspace(ticket);
      this.ticketEvent(ticket, "started", { branch: ticket.branch, base: ticket.base, model: startWith ? `${startWith.provider}/${startWith.modelId}` : undefined });
      await this.qaFirst(ticket, dir, profile);

      let current: TeamMember | undefined = startWith ?? this.member(ticket.role);
      let prompt = prompts.ticketPrompt(ticket, profile);
      const scope = this.scopeFor(ticket, profile);

      while (current) {
        for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_MODEL; attempt++) {
          const result = await this.work(ticket.role, { prompt, cwd: dir, session: ticket.id, writeScope: scope, member: current, ticket: ticket.id });
          const model = `${current.provider}/${current.modelId}`;
          const record = (outcome: Ticket["attempts"][number]["outcome"], note?: string) => {
            ticket.attempts.push({ model, outcome, costUsd: result.usage.cost.total, at: new Date().toISOString(), note });
            this.save();
            this.ticketEvent(ticket, "attempt", { attempt: ticket.attempts.length, model, outcome, note });
          };
          if (result.isError) {
            record("error", result.errorMessage);
            prompt = `Your previous run ended with an error: ${result.errorMessage}. Continue the ticket.`;
            continue;
          }

          // The ticket's change is everything that differs from its base (the last integration sync).
          const base = ticket.base!;
          const changed = await changedSince(dir, base);
          const outside = outOfScope(changed, scope);
          let scopeNote = "";
          if (outside.length > 0) {
            await revertToBase(dir, base, outside);
            scopeNote = prompts.scopeFeedback(outside, ticket.writeScope);
            this.ticketEvent(ticket, "scope_revert", { files: outside });
          }
          const withNote = (text: string) => (scopeNote ? `${text}\n\n${scopeNote}` : text);
          const inScope = changed.filter((file) => !outside.includes(file));

          const markers = this.conflictMarkers(dir, inScope);
          if (markers.length > 0) {
            record("conflict", `conflict markers left in ${markers.join(", ")}`);
            prompt = withNote(prompts.conflictPrompt(ticket, markers));
            continue;
          }

          const manifestsChanged = inScope.some((file) => profile.manifests.includes(path.basename(file)));
          const gates = await this.ticketGates(dir, ticket, manifestsChanged);
          if (!gates.ok) {
            record("gate_fail", truncate(describeGateFailure(gates.results), 200));
            prompt = withNote(prompts.gateFeedbackPrompt(ticket, describeGateFailure(gates.results)));
            continue;
          }

          const fullDiff = await workingDiff(dir, 400_000, base);
          const secrets = scanDiff(fullDiff);
          if (secrets.length > 0) {
            record("secret", truncate(describeSecrets(secrets), 200));
            prompt = withNote(prompts.secretFeedbackPrompt(ticket, describeSecrets(secrets)));
            continue;
          }

          const review = await this.review(ticket, dir, gates.results, fullDiff);
          if (review.verdict !== "approve") {
            record("review_fail", truncate(review.text, 200));
            prompt = withNote(prompts.reviewFeedbackPrompt(ticket, review.text));
            continue;
          }

          if (this.autonomy === "careful") {
            const changes = await this.approveTicket(ticket, inScope, gates.results);
            if (changes !== undefined) {
              prompt = prompts.reviewFeedbackPrompt(ticket, changes || "The user asked for changes.");
              continue;
            }
          }

          const commit = await commitAll(dir, `feat(${ticket.id}): ${ticket.title}`);
          if (commit.error) throw new StopRun("failed", `git commit: ${commit.error}`);

          const merged = await this.integrate(ticket, dir, profile);
          if (merged.kind === "conflict") {
            record("conflict", `merge conflict with integration: ${merged.files.join(", ")}`);
            prompt = prompts.conflictPrompt(ticket, merged.files);
            continue;
          }
          if (merged.kind === "integration_fail") {
            record("integration_fail", truncate(merged.failure, 200));
            prompt = prompts.integrationFeedbackPrompt(ticket, merged.failure);
            continue;
          }

          record("ok");
          ticket.status = "done";
          ticket.commit = merged.commit;
          this.save();
          await this.dropTicketWorkspace(ticket);
          this.ticketEvent(ticket, "done", { commit: merged.commit, attempts: ticket.attempts.length });
          deps.ui.log("ticket", { id: ticket.id, title: ticket.title, status: "done", attempts: ticket.attempts.length });
          return;
        }
        const next = escalate(deps.team, role, current);
        if (next) {
          deps.ui.notify(`${ticket.id}: escalating ${ticket.role} from ${current.modelId} to ${next.modelId}.`, "info");
          state.notes.push(`${ticket.id} escalated to ${next.provider}/${next.modelId}`);
          ticket.escalated = true;
          this.save();
          this.ticketEvent(ticket, "escalated", { from: `${current.provider}/${current.modelId}`, to: `${next.provider}/${next.modelId}` });
          await this.checkEscalationBreaker();
        }
        current = next;
      }

      const choice = await this.ask(`${ticket.id} (${ticket.title}) still fails after every model on the ${ticket.role} ladder.`, [
        "Retry with the strongest model",
        "Skip this ticket and continue",
        "Pause the factory (fix it yourself, then /factory resume)",
      ]);
      if (choice?.startsWith("Retry")) {
        ticket.status = "todo";
        return await this.buildTicket(ticket, this.strongest(ticket.role));
      }
      if (choice?.startsWith("Skip")) {
        ticket.status = "skipped";
        await this.dropTicketWorkspace(ticket);
        this.ticketEvent(ticket, "skipped");
        return;
      }
      ticket.status = "blocked";
      this.save();
      this.ticketEvent(ticket, "blocked");
      throw new StopRun("paused", `${ticket.id} is blocked. Worktree: ${dir}. Run /factory resume when ready.`);
    } finally {
      this.inFlight.delete(ticket.id);
    }
  }

  /** Careful autonomy: the user approves each ticket commit. Returns requested changes, or undefined when approved. */
  private approveTicket(ticket: Ticket, files: string[], gates: GateResult[]): Promise<string | undefined> {
    return this.uiLock.run(async () => {
      this.checkAbort();
      const title = `Commit ${ticket.id}: ${ticket.title}?`;
      const summary = `Files: ${files.slice(0, 12).join(", ")}${files.length > 12 ? " …" : ""}\nGates: ${summarizeGates(gates)}\nReview: approved`;
      this.deps.ui.log("approval", { title, summary });
      const choice = await this.deps.ui.select(`${title}\n\n${summary}`, ["Approve", "Request changes…", "Pause the factory"]);
      if (!choice || choice === "Pause the factory") throw new StopRun("paused", "Factory paused. Run /factory resume to continue.");
      if (choice === "Approve") return undefined;
      return (await this.deps.ui.input(`What should change in ${ticket.id}?`))?.trim() ?? "";
    });
  }

  // -- integration (plan §10.1) ----------------------------------------------------

  /**
   * Merge a finished ticket branch into the integration branch and re-run every
   * gate there. One merge at a time. A conflict, or red gates after the merge,
   * undoes the merge and brings the integration branch into the ticket branch
   * so the builder can resolve or reproduce it in its own worktree.
   */
  private integrate(ticket: Ticket, dir: string, profile: Profile): Promise<IntegrationResult> {
    return this.mergeLock.run(async () => {
      this.checkAbort();
      const integration = this.state.worktree!;
      for (let round = 0; round < 2; round++) {
        const before = (await headCommit(integration))!;
        const merge = await mergeBranch(integration, ticket.branch!, `Merge ${ticket.id}: ${ticket.title}`);
        if (!merge.ok) {
          this.ticketEvent(ticket, "conflict", { files: merge.conflicts, error: merge.conflicts.length ? undefined : truncate(merge.error ?? "", 200) });
          const left = await this.syncTicket(ticket, dir, before, profile);
          if (left === undefined) return { kind: "conflict", files: merge.conflicts.length ? merge.conflicts : ["(merge failed; see the ledger)"] };
          if (left.length > 0) return { kind: "conflict", files: left };
          // Every conflict was outside the ticket's scope and resolved to the integration side: merge again.
          continue;
        }
        const merged = await filesBetween(integration, before, "HEAD");
        const manifestsChanged = merged.some((file) => profile.manifests.includes(path.basename(file)));
        const gates = await this.gates(integration, { skipInstall: !manifestsChanged, ticket: ticket.id, where: "integration" });
        if (!gates.ok) {
          await resetTo(integration, before);
          await this.syncTicket(ticket, dir, before, profile);
          const failure = describeGateFailure(gates.results);
          this.ticketEvent(ticket, "integration_fail", { gate: gates.results.find((r) => !r.ok)?.gate });
          return { kind: "integration_fail", failure };
        }
        const commit = await headCommit(integration);
        this.ticketEvent(ticket, "merged", { commit, files: merged.length });
        return { kind: "merged", commit };
      }
      return { kind: "conflict", files: ["(the integration branch kept conflicting; see the ledger)"] };
    });
  }

  /**
   * Merge the integration branch (at `integrationHead`) into the ticket branch,
   * which becomes the ticket's new base. Conflicts outside the ticket's write
   * scope take the integration side; the in-scope ones are returned with their
   * markers left for the builder (a clean sync is committed). Undefined when
   * the merge could not even start.
   */
  private async syncTicket(ticket: Ticket, dir: string, integrationHead: string, profile: Profile): Promise<string[] | undefined> {
    const res = await mergeBranch(dir, integrationHead, `Merge integration into ${ticket.id}`, { keepConflicts: true });
    if (!res.ok && res.conflicts.length === 0) return undefined;
    ticket.base = integrationHead;
    this.save();
    if (res.ok) return [];
    const outside = outOfScope(res.conflicts, this.scopeFor(ticket, profile));
    for (const file of outside) {
      await git(dir, ["checkout", "--theirs", "--", file]);
      await git(dir, ["add", "--", file]);
    }
    const left = res.conflicts.filter((file) => !outside.includes(file));
    if (left.length === 0) {
      const commit = await commitAll(dir, `Merge integration into ${ticket.id}`);
      if (commit.error) return undefined;
    }
    return left;
  }

  private async review(ticket: Ticket, worktree: string, gates: GateResult[], fullDiff: string): Promise<{ verdict: "approve" | "changes"; text: string }> {
    const diff = fullDiff.length > 60_000 ? `${fullDiff.slice(0, 60_000)}\n… (diff truncated at 60000 chars)` : fullDiff;
    const reply = await this.workJson<{ verdict: "approve" | "changes"; findings: Array<{ severity: string; file?: string; issue: string }> }>(
      "reviewer",
      { prompt: prompts.reviewPrompt({ ticket, diff, gates }), cwd: worktree, session: `${ticket.id}-review`, writeScope: [] },
      (value) => {
        if (!value || (value.verdict !== "approve" && value.verdict !== "changes")) return { error: 'verdict must be "approve" or "changes"' };
        const findings = Array.isArray(value.findings) ? value.findings.filter((f: any) => f && typeof f.issue === "string") : [];
        return { value: { verdict: value.verdict, findings } };
      },
    );
    const blocking = reply.findings.filter((f) => f.severity === "blocking");
    const text = reply.findings.map((f) => `- [${f.severity}] ${f.file ? `${f.file}: ` : ""}${f.issue}`).join("\n") || "(no findings)";
    this.deps.store.write(`reviews/${ticket.id}-${ticket.attempts.length + 1}.md`, `# Review of ${ticket.id}\n\nVerdict: ${reply.verdict}\n\n${text}\n`);
    // A "changes" verdict without blocking findings is treated as approval.
    const verdict = reply.verdict === "changes" && blocking.length > 0 ? "changes" : "approve";
    this.ticketEvent(ticket, "review", { verdict, blocking: blocking.length, findings: reply.findings.length, model: `${this.member("reviewer").provider}/${this.member("reviewer").modelId}` });
    return { verdict, text };
  }

  // -- verification (plan §8 phase 7) ------------------------------------------

  /** Verification rounds started so far (persisted as hidden "verify:<n>" notes). */
  private verifyRounds(): number {
    return this.state.notes.filter((n) => /^verify:\d+$/.test(n)).length;
  }

  private hasWorker(role: string): boolean {
    return this.deps.roles.has(role) && Boolean(this.deps.team.members[role]);
  }

  /**
   * Integration and verification: every gate on the integrated build with a
   * fresh install, then a QA worker tries the software like a user. Bugs at or
   * above the severity threshold become bug tickets and the run goes back to
   * the build, at most qaRounds times; after that you decide (auto: release
   * with the bugs listed as known issues).
   */
  private async verify(): Promise<void> {
    const { deps, state } = this;
    const settings = this.settings;
    const worktree = await this.ensureWorkspace();
    const profile = this.profile();
    const round = this.verifyRounds() + 1;
    state.notes.push(`verify:${round}`);
    this.save();

    const opened: Ticket[] = [];
    const gates = await this.gates(worktree, { where: "integration" });
    if (!gates.ok) opened.push(integrationBugTicket(describeGateFailure(gates.results), state.tickets, round));

    // A red build is the bug; exploratory QA runs on a green one.
    let report: QaReport | undefined;
    if (gates.ok && settings.exploratoryQa && this.hasWorker("qa")) {
      const fixed = state.tickets.filter((t) => t.kind === "bug" && t.status === "done" && t.foundInRound === round - 1);
      const untrackedBefore = new Set(await untrackedFiles(worktree));
      report = await this.tryWorkJson(
        "qa",
        {
          prompt: prompts.exploratoryQaPrompt({ profile, tickets: state.tickets, requirements: this.requirementIdsFromSpec(), round, fixed }),
          cwd: worktree,
          session: `verify-${round}`,
          writeScope: [],
        },
        normalizeQaReport,
      );
      // QA must leave the integration tree as it found it.
      const leftovers = await restoreAfter(worktree, untrackedBefore);
      if (leftovers.length) deps.store.ledger({ kind: "verify-cleanup", runId: state.runId, round, removed: leftovers.slice(0, 50) });
      if (report) {
        const created = bugTickets(report, [...state.tickets, ...opened], settings.bugSeverity, round);
        opened.push(...created);
        deps.store.write(`qa/round-${round}.json`, JSON.stringify(report, null, 2));
        deps.store.write(`qa/round-${round}.md`, qaReportMarkdown(report, round, settings.bugSeverity, created));
        deps.ui.log("qa", { round, summary: report.summary, bugs: report.bugs.length, opened: created.map((t) => t.id) });
      } else {
        state.notes.push(`exploratory QA round ${round} returned no usable report`);
      }
    }
    deps.store.ledger({
      kind: "verify",
      runId: state.runId,
      round,
      gatesOk: gates.ok,
      bugs: report?.bugs.length,
      opened: opened.map((t) => t.id),
    });
    for (const t of opened) this.ticketEvent(t, "opened", { severity: t.severity, round });
    if (opened.length === 0) {
      deps.store.write("qa/open-bugs.json", "[]");
      this.save();
      return;
    }

    const list = opened.map((t) => `- ${t.severity}: ${t.title.replace(/^Fix: /, "")}`).join("\n");
    const loopBack = () => {
      state.tickets.push(...opened);
      state.phase = "build";
      this.save();
      deps.ui.notify(`Verification round ${round}: ${opened.length} bug ticket(s) (${opened.map((t) => t.id).join(", ")}); back to the build.`, "info");
    };
    if (round <= settings.qaRounds) return loopBack();

    let release = this.autonomy === "auto";
    if (!release) {
      const choice = await this.ask(
        `Verification still finds ${opened.length} bug(s) after ${round - 1} fix round(s):\n\n${list}`,
        ["Release with these as known issues", "Run another fix round", "Pause the factory"],
      );
      if (choice === "Run another fix round") return loopBack();
      if (choice !== "Release with these as known issues") throw new StopRun("paused", "Factory paused at verification. Run /factory resume to continue.");
      release = true;
    }
    const open: QaBug[] = opened.map((t) => ({ title: t.title.replace(/^Fix: /, ""), severity: t.severity ?? "major", steps: [], expected: "", actual: "" }));
    deps.store.write("qa/open-bugs.json", JSON.stringify(open, null, 2));
    state.notes.push(`released with ${open.length} known bug(s) after ${round - 1} fix round(s)`);
    this.save();
  }

  /** Requirement ids from the spec (for QA prompts and coverage). */
  private requirementIdsFromSpec(): string[] {
    return requirementIds(this.deps.store.read("spec/spec.md") ?? "");
  }

  private async docs(): Promise<void> {
    const { deps, state } = this;
    const worktree = await this.ensureWorkspace();
    const profile = this.profile();
    const ok = await this.writeDocs(worktree, prompts.docsPrompt({ settings: deps.answers, profile, tickets: state.tickets }), "docs: README, architecture, AGENTS.md and changelog");
    if (!ok) state.notes.push("docs step did not pass the gates; documentation left as generated by the skeleton");
    await this.contributorCheck(worktree, profile);
  }

  /** One documentation pass by the docs worker: docs files only, gates must still pass. */
  private async writeDocs(worktree: string, prompt: string, message: string): Promise<boolean> {
    const scope = ["README.md", "AGENTS.md", "CHANGELOG.md", "docs/**", "*.md"];
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.work("docs", {
        prompt: attempt === 0 ? prompt : "The gates failed after your documentation change. Revert anything that is not documentation and make sure the gates pass.",
        cwd: worktree,
        session: "docs",
        writeScope: scope,
      });
      if (result.isError) break;
      const changed = await changedFiles(worktree);
      const outside = outOfScope(changed, scope);
      if (outside.length) await this.revertOutOfScope(worktree, outside);
      const gates = await this.gates(worktree, { skipInstall: true });
      if (gates.ok) {
        await commitAll(worktree, message);
        return true;
      }
    }
    await git(worktree, ["reset", "--hard", "HEAD"]);
    return false;
  }

  /**
   * The M6 exit check: a fresh agent clones the build and, using only its
   * docs, sets it up, runs the tests and makes a small extension. The harness
   * re-runs the documented test commands and every gate in that clone. Gaps go
   * to the docs worker for one fix round, then the check runs once more. The
   * clone is thrown away; the result is reported, never fatal.
   */
  private async contributorCheck(worktree: string, profile: Profile): Promise<void> {
    const { deps, state } = this;
    if (!this.settings.contributorCheck) return;
    if (!this.hasWorker("contributor")) {
      state.notes.push("new-contributor check skipped: no contributor role or model");
      return;
    }
    const outcomes: ContributorOutcome[] = [];
    for (let round = 1; round <= 2; round++) {
      const clone = fs.mkdtempSync(path.join(os.tmpdir(), "factory-contributor-"));
      try {
        const cloned = await git(deps.cwd, ["clone", "--quiet", "--no-hardlinks", "--branch", state.branch!, deps.cwd, clone], 300_000);
        if (!cloned.ok) {
          state.notes.push(`new-contributor check skipped: git clone failed (${truncate(cloned.stderr.trim(), 200)})`);
          return;
        }
        this.showStatus(`new-contributor check · round ${round}`);
        const report = await this.tryWorkJson(
          "contributor",
          { prompt: prompts.contributorPrompt({ idea: state.idea }), cwd: clone, session: `contributor-${round}`, writeScope: ["**"] },
          normalizeContributorReport,
        );
        const timeout = deps.gateTimeoutMs ?? 10 * 60_000;
        const docCommands: ContributorOutcome["docCommands"] = [];
        for (const command of (report?.test ?? []).slice(0, 3)) {
          const blocked = blockedCommand(command, { cwd: clone });
          if (blocked) {
            docCommands.push({ command, ok: false, output: `not run: ${blocked}` });
            continue;
          }
          const run = await runCommand(command, clone, timeout);
          docCommands.push({ command, ok: run.code === 0, output: truncate(run.output, 600) });
        }
        const gates = await runGates(profile, clone, { timeoutMs: deps.gateTimeoutMs });
        const outcome = judgeContributor({
          round,
          report,
          docCommands,
          gatesOk: gatesPassed(gates, profile),
          gatesSummary: summarizeGates(gates),
          changedFiles: await changedFiles(clone),
        });
        outcomes.push(outcome);
        deps.store.ledger({ kind: "contributor", runId: state.runId, round, passed: outcome.passed, reasons: outcome.reasons });
      } finally {
        fs.rmSync(clone, { recursive: true, force: true });
      }
      deps.store.write("contributor.md", contributorMarkdown(outcomes));
      deps.store.write("contributor.json", JSON.stringify(outcomes.at(-1), null, 2));
      const last = outcomes.at(-1)!;
      deps.ui.log("contributor", { round, passed: last.passed, reasons: last.reasons });
      if (last.passed || round === 2 || !last.report) break;
      const fixed = await this.writeDocs(
        worktree,
        prompts.docsGapPrompt({ reasons: last.reasons, gaps: last.report.gaps }),
        "docs: fix gaps found by the new-contributor check",
      );
      if (!fixed) break;
    }
  }

  private async release(): Promise<void> {
    const { deps, state } = this;
    const worktree = await this.ensureWorkspace();
    const final = await this.gates(worktree);
    // Last secret scan over everything the factory branch adds, before it reaches the user's branch.
    const secrets = state.baseCommit ? scanDiff(await commitDiff(worktree, state.baseCommit, "HEAD")) : [];
    if (secrets.length) {
      state.notes.push(`not merged: the secret scan found ${secrets.length} likely credential(s):\n${describeSecrets(secrets)}`);
      deps.ui.notify(`Secret scan: ${secrets.length} likely credential(s) on ${state.branch}; not merging. See .factory/report.md.`, "warning");
    }
    const done = state.tickets.filter((t) => t.status === "done").length;
    const skipped = state.tickets.filter((t) => t.status === "skipped").map((t) => t.id);
    const version = projectVersion(worktree);
    const verification = this.verificationResults();
    const fixedBugs = state.tickets.filter((t) => t.kind === "bug" && t.status === "done").length;
    const summary = [
      `${done}/${state.tickets.length} tickets delivered${skipped.length ? ` (skipped: ${skipped.join(", ")})` : ""}.`,
      `Gates on the final build: ${summarizeGates(final.results)}`,
      `Exploratory QA: ${verification.rounds} round(s), ${fixedBugs} bug(s) fixed, ${verification.openBugs.length} known issue(s)`,
      `New-contributor check: ${verification.contributor ? (verification.contributor.passed ? "passed" : `failed (${verification.contributor.reasons.join("; ")})`) : "not run"}`,
      `Secret scan: ${secrets.length ? `${secrets.length} finding(s)` : "clean"}`,
      `Spent: ${this.budgetLine()}.`,
      `Version: ${version} · Branch: ${state.branch}${state.baseBranch ? ` → merge into ${state.baseBranch}` : ""}`,
    ].join("\n");

    let merged = false;
    if (state.baseBranch && final.ok && secrets.length === 0) {
      const onBase = (await currentBranch(deps.cwd)) === state.baseBranch;
      const clean = await isClean(deps.cwd);
      let go = this.autonomy !== "careful";
      if (!go) go = (await this.approve("Merge the build into your branch?", summary, ["Keep it on the factory branch"])) === "Approve";
      if (go && onBase && clean) {
        const res = await mergeInto(deps.cwd, state.branch!, `Merge ${state.branch}: ${truncate(state.idea, 60)}`);
        merged = res.ok;
        if (!res.ok) state.notes.push(`merge failed: ${res.error}`);
      } else if (go) {
        state.notes.push(`not merged: ${!onBase ? `you are not on ${state.baseBranch}` : "your working tree has uncommitted changes"}`);
      }
    }

    if (deps.answers.deploy === "deploy" && final.ok) {
      const target = deps.answers.deployTarget ?? "the chosen target";
      const ok = await deps.ui.confirm("Deploy now?", `Deploy to ${target} with your logged-in CLI? This can create billable resources.`);
      if (ok) {
        const result = await this.work("devops", {
          prompt: prompts.deployPrompt({ target, profile: this.profile() }),
          cwd: merged ? deps.cwd : worktree,
          session: "deploy",
          writeScope: ["fly.toml", "vercel.json", "netlify.toml", "wrangler.toml", "railway.json", "render.yaml", "app.yaml", ".env.example", "Dockerfile", "deploy/**", "infra/**"],
          allowDeploy: true,
        });
        state.notes.push(`deploy: ${truncate(result.isError ? `failed — ${result.errorMessage}` : result.text, 300)}`);
      }
    }

    // Release notes, a local version tag, then the retrospective (plan §8 phases 8–9).
    deps.store.write(
      "release-notes.md",
      releaseNotes({ state, version, gatesSummary: summarizeGates(final.results), qaRounds: verification.rounds, openBugs: verification.openBugs, contributor: verification.contributor }),
    );
    let tag: string | undefined;
    if (this.settings.tagRelease && final.ok && secrets.length === 0) {
      tag = await this.tagRelease(merged ? deps.cwd : worktree, `v${version}`);
    }
    if (merged) await removeWorktree(deps.cwd, worktree);
    const report = this.report(`${summary}${tag ? `\nTag: ${tag}` : ""}`, merged, final.ok);
    deps.store.write("report.md", report);
    deps.store.write(
      "retro.md",
      retrospective({
        state,
        ledger: deps.store.readLedger(),
        merged,
        gatesOk: final.ok,
        qaRounds: verification.rounds,
        openBugs: verification.openBugs,
        minorBugs: verification.minorBugs,
        untested: verification.untested,
        contributor: verification.contributor,
      }),
    );
    deps.ui.log("report", { text: report });
    deps.ui.notify(
      `${merged ? `Factory done: merged into ${state.baseBranch}` : `Factory done. The build is on branch ${state.branch}`}${tag ? `, tagged ${tag}` : ""}. ` +
        "Report: .factory/report.md · Release notes: .factory/release-notes.md · Retrospective: .factory/retro.md",
      "info",
    );
  }

  /** Results of verification and the new-contributor check, read back from .factory/. */
  private verificationResults(): { rounds: number; openBugs: QaBug[]; minorBugs: QaBug[]; untested: string[]; contributor?: ContributorOutcome } {
    const { store } = this.deps;
    const parse = <T>(rel: string): T | undefined => {
      try {
        const raw = store.read(rel);
        return raw ? (JSON.parse(raw) as T) : undefined;
      } catch {
        return undefined;
      }
    };
    const rounds = this.verifyRounds();
    const last = rounds > 0 ? parse<QaReport>(`qa/round-${rounds}.json`) : undefined;
    const threshold = this.settings.bugSeverity;
    const below = (b: QaBug) => b.severity === "minor" && threshold !== "minor";
    return {
      rounds,
      openBugs: parse<QaBug[]>("qa/open-bugs.json") ?? [],
      minorBugs: (last?.bugs ?? []).filter(below),
      untested: (last?.checks ?? []).filter((c) => c.result === "untested").map((c) => c.requirement),
      contributor: parse<ContributorOutcome>("contributor.json"),
    };
  }

  /** Lightweight local tag; never moves an existing tag and never pushes. */
  private async tagRelease(repo: string, name: string): Promise<string | undefined> {
    const exists = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/tags/${name}`]);
    if (exists.ok) {
      this.state.notes.push(`not tagged: ${name} already exists`);
      return undefined;
    }
    const res = await git(repo, ["tag", name, "HEAD"]);
    if (!res.ok) {
      this.state.notes.push(`not tagged: ${truncate(res.stderr.trim(), 200)}`);
      return undefined;
    }
    return name;
  }

  report(summary: string, merged: boolean, gatesOk: boolean): string {
    const ledger = this.deps.store.readLedger().filter((e) => e.kind === "worker");
    const byRole = new Map<string, { cost: number; tokens: number; runs: number; model: string }>();
    for (const entry of ledger) {
      const row = byRole.get(entry.role) ?? { cost: 0, tokens: 0, runs: 0, model: entry.model };
      row.cost += entry.costUsd ?? 0;
      row.tokens += entry.tokens ?? 0;
      row.runs += 1;
      row.model = entry.model;
      byRole.set(entry.role, row);
    }
    const lines = [
      `# Factory report — ${this.state.runId}`,
      "",
      `Idea: ${this.state.idea}`,
      "",
      summary,
      `Merged: ${merged ? "yes" : "no"} · Final gates: ${gatesOk ? "passing" : "FAILING"}`,
      "",
      "## Tickets",
      "",
      ...this.state.tickets.map(
        (t) =>
          `- ${t.status === "done" ? "✓" : t.status === "skipped" ? "–" : "✗"} ${t.id} ${t.title}${t.kind === "bug" ? ` [${t.severity ?? "bug"}, QA round ${t.foundInRound ?? "?"}]` : ""} (${t.attempts.length} attempt${t.attempts.length === 1 ? "" : "s"})`,
      ),
      "",
      "## Cost by role",
      "",
      "| Role | Model | Runs | Tokens | Cost |",
      "|---|---|---|---|---|",
      ...[...byRole.entries()].map(([role, r]) => `| ${role} | ${r.model} | ${r.runs} | ${formatTokens(r.tokens)} | ${formatCost(r.cost)} |`),
    ];
    const visibleNotes = this.state.notes.filter((n) => !n.includes(":written") && !/^brainstorm:\d+$/.test(n) && !/^verify:\d+$/.test(n) && !n.startsWith("breaker:"));
    if (visibleNotes.length) {
      lines.push("", "## Notes", "", ...visibleNotes.map((n) => `- ${n}`));
    }
    const extras = [
      ["qa", "Exploratory QA reports: .factory/qa/"],
      ["contributor.md", "New-contributor check: .factory/contributor.md"],
      ["release-notes.md", "Release notes: .factory/release-notes.md"],
    ].filter(([rel]) => fs.existsSync(this.deps.store.path(rel)));
    lines.push("", "## More", "", ...extras.map(([, label]) => `- ${label}`), "- Retrospective: .factory/retro.md");
    return `${lines.join("\n")}\n`;
  }
}
