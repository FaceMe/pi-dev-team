/** Core types for the software factory. */

import type { Usage } from "@earendil-works/pi-ai";
import type { GateFailureDetails } from "./gate-parse.js";
import type { Readiness } from "./readiness.js";
import type { EffortLevel } from "../shared/models.js";
import type { Tier } from "../shared/tiers.js";
import type { TraceStep } from "../shared/trace.js";

export type Autonomy = "auto" | "balanced" | "careful";

export type Phase =
  | "setup"
  | "discovery"
  | "spec"
  | "architecture"
  | "planning"
  | "skeleton"
  | "build"
  | "docs"
  | "release"
  | "done";

export const PHASE_ORDER: readonly Phase[] = [
  "setup",
  "discovery",
  "spec",
  "architecture",
  "planning",
  "skeleton",
  "build",
  "docs",
  "release",
  "done",
];

/** A role definition, loaded from Markdown with frontmatter. */
export interface RoleDef {
  name: string;
  description: string;
  tier: Tier;
  /** Pin to "provider/modelId" instead of a tier. */
  model?: string;
  effort?: EffortLevel;
  /** Tiers to climb on repeated failure. */
  escalation: Tier[];
  tools: string[];
  /** Never routed below its tier (judgement roles). */
  judgement: boolean;
  /** Give this worker its own Fusion sidekick. */
  sidekick: boolean;
  /** Prefer a different model family from the builders (reviewer). */
  reviewDiversity: boolean;
  systemPrompt: string;
  source: "builtin" | "user" | "project";
}

/** A role resolved to a concrete model. */
export interface TeamMember {
  role: string;
  provider: string;
  modelId: string;
  effort?: EffortLevel;
  tier: Tier;
  family: string;
}

export type TeamPreset = "balanced" | "cheap" | "best";

export type ProjectMode = "new" | "existing";
export type ResearchMode = "web-access" | "install-web-access" | "off";
export type DeployMode = "none" | "config" | "deploy";

/**
 * Run-scoped settings, snapshotted into the lock when a run starts so a resume
 * reproduces the run's own answers. The team (preset and pins) is deliberately
 * not snapshotted: it is re-derived from the models logged in at resume time.
 */
export interface RunSettings {
  autonomy: Autonomy;
  projectMode: ProjectMode;
  stack: string;
  research: ResearchMode;
  deploy: DeployMode;
  deployTarget?: string;
}

/** The run-scoped keys of SetupAnswers. */
export function runSettings(answers: SetupAnswers): RunSettings {
  return {
    autonomy: answers.autonomy,
    projectMode: answers.projectMode,
    stack: answers.stack,
    research: answers.research,
    deploy: answers.deploy,
    deployTarget: answers.deployTarget,
  };
}

/** Answers to the quick setup questions. */
export interface SetupAnswers {
  teamPreset: TeamPreset;
  /** Per-role pins chosen with the picker: role -> provider/modelId[:effort]. */
  pins: Record<string, { provider: string; modelId: string; effort?: EffortLevel }>;
  autonomy: Autonomy;
  projectMode: ProjectMode;
  /** Free text; "auto" lets the architect choose. */
  stack: string;
  research: ResearchMode;
  deploy: DeployMode;
  /** Deploy target when deploy === "deploy" (e.g. "fly", "vercel", or free text). */
  deployTarget?: string;
  /** Dollar budget; 0 = no limit. */
  budgetUsd: number;
  /** Token budget used when prices are unknown; 0 = no limit. */
  budgetTokens: number;
  /** Build-loop tuning (plan §10.2, §10.4); read from project.json or factory.json, never asked. */
  build?: Partial<BuildSettings>;
}

/** Build-loop tuning; see buildSettings() for the defaults. */
export interface BuildSettings {
  /** Tickets built at the same time (dependencies and write scopes permitting). */
  maxParallel: number;
  /** Fraction of the budget at which the breaker pauses and asks. */
  budgetBreaker: number;
  /** Fraction of tickets that may escalate before the breaker asks. */
  escalationBreaker: number;
  /** A QA worker writes failing acceptance tests before the builder starts. */
  qa: boolean;
}

export const DEFAULT_BUILD_SETTINGS: BuildSettings = { maxParallel: 3, budgetBreaker: 0.8, escalationBreaker: 0.3, qa: true };

/** Normalise build settings: out-of-range values fall back to the defaults. */
export function buildSettings(raw: Partial<BuildSettings> | undefined): BuildSettings {
  const d = DEFAULT_BUILD_SETTINGS;
  const fraction = (v: unknown, fallback: number) => (typeof v === "number" && v > 0 && v <= 1 ? v : fallback);
  const parallel = raw?.maxParallel;
  return {
    maxParallel: typeof parallel === "number" && Number.isInteger(parallel) && parallel >= 1 ? Math.min(parallel, 16) : d.maxParallel,
    budgetBreaker: fraction(raw?.budgetBreaker, d.budgetBreaker),
    escalationBreaker: fraction(raw?.escalationBreaker, d.escalationBreaker),
    qa: typeof raw?.qa === "boolean" ? raw.qa : d.qa,
  };
}

export interface Question {
  id: string;
  question: string;
  why?: string;
  options: string[];
  /** Index into options of the recommended answer. */
  recommended: number;
}

export interface Answer {
  id: string;
  question: string;
  answer: string;
  /** True when the user accepted the default without looking. */
  assumed: boolean;
}

export interface Ticket {
  id: string;
  title: string;
  role: string;
  dependsOn: string[];
  requirements: string[];
  brief: string;
  acceptance: string[];
  writeScope: string[];
  status: "todo" | "in_progress" | "done" | "blocked" | "skipped";
  attempts: TicketAttempt[];
  /** Merge commit on the integration branch once the ticket is done. */
  commit?: string;
  /** The ticket's own branch and worktree while it is being built. */
  branch?: string;
  worktree?: string;
  /** Integration commit the ticket branch last synced with; its diff is the ticket's change. */
  base?: string;
  /** QA-first step: "written" (acceptance tests committed), "none" (QA wrote nothing), "skipped". */
  qa?: "written" | "none" | "skipped";
  /** Test files the QA worker wrote for this ticket. */
  qaTests?: string[];
  /** Moved up the role's model ladder at least once (feeds the escalation breaker). */
  escalated?: boolean;
}

export interface TicketAttempt {
  model: string;
  outcome: "ok" | "gate_fail" | "review_fail" | "secret" | "conflict" | "integration_fail" | "error";
  costUsd: number;
  at: string;
  note?: string;
}

export interface GateSpec {
  name: string;
  command: string;
}

export interface GateResult {
  gate: string;
  command: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  output: string;
  /** Failing tests and diagnostics parsed from the output (failed gates only). */
  details?: GateFailureDetails;
}

/** Stack profile written by the architect. */
export interface Profile {
  stack: string;
  gates: GateSpec[];
  /** Files whose change means dependencies must be reinstalled. */
  manifests: string[];
  /** Contract files under .factory/contracts/ (e.g. "openapi.yaml") that pin the interfaces. */
  contracts?: string[];
  /** ADR files under .factory/adr/ ("0001-architecture.md" plus any later decisions). */
  adrs?: string[];
}

export interface WorkerRequest {
  role: string;
  member: TeamMember;
  tools: string[];
  systemPrompt: string;
  prompt: string;
  cwd: string;
  /** Persistent session id: repeated calls continue the same conversation. */
  sessionId: string;
  sessionDir: string;
  /** Globs (relative to cwd) the worker may write; empty = read-only. */
  writeScope: string[];
  sidekick?: boolean;
  /** Allow deployment commands (only after the user approved a deploy). */
  allowDeploy?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onActivity?: (line: string) => void;
}

export interface WorkerResult {
  text: string;
  usage: Usage;
  turns: number;
  isError: boolean;
  errorMessage?: string;
  model: string;
  trace: TraceStep[];
  exitCode: number;
  stderr: string;
}

export interface WorkerRunner {
  run(request: WorkerRequest): Promise<WorkerResult>;
}

export interface FactoryState {
  version: 1;
  runId: string;
  idea: string;
  phase: Phase;
  status: "running" | "paused" | "waiting" | "failed" | "done";
  createdAt: string;
  updatedAt: string;
  /** Run-scoped setup answers, snapshotted at start and applied on resume. */
  settings?: RunSettings;
  /** Branch the user was on when the run started (release merges back into it). */
  baseBranch?: string;
  baseCommit?: string;
  /** The factory's working branch and worktree. */
  branch?: string;
  worktree?: string;
  answers: Answer[];
  interviewRounds: number;
  /** Readiness checklist (§9.3), re-assessed by the analyst each round; survives resume. */
  readiness?: Readiness;
  tickets: Ticket[];
  spentUsd: number;
  spentTokens: number;
  /** Budget raised by the user at a breaker, if any. */
  budgetUsd: number;
  budgetTokens: number;
  lastError?: string;
  notes: string[];
}

/** UI surface the pipeline needs; the extension adapts ctx.ui, tests script it. */
export interface FactoryUI {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  status(text: string | undefined): void;
  widget(lines: string[] | undefined): void;
  /** Durable transcript entry (phase changes, gate results, summaries). */
  log(kind: string, data: Record<string, unknown>): void;
}
