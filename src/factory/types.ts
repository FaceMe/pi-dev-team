/** Core types for the software factory. */

import type { Usage } from "@earendil-works/pi-ai";
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
  commit?: string;
}

export interface TicketAttempt {
  model: string;
  outcome: "ok" | "gate_fail" | "review_fail" | "error";
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
}

/** Stack profile written by the architect. */
export interface Profile {
  stack: string;
  gates: GateSpec[];
  /** Files whose change means dependencies must be reinstalled. */
  manifests: string[];
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
  /** Branch the user was on when the run started (release merges back into it). */
  baseBranch?: string;
  baseCommit?: string;
  /** The factory's working branch and worktree. */
  branch?: string;
  worktree?: string;
  answers: Answer[];
  interviewRounds: number;
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
