/**
 * The factory pipeline: a resumable phase machine that drives role workers.
 *
 *   discovery → spec → architecture → planning → skeleton → build → docs → release → done
 *
 * Every step persists to .factory/ before moving on, so a run can pause (user
 * choice, budget breaker, blocker, abort) and resume later from the same phase.
 * Human gates follow the autonomy preset; "done" is decided by the profile's
 * gate commands and the reviewer, never by a worker's own claim.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { truncate } from "../shared/text.js";
import { formatCost, formatTokens } from "../shared/usage.js";
import { outOfScope } from "./guard.js";
import { describeGateFailure, gatesPassed, normalizeProfile, runGates, summarizeGates } from "./gates.js";
import {
  changedFiles,
  commitAll,
  currentBranch,
  ensureRepo,
  ensureWorktree,
  git,
  headCommit,
  isClean,
  mergeInto,
  removeWorktree,
  workingDiff,
} from "./git.js";
import { extractJson } from "./json-reply.js";
import { requirementIds, validatePlan } from "./plan.js";
import * as prompts from "./prompts.js";
import { estimateSize } from "./settings.js";
import type { FactoryStore } from "./store.js";
import { escalate } from "./team.js";
import type { Team } from "./team.js";
import type {
  Answer,
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
import { PHASE_ORDER } from "./types.js";

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

/** Tickets in dependency order (stable for already-ordered plans). */
export function orderTickets(tickets: Ticket[]): Ticket[] {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const out: Ticket[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (t: Ticket) => {
    if (done.has(t.id) || visiting.has(t.id)) return;
    visiting.add(t.id);
    for (const dep of t.dependsOn) {
      const d = byId.get(dep);
      if (d) visit(d);
    }
    visiting.delete(t.id);
    done.add(t.id);
    out.push(t);
  };
  tickets.forEach(visit);
  return out;
}

export class FactoryRun {
  private activity: string[] = [];

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
    if (this.deps.signal?.aborted) throw new StopRun("paused", "Factory paused. Run /factory resume to continue.");
  }

  private get autonomy() {
    return this.deps.answers.autonomy;
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
    const lines = [`🏭 factory · ${label}${tickets} · ${this.budgetLine()}`];
    if (extra) lines.push(extra);
    for (const line of this.activity.slice(-3)) lines.push(`   ${line}`);
    deps.ui.widget(state.status === "done" ? undefined : lines);
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

  /** Stop at the budget breaker (80%) and ask to raise it or pause. */
  private async checkBudget(): Promise<void> {
    const { state, deps } = this;
    const overUsd = state.budgetUsd > 0 && state.spentUsd >= state.budgetUsd * 0.8;
    const overTokens = state.budgetTokens > 0 && state.spentTokens >= state.budgetTokens * 0.8;
    if (!overUsd && !overTokens) return;
    const spent = overUsd ? `${formatCost(state.spentUsd)} of $${state.budgetUsd}` : `${formatTokens(state.spentTokens)} of ${formatTokens(state.budgetTokens)} tokens`;
    const choice = await deps.ui.select(`Budget: ${spent} used (${state.phase}). Continue?`, [
      "Raise the budget by 50% and continue",
      "Pause the factory",
    ]);
    if (choice?.startsWith("Raise")) {
      if (overUsd) state.budgetUsd = Math.ceil(state.budgetUsd * 1.5);
      if (overTokens) state.budgetTokens = Math.ceil(state.budgetTokens * 1.5);
      this.save();
      return;
    }
    throw new StopRun("paused", "Factory paused at the budget limit. Run /factory resume to continue.");
  }

  async work(
    roleName: string,
    options: { prompt: string; cwd: string; session: string; writeScope: string[]; member?: TeamMember; allowDeploy?: boolean; ticket?: string },
  ): Promise<WorkerResult> {
    this.checkAbort();
    await this.checkBudget();
    const role = this.role(roleName);
    const member = options.member ?? this.member(roleName);
    this.activity = [];
    this.showStatus(`${roleName} · ${member.provider}/${member.modelId}${options.ticket ? ` · ${options.ticket}` : ""}`);
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
      signal: this.deps.signal,
      onActivity: (line) => {
        this.activity.push(`${roleName}: ${line}`);
        if (this.activity.length > 20) this.activity.shift();
        this.showStatus(`${roleName} · ${member.provider}/${member.modelId}${options.ticket ? ` · ${options.ticket}` : ""}`);
      },
    });
    this.state.spentUsd += result.usage.cost.total;
    this.state.spentTokens += result.usage.totalTokens;
    this.save();
    this.deps.store.ledger({
      kind: "worker",
      phase: this.state.phase,
      role: roleName,
      model: `${member.provider}/${member.modelId}`,
      ticket: options.ticket,
      turns: result.turns,
      tokens: result.usage.totalTokens,
      costUsd: result.usage.cost.total,
      ok: !result.isError,
      error: result.errorMessage,
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
    let prompt = options.prompt;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await this.work(roleName, { ...options, prompt });
      if (result.isError) {
        if (attempt < 2) continue;
        throw new StopRun("failed", `The ${roleName} worker failed: ${result.errorMessage}`);
      }
      const parsed = extractJson(result.text);
      const checked = parsed.error ? { error: parsed.error } : validate(parsed.value);
      if (checked.value !== undefined && !checked.error) return checked.value;
      prompt = `Your reply could not be used: ${checked.error}\nReply again with only the corrected fenced json block.`;
    }
    throw new StopRun("failed", `The ${roleName} worker did not return usable JSON after 3 attempts.`);
  }

  private async approve(title: string, summary: string, extraOptions: string[] = []): Promise<string> {
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

    while (state.interviewRounds < maxRounds && !useDefaults) {
      const round = state.interviewRounds + 1;
      const reply = await this.workJson<{ ready: boolean; questions: Question[] }>(
        "analyst",
        {
          prompt: prompts.interviewPrompt({ idea: state.idea, settings: deps.answers, answers: state.answers, round, maxRounds }),
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
          return { value: { ready: value.ready === true || questions.length === 0, questions } };
        },
      );
      state.interviewRounds = round;
      if (reply.ready) {
        this.save();
        break;
      }

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
      this.save();
    }

    deps.store.write("spec/decisions.md", prompts.decisionsMarkdown(state.idea, state.answers));

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
      const assumptions = (deps.store.read("spec/assumptions.md") ?? "").split("\n").filter((l) => l.trim().startsWith("-")).length;
      const summary = [
        `${ids.filter((id) => id.startsWith("FR-")).length} functional and ${ids.filter((id) => id.startsWith("NFR-")).length} non-functional requirements; ${assumptions} assumptions.`,
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
            : "The file .factory/spec/spec.md is missing or has no FR-xxx requirements with Given/When/Then acceptance criteria. Write it now as instructed.",
        cwd: deps.cwd,
        session: "analyst",
        writeScope: [".factory/spec/**"],
      });
      if (result.isError) throw new StopRun("failed", `The analyst failed to write the spec: ${result.errorMessage}`);
      const spec = deps.store.read("spec/spec.md") ?? "";
      if (/\bFR-\d+/.test(spec) && /\bGiven\b/i.test(spec)) {
        if (!this.state.notes.includes("spec:written")) this.state.notes.push("spec:written");
        this.save();
        return;
      }
    }
    throw new StopRun("failed", "The analyst did not produce a valid .factory/spec/spec.md.");
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
    const profile = await this.workJson<Profile>(
      "architect",
      {
        prompt: prompts.architecturePrompt({
          settings: deps.answers,
          researchPath: deps.store.read("research/notes.md") ? ".factory/research/notes.md" : undefined,
          feedback,
        }),
        cwd: deps.cwd,
        session: "architect",
        writeScope: [".factory/adr/**"],
      },
      (value) => {
        const res = normalizeProfile(value);
        if (res.error) return { error: res.error };
        if (!deps.store.read("adr/0001-architecture.md")) return { error: "write .factory/adr/0001-architecture.md before replying" };
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
      if (state.tickets.length === 0 || feedback) {
        const ids = requirementIds(deps.store.read("spec/spec.md") ?? "");
        const tickets = await this.workJson<Ticket[]>(
          "planner",
          { prompt: prompts.planningPrompt({ profile, feedback }), cwd: deps.cwd, session: "planner", writeScope: [] },
          (value) => {
            const check = validatePlan(value, ids);
            return check.errors.length ? { error: check.errors.join("; ") } : { value: check.tickets };
          },
        );
        state.tickets = orderTickets(tickets);
        deps.store.write("tickets.json", JSON.stringify(state.tickets, null, 2));
        this.save();
      }
      if (this.autonomy === "auto") return;

      const summary = [
        `Stack: ${profile.stack}`,
        `Gates: ${profile.gates.map((g) => `${g.name} (\`${g.command}\`)`).join(", ")}`,
        `${state.tickets.length} tickets:`,
        ...state.tickets.slice(0, 15).map((t) => `  ${t.id} [${t.role}] ${t.title}`),
        state.tickets.length > 15 ? `  … and ${state.tickets.length - 15} more (.factory/tickets.json)` : "",
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
    const copies: Array<[string, string]> = [
      ["spec/spec.md", "docs/spec.md"],
      ["adr/0001-architecture.md", "docs/adr/0001-architecture.md"],
    ];
    for (const [from, to] of copies) {
      const text = store.read(from);
      if (!text) continue;
      const target = path.join(worktree, to);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
  }

  private profile(): Profile {
    const profile = this.deps.store.loadProfile();
    if (!profile) throw new StopRun("failed", "No stack profile found.");
    return profile;
  }

  private async gates(worktree: string, options: { skipInstall?: boolean } = {}): Promise<{ ok: boolean; results: GateResult[] }> {
    const profile = this.profile();
    this.showStatus("running gates");
    const results = await runGates(profile, worktree, { skipInstall: options.skipInstall, timeoutMs: this.deps.gateTimeoutMs });
    const ok = gatesPassed(results, profile, options.skipInstall);
    this.deps.store.ledger({ kind: "gates", phase: this.state.phase, ok, summary: summarizeGates(results) });
    this.deps.ui.log("gates", { ok, summary: summarizeGates(results) });
    return { ok, results };
  }

  private async skeleton(): Promise<void> {
    const { deps } = this;
    const worktree = await this.ensureWorkspace();
    this.copyDocsInto(worktree);
    const profile = this.profile();
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

  private async build(): Promise<void> {
    const worktree = await this.ensureWorkspace();
    for (const ticket of orderTickets(this.state.tickets)) {
      if (ticket.status === "done" || ticket.status === "skipped") continue;
      const blocked = ticket.dependsOn.filter((dep) => this.state.tickets.find((t) => t.id === dep)?.status !== "done");
      if (blocked.length > 0) {
        this.state.notes.push(`${ticket.id} built without unfinished dependencies: ${blocked.join(", ")}`);
      }
      await this.buildTicket(ticket, worktree);
    }
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

  private async buildTicket(ticket: Ticket, worktree: string, startWith?: TeamMember): Promise<void> {
    const { deps, state } = this;
    const profile = this.profile();
    const role = this.role(ticket.role);
    ticket.status = "in_progress";
    this.save();

    let current: TeamMember | undefined = startWith ?? this.member(ticket.role);
    let prompt = prompts.ticketPrompt(ticket, profile);
    const scope = this.scopeFor(ticket, profile);

    while (current) {
      for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_MODEL; attempt++) {
        const result = await this.work(ticket.role, { prompt, cwd: worktree, session: ticket.id, writeScope: scope, member: current, ticket: ticket.id });
        const model = `${current.provider}/${current.modelId}`;
        const record = (outcome: Ticket["attempts"][number]["outcome"], note?: string) => {
          ticket.attempts.push({ model, outcome, costUsd: result.usage.cost.total, at: new Date().toISOString(), note });
          this.save();
        };
        if (result.isError) {
          record("error", result.errorMessage);
          prompt = `Your previous run ended with an error: ${result.errorMessage}. Continue the ticket.`;
          continue;
        }

        const changed = await changedFiles(worktree);
        const outside = outOfScope(changed, scope);
        let scopeNote = "";
        if (outside.length > 0) {
          await this.revertOutOfScope(worktree, outside);
          scopeNote = prompts.scopeFeedback(outside, ticket.writeScope);
        }
        const manifestsChanged = changed.some((file) => profile.manifests.includes(path.basename(file)));
        const gates = await this.gates(worktree, { skipInstall: !manifestsChanged });
        if (!gates.ok) {
          record("gate_fail", truncate(describeGateFailure(gates.results), 200));
          prompt = `${prompts.gateFeedbackPrompt(ticket, describeGateFailure(gates.results))}${scopeNote ? `\n\n${scopeNote}` : ""}`;
          continue;
        }

        const review = await this.review(ticket, worktree, gates.results);
        if (review.verdict !== "approve") {
          record("review_fail", truncate(review.text, 200));
          prompt = `${prompts.reviewFeedbackPrompt(ticket, review.text)}${scopeNote ? `\n\n${scopeNote}` : ""}`;
          continue;
        }

        if (this.autonomy === "careful") {
          const files = await changedFiles(worktree);
          const choice = await this.approve(`Commit ${ticket.id}: ${ticket.title}?`, `Files: ${files.slice(0, 12).join(", ")}${files.length > 12 ? " …" : ""}\nGates: ${summarizeGates(gates.results)}\nReview: approved`, ["Request changes…"]);
          if (choice !== "Approve") {
            const typed = (await deps.ui.input(`What should change in ${ticket.id}?`))?.trim();
            prompt = prompts.reviewFeedbackPrompt(ticket, typed || "The user asked for changes.");
            continue;
          }
        }

        const commit = await commitAll(worktree, `feat(${ticket.id}): ${ticket.title}`);
        if (commit.error) throw new StopRun("failed", `git commit: ${commit.error}`);
        record("ok");
        ticket.status = "done";
        ticket.commit = commit.commit;
        this.save();
        deps.ui.log("ticket", { id: ticket.id, title: ticket.title, status: "done", attempts: ticket.attempts.length });
        return;
      }
      const next = escalate(deps.team, role, current);
      if (next) {
        deps.ui.notify(`${ticket.id}: escalating ${ticket.role} from ${current.modelId} to ${next.modelId}.`, "info");
        state.notes.push(`${ticket.id} escalated to ${next.provider}/${next.modelId}`);
      }
      current = next;
    }

    const choice = await deps.ui.select(`${ticket.id} (${ticket.title}) still fails after every model on the ${ticket.role} ladder.`, [
      "Retry with the strongest model",
      "Skip this ticket and continue",
      "Pause the factory (fix it yourself, then /factory resume)",
    ]);
    if (choice?.startsWith("Retry")) {
      ticket.status = "todo";
      return this.buildTicket(ticket, worktree, this.strongest(ticket.role));
    }
    if (choice?.startsWith("Skip")) {
      await git(worktree, ["reset", "--hard", "HEAD"]);
      await git(worktree, ["clean", "-fd"]);
      ticket.status = "skipped";
      this.save();
      return;
    }
    ticket.status = "blocked";
    throw new StopRun("paused", `${ticket.id} is blocked. Worktree: ${worktree}. Run /factory resume when ready.`);
  }

  private async review(ticket: Ticket, worktree: string, gates: GateResult[]): Promise<{ verdict: "approve" | "changes"; text: string }> {
    const diff = await workingDiff(worktree);
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
    return { verdict: reply.verdict === "changes" && blocking.length > 0 ? "changes" : "approve", text };
  }

  private async docs(): Promise<void> {
    const { deps, state } = this;
    const worktree = await this.ensureWorkspace();
    const profile = this.profile();
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.work("docs", {
        prompt: attempt === 0 ? prompts.docsPrompt({ settings: deps.answers, profile, tickets: state.tickets }) : "The gates failed after your documentation change. Revert anything that is not documentation and make sure the gates pass.",
        cwd: worktree,
        session: "docs",
        writeScope: ["README.md", "AGENTS.md", "CHANGELOG.md", "docs/**", "*.md"],
      });
      if (result.isError) break;
      const changed = await changedFiles(worktree);
      const outside = outOfScope(changed, ["README.md", "AGENTS.md", "CHANGELOG.md", "docs/**", "*.md"]);
      if (outside.length) await this.revertOutOfScope(worktree, outside);
      const gates = await this.gates(worktree, { skipInstall: true });
      if (gates.ok) {
        await commitAll(worktree, "docs: README, architecture, AGENTS.md and changelog");
        return;
      }
    }
    await git(worktree, ["reset", "--hard", "HEAD"]);
    state.notes.push("docs step did not pass the gates; documentation left as generated by the skeleton");
  }

  private async release(): Promise<void> {
    const { deps, state } = this;
    const worktree = await this.ensureWorkspace();
    const final = await this.gates(worktree);
    const done = state.tickets.filter((t) => t.status === "done").length;
    const skipped = state.tickets.filter((t) => t.status === "skipped").map((t) => t.id);
    const summary = [
      `${done}/${state.tickets.length} tickets delivered${skipped.length ? ` (skipped: ${skipped.join(", ")})` : ""}.`,
      `Gates on the final build: ${summarizeGates(final.results)}`,
      `Spent: ${this.budgetLine()}.`,
      `Branch: ${state.branch}${state.baseBranch ? ` → merge into ${state.baseBranch}` : ""}`,
    ].join("\n");

    let merged = false;
    if (state.baseBranch && final.ok) {
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

    if (merged) await removeWorktree(deps.cwd, worktree);
    const report = this.report(summary, merged, final.ok);
    deps.store.write("report.md", report);
    deps.ui.log("report", { text: report });
    deps.ui.notify(
      merged
        ? `Factory done: merged into ${state.baseBranch}. Report: .factory/report.md`
        : `Factory done. The build is on branch ${state.branch}. Report: .factory/report.md`,
      "info",
    );
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
      ...this.state.tickets.map((t) => `- ${t.status === "done" ? "✓" : t.status === "skipped" ? "–" : "✗"} ${t.id} ${t.title} (${t.attempts.length} attempt${t.attempts.length === 1 ? "" : "s"})`),
      "",
      "## Cost by role",
      "",
      "| Role | Model | Runs | Tokens | Cost |",
      "|---|---|---|---|---|",
      ...[...byRole.entries()].map(([role, r]) => `| ${role} | ${r.model} | ${r.runs} | ${formatTokens(r.tokens)} | ${formatCost(r.cost)} |`),
    ];
    if (this.state.notes.filter((n) => !n.includes(":written")).length) {
      lines.push("", "## Notes", "", ...this.state.notes.filter((n) => !n.includes(":written")).map((n) => `- ${n}`));
    }
    return `${lines.join("\n")}\n`;
  }
}
