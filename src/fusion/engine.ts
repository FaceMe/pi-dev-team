/**
 * FusionEngine — the persistent sidekick agent, delegation, routing and
 * accounting behind the Fusion extension. UI and command wiring live in
 * extension.ts.
 *
 * 1. THE SIDEKICK APPROACH
 *    The main agent (frontier model, this pi session) delegates well-scoped,
 *    mechanical work to a persistent, cheaper sidekick agent with its own
 *    transcript and tools, and keeps the plan, ambiguity and final review.
 *
 * 2. DYNAMIC MID-SESSION ROUTING
 *    A lightweight classifier scores the running task and moves the main model
 *    and/or the sidekick up or down a capability ladder at compaction
 *    boundaries, where the prompt cache is lost anyway.
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  convertToLlm,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createPowerShellTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { calculateCost, modelsAreEqual } from "@earendil-works/pi-ai";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { fusionStatsPath, loadRolesState } from "../shared/config.js";
import type { FusionConfig, FusionSlot } from "../shared/config.js";
import { readJsonFile, writeJsonFile } from "../shared/json-store.js";
import { blendedCost, clampEffort, modelKey, shortModelKey } from "../shared/models.js";
import type { EffortLevel } from "../shared/models.js";
import { assignTiers } from "../shared/tiers.js";
import { contentText, truncate } from "../shared/text.js";
import { buildTrace, delegationMeta, describeActivity, extractFinalText } from "../shared/trace.js";
import type { DelegationTrace, TraceStep } from "../shared/trace.js";
import { addUsage, cloneUsage, emptyUsage, formatCost } from "../shared/usage.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compressionPrompt, neverExits } from "./policy.js";
import { formatMeter, formatPercent, UsageMeter } from "../shared/usage-meter.js";
import type { MeterSnapshot } from "../shared/usage-meter.js";
import type { DelegationMode } from "./policy.js";

export type { EffortLevel } from "../shared/models.js";
export type { DelegationTrace, TraceStep } from "../shared/trace.js";

export const EXTENSION_TAG = "fusion";
export const SIDEKICK_TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "powershell", "edit", "write"] as const;

export interface RouteRecord {
  at: number;
  trigger: "compact" | "escalation" | "manual";
  slot: "main" | "sidekick";
  from: string;
  to: string;
  difficulty?: number;
  reason: string;
  applied: boolean;
}

export interface FusionStats {
  delegations: number;
  failures: number;
  sidekickTurns: number;
  sidekickUsage: Usage;
  mainUsage: Usage;
  /** Estimate of what the delegated work would have cost on the main model. */
  estimatedMainCost: number;
  routes: RouteRecord[];
  /** Direct tool calls made by the main agent. */
  directCalls: number;
  /** Direct calls redirected to the sidekick by the delegation policy. */
  redirected: number;
  /** Background delegations started. */
  background: number;
  /** Verbose direct outputs compressed by the sidekick model, and characters kept out of the main context. */
  compressed: number;
  charsKeptOut: number;
}

export interface BackgroundTask {
  id: string;
  task: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  /** Aborts this delegation (queued or running). */
  controller: AbortController;
  /** Absolute paths this delegation edits or will edit; the main agent must not touch them meanwhile. */
  leases: Set<string>;
  startedAt: number;
  promise: Promise<DelegationOutcome>;
  outcome?: DelegationOutcome;
  /** Someone (sidekick_wait) is collecting this result, so it must not be delivered again. */
  collected?: boolean;
}

export interface LifetimeStats {
  delegations: number;
  failures: number;
  sidekickCost: number;
  estimatedMainCost: number;
}

export interface RoutingDecision {
  difficulty: number;
  main: "keep" | "downgrade" | "upgrade";
  sidekick: "keep" | "upgrade" | "downgrade";
  reason: string;
}

export interface DelegationInput {
  task: string;
  context?: string;
  files?: string[];
  expect?: "summary" | "diff" | "evidence" | "raw";
  /** Context gathered by the harness (files the main agent read, git status). */
  harnessContext?: string;
}

export interface DelegationOutcome {
  text: string;
  usage: Usage;
  turns: number;
  isError: boolean;
  errorMessage?: string;
  model?: string;
  activity: string[];
  hitTurnCap: boolean;
  meta: string;
  trace: TraceStep[];
  /** Where the full result was saved when it was longer than the cap. */
  fullTextPath?: string;
}

const EXPECT_GUIDANCE: Record<NonNullable<DelegationInput["expect"]>, string> = {
  summary: "Answer with a short prose summary (<=15 lines).",
  diff: "Answer with the unified diff or patch only.",
  evidence: "Answer with the raw evidence (command output, file excerpts) only.",
  raw: "Answer with whatever is most useful, unfiltered.",
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function parseClassifierJson(result: { content?: unknown }): RoutingDecision | null {
  const text = contentText(result.content);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const difficulty = Number(parsed.difficulty);
    if (!Number.isFinite(difficulty)) return null;
    const norm = (value: unknown, allowed: string[], fallback: string): any =>
      typeof value === "string" && allowed.includes(value) ? value : fallback;
    return {
      difficulty: Math.max(1, Math.min(5, Math.round(difficulty))),
      main: norm(parsed.main, ["keep", "downgrade", "upgrade"], "keep"),
      sidekick: norm(parsed.sidekick, ["keep", "upgrade", "downgrade"], "keep"),
      reason: truncate(String(parsed.reason ?? "classifier"), 120),
    };
  } catch {
    return null;
  }
}

/** Reapply the sidekick model that routing chose earlier in this session. */
export function restoreRoutedSidekick(config: FusionConfig, ctx: ExtensionContext): void {
  try {
    let routed: FusionSlot | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "fusion-sidekick") continue;
      const data = entry.data as FusionSlot | undefined;
      if (data?.provider && data?.modelId) routed = data;
    }
    if (routed) config.sidekick = { ...routed };
  } catch (error) {
    console.error(`[${EXTENSION_TAG}] failed to restore routed sidekick:`, error);
  }
}

/** Compact text view of the session, newest last, for the routing classifier. */
export function buildTranscript(ctx: Pick<ExtensionContext, "sessionManager">, maxChars = 6000): string {
  const lines: string[] = [];
  try {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const message = (entry as any).message;
      if (!message) continue;
      if (message.role === "user") {
        // User content can be a string or an array of parts (images, attachments, RPC clients).
        const text = contentText(message.content, " ");
        if (text.trim()) lines.push(`USER: ${truncate(text, 600)}`);
      } else if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part?.type === "text" && part.text?.trim()) {
            lines.push(`ASSISTANT: ${truncate(part.text, 300)}`);
          } else if (part?.type === "toolCall") {
            lines.push(`TOOL: ${part.name} ${truncate(JSON.stringify(part.arguments ?? {}), 160)}`);
          }
        }
      } else if (message.role === "toolResult") {
        const flag = message.isError ? "error" : "ok";
        lines.push(`RESULT[${flag}]: ${truncate(contentText(message.content, " "), 200)}`);
      }
    }
  } catch (error) {
    console.error(`[${EXTENSION_TAG}] failed to read transcript:`, error);
  }
  const joined = lines.join("\n");
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

export function heuristicClassify(transcript: string, consecutiveFailures: number): RoutingDecision {
  const text = transcript.toLowerCase();
  const hardSignals = [
    "refactor", "architect", "design", "race condition", "deadlock", "security",
    "vulnerability", "investigate", "root cause", "why does", "flaky", "memory leak",
    "migrate", "rewrite",
  ];
  const easySignals = [
    "rename", "typo", "bump version", "update docs", "format", "lint", "changelog",
    "comment", "add a test", "revert",
  ];
  const hardHits = hardSignals.filter((signal) => text.includes(signal)).length;
  const easyHits = easySignals.filter((signal) => text.includes(signal)).length;
  let score = 2 + hardHits - easyHits;
  if (/error|failed|exception|cannot|unable/.test(text)) score += 1;
  score = Math.max(1, Math.min(5, score));
  return {
    difficulty: score,
    main: score <= 2 ? "downgrade" : score >= 4 ? "upgrade" : "keep",
    sidekick: consecutiveFailures >= 2 ? "upgrade" : score <= 2 ? "downgrade" : "keep",
    reason: `heuristic ${score}/5 (hard=${hardHits}, easy=${easyHits}, failures=${consecutiveFailures})`,
  };
}

/** Sliding window over a transcript, cut on a user-message boundary. */
export function trimTranscript<T extends { role: string; content?: unknown }>(
  messages: T[],
  maxMessages: number,
): T[] | null {
  const max = Math.max(6, maxMessages);
  if (messages.length <= max) return null;
  let cut = messages.length - Math.max(4, Math.floor(max / 2));
  while (cut < messages.length && messages[cut]?.role !== "user") cut += 1;
  if (cut <= 1 || cut >= messages.length) return null;

  const tail = messages.slice(cut);
  const first = tail[0];
  const note =
    `[${EXTENSION_TAG}] Earlier delegated work in this session was dropped to keep the ` +
    `sidekick context small. Rely on the current brief and rediscover what you need.`;
  const prior = typeof first.content === "string" ? first.content : "";
  tail[0] = { ...first, content: `${note}\n\n${prior}` };
  return tail;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export function buildSidekickPrompt(config: FusionConfig, toolNames: string[]): string {
  if (config.sidekickPrompt?.trim()) return config.sidekickPrompt;
  return [
    "You are the sidekick agent inside a Fusion harness.",
    "",
    "A frontier main agent delegates well-scoped work to you. You are a fully",
    "capable agent: you have your own tools and your own context, and you gather",
    "whatever you need to finish the job.",
    "",
    `Your tools: ${toolNames.join(", ") || "(none)"}`,
    "",
    "Operating rules:",
    "- Do exactly the delegated task. Never expand scope, never refactor nearby code.",
    "- You cannot see the main agent's conversation. Rely only on the brief you were",
    "  given plus what you discover yourself. If the brief is ambiguous or blocked,",
    "  say so immediately and stop instead of guessing.",
    "- Be economical. Prefer targeted reads and greps over whole-file dumps, and stop",
    "  as soon as you have what you need.",
    "- Report back concisely: what you did, what you found, exact paths and line",
    "  numbers, and any risk the main agent must check. Include the raw evidence it",
    "  needs to verify you (diffs, command output) but keep narration minimal.",
    "- Never claim success you did not verify.",
  ].join("\n");
}

export function buildMainGuidance(
  toolName: string,
  sidekickModel: Model<any> | undefined,
  sidekickTools: string[],
  mode: DelegationMode = "balanced",
): string {
  const modeRules: Record<DelegationMode, string[]> = {
    strict: [
      "Mode: STRICT. You have read-only tools (read, grep, find, ls) plus the sidekick. Every command,",
      "edit and file write goes through the sidekick; direct bash/edit/write calls are blocked.",
    ],
    balanced: [
      "Mode: BALANCED. You may run a test, build, lint or install command directly once; if it proves",
      "slow or verbose, later runs are redirected to the sidekick — delegate known-slow suites with",
      "background: true from the start. Very long direct output is condensed by the sidekick's model",
      "(the full log path is included). Commands that never exit (dev servers, --watch) are refused.",
    ],
    advisory: ["Mode: ADVISORY. Delegation is your call, but follow the rules below."],
  };
  return [
    "You are running in Fusion mode: you are the main (frontier) agent, paired with a persistent,",
    "cheaper sidekick agent that has its own tools and its own cached context.",
    "",
    `- Sidekick: ${modelKey(sidekickModel)}${sidekickTools.length ? ` — tools: ${sidekickTools.join(", ")}` : ""}`,
    `- Delegate with \`${toolName}\`; collect background results with \`${toolName}_wait\`.`,
    ...modeRules[mode].map((line) => `- ${line}`),
    "",
    "Decision rule — before each action ask: is this judgement or labour?",
    "- Judgement stays with you: the plan, interpreting ambiguous requirements, design choices,",
    "  and the final review of the sidekick's work against the user's intent.",
    "- Labour goes to the sidekick: running tests/builds/linters, reproducing a bug, recon across",
    "  many files (\"find every caller of X\"), mechanical or multi-file edits from an exact brief,",
    "  collecting and condensing verbose output, repetitive checks.",
    "- Read directly only what you need to decide (a few targeted files or ranges).",
    "",
    "How to delegate well:",
    "1. Briefs are self-contained: exact paths, the exact change or command, acceptance criteria and",
    "   the shape of the answer you want. The sidekick cannot see this conversation.",
    "2. Use background: true for anything slow (test suites, builds, broad recon) and keep working",
    "   on something else; the result is delivered to you when it finishes. Do not duplicate it.",
    `3. Before you report completion, call \`${toolName}_wait\` so no background work is outstanding.`,
    "4. Verify what the sidekick reports (diffs, test output) before relying on it. If a delegation",
    "   fails twice, do that piece yourself.",
  ].join("\n");
}

function loadLifetime(): LifetimeStats {
  const stored = readJsonFile<LifetimeStats>(fusionStatsPath());
  return {
    delegations: stored?.delegations ?? 0,
    failures: stored?.failures ?? 0,
    sidekickCost: stored?.sidekickCost ?? 0,
    estimatedMainCost: stored?.estimatedMainCost ?? 0,
  };
}

function freshStats(): FusionStats {
  return {
    delegations: 0,
    failures: 0,
    sidekickTurns: 0,
    sidekickUsage: emptyUsage(),
    mainUsage: emptyUsage(),
    estimatedMainCost: 0,
    routes: [],
    directCalls: 0,
    redirected: 0,
    background: 0,
    compressed: 0,
    charsKeptOut: 0,
  };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class FusionEngine {
  config: FusionConfig;
  stats: FusionStats = freshStats();
  lifetime: LifetimeStats;
  activity: string[] = [];
  /** Trace of the most recent delegation, shown on demand via /fusion trace. */
  lastTrace?: DelegationTrace;
  /** Latest extension context, used to push UI updates and read the live model. */
  latestCtx?: ExtensionContext;
  /** Real-time token meters: the main agent, the sidekick, and helper calls (output condensing, routing). */
  readonly meters = { main: new UsageMeter(), sidekick: new UsageMeter(), helpers: new UsageMeter() };
  /** Called whenever a meter changes, so the UI can refresh as tokens land. */
  onUsage?: () => void;

  private pi: ExtensionAPI;
  private modelRegistry: ModelRegistry;
  private cwd: string;
  private agent?: Agent;
  private sidekickModel?: Model<any>;
  private sidekickToolNames: string[] = [];
  private turnCounter = 0;
  private consecutiveFailures = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private taskCounter = 0;
  /** Background delegations of this session, by id. */
  readonly tasks = new Map<string, BackgroundTask>();
  /** Stable id so cache-aware providers keep the sidekick's prefix warm across delegations. */
  private readonly cacheSessionId = `fusion-sidekick-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  constructor(pi: ExtensionAPI, modelRegistry: ModelRegistry, cwd: string, config: FusionConfig) {
    this.pi = pi;
    this.modelRegistry = modelRegistry;
    this.cwd = cwd;
    this.config = config;
    this.lifetime = loadLifetime();
  }

  get enabled(): boolean {
    return this.config.enabled && this.resolveSidekickModel() !== undefined;
  }

  setContext(ctx: ExtensionContext): void {
    this.latestCtx = ctx;
  }

  // -- model resolution ----------------------------------------------------

  resolveModel(slot?: FusionSlot): Model<any> | undefined {
    return slot ? this.modelRegistry.find(slot.provider, slot.modelId) : undefined;
  }

  private tiers() {
    return assignTiers(this.modelRegistry, loadRolesState().roles);
  }

  /** Configured main slot, else the frontier tier derived from logged-in models. */
  resolveMainModel(): Model<any> | undefined {
    return this.resolveModel(this.config.main) ?? (this.config.main ? undefined : this.tiers().frontier);
  }

  /** Configured sidekick slot, else the small tier derived from logged-in models. */
  resolveSidekickModel(): Model<any> | undefined {
    return this.resolveModel(this.config.sidekick) ?? (this.config.sidekick ? undefined : this.tiers().small);
  }

  /** The model the session is actually running — routing may have moved it off the slot. */
  liveMainModel(): Model<any> | undefined {
    return this.latestCtx?.model ?? this.resolveMainModel();
  }

  // -- sidekick agent lifecycle -------------------------------------------

  private configuredToolNames(): string[] {
    const names = this.config.sidekickTools.filter((name) => (SIDEKICK_TOOL_NAMES as readonly string[]).includes(name));
    // In strict mode the main agent cannot execute or edit, so the sidekick must be able to.
    if (this.config.delegation?.mode === "strict") {
      for (const name of ["read", "grep", "find", "ls", "bash", "edit", "write"]) if (!names.includes(name)) names.push(name);
    }
    return names;
  }

  private buildSidekickTools(): AgentTool<any>[] {
    const isWindows = process.platform === "win32";
    const factories: Record<string, (cwd: string) => AgentTool<any>> = {
      read: createReadTool,
      grep: createGrepTool,
      find: createFindTool,
      ls: createLsTool,
      bash: isWindows ? createPowerShellTool : createBashTool,
      powershell: createPowerShellTool,
      edit: createEditTool,
      write: createWriteTool,
    };
    const tools: AgentTool<any>[] = [];
    for (const name of this.configuredToolNames()) {
      const factory = factories[name];
      if (!factory) continue;
      try {
        const tool = factory(this.cwd);
        tools.push(name === "bash" || name === "powershell" ? this.guardShellTool(tool) : tool);
      } catch (error) {
        console.error(`[${EXTENSION_TAG}] failed to build sidekick tool "${name}":`, error);
      }
    }
    return tools;
  }

  /**
   * The sidekick's shell: refuse commands that never exit, and give test/build
   * style commands a default timeout so one bad command cannot hang it.
   */
  private guardShellTool(tool: AgentTool<any>): AgentTool<any> {
    return {
      ...tool,
      execute: (toolCallId, params: any, signal, onUpdate) => {
        const command = String(params?.command ?? "");
        const hang = neverExits(command);
        if (hang) return Promise.reject(new Error(`Blocked by Fusion: ${hang}`));
        const timeout = this.config.delegation?.commandTimeoutSec ?? 0;
        const next = timeout > 0 && params && params.timeout === undefined ? { ...params, timeout } : params;
        return tool.execute(toolCallId, next, signal, onUpdate);
      },
    };
  }

  ensureAgent(): Agent | undefined {
    const model = this.resolveSidekickModel();
    if (!model) return undefined;
    const toolNames = this.configuredToolNames();

    if (this.agent && this.sidekickToolNames.join() === toolNames.join()) {
      if (!this.sidekickModel || !modelsAreEqual(this.sidekickModel, model)) {
        this.agent.state.model = model;
        this.agent.state.thinkingLevel = clampEffort(model, this.config.sidekick?.effort) ?? "off";
        this.sidekickModel = model;
      }
      return this.agent;
    }

    const streamFn: StreamFn = (streamModel, context, options) =>
      this.modelRegistry.streamSimple(streamModel, context, options);

    this.agent = new Agent({
      streamFn,
      convertToLlm,
      initialState: {
        systemPrompt: buildSidekickPrompt(this.config, toolNames),
        model,
        thinkingLevel: clampEffort(model, this.config.sidekick?.effort ?? "low") ?? "off",
        tools: this.buildSidekickTools(),
      },
      // Turn cap: end the run after the turn that reaches maxTurns. (turn_end,
      // which increments turnCounter, fires after this hook.)
      finishTurn: () =>
        this.turnCounter + 1 >= Math.max(1, this.config.limits.maxTurns) ? { action: "end" } : undefined,
      toolExecution: "sequential",
      sessionId: this.cacheSessionId,
    });
    this.sidekickModel = model;
    this.sidekickToolNames = toolNames;
    return this.agent;
  }

  /**
   * Swap the sidekick model in place — no cache penalty, context is preserved.
   * `record` marks a routing decision (session-scoped, replayed on resume);
   * a deliberate user choice is persisted to fusion.json by the caller instead.
   */
  setSidekickModel(model: Model<any>, effort?: EffortLevel, options: { record?: boolean } = {}): void {
    this.config.sidekick = {
      provider: model.provider,
      modelId: model.id,
      effort: effort ?? this.config.sidekick?.effort,
    };
    const agent = this.agent;
    this.sidekickModel = model;
    if (agent) {
      agent.state.model = model;
      agent.state.thinkingLevel = clampEffort(model, this.config.sidekick.effort) ?? "off";
    }
    if (options.record) this.pi.appendEntry("fusion-sidekick", { ...this.config.sidekick });
  }

  resetSidekick(): void {
    const agent = this.agent;
    this.agent = undefined;
    this.sidekickModel = undefined;
    this.sidekickToolNames = [];
    this.consecutiveFailures = 0;
    try {
      agent?.abort();
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    const agent = this.agent;
    this.agent = undefined;
    try {
      agent?.abort();
    } catch {
      /* ignore */
    }
  }

  // -- delegation ----------------------------------------------------------

  buildBrief(input: DelegationInput): string {
    const parts: string[] = [`## Task\n${input.task.trim()}`];
    if (input.context?.trim()) parts.push(`## Context from the main agent\n${input.context.trim()}`);
    if (input.files?.length) parts.push(`## Focus files\n${input.files.map((file) => `- ${file}`).join("\n")}`);
    if (input.expect) parts.push(`## Expected response\n${EXPECT_GUIDANCE[input.expect]}`);
    if (input.harnessContext?.trim()) parts.push(`## Context gathered by the harness\n${input.harnessContext.trim()}`);
    parts.push(
      "Work autonomously with your own tools and report back when done. " +
        "Do not ask questions — if something is genuinely blocked, report the blocker.",
    );
    return parts.join("\n\n");
  }

  /** Serialized so parallel tool calls from the main agent queue up safely. */
  delegate(
    input: DelegationInput,
    signal?: AbortSignal,
    onStart?: () => void,
    onTool?: (toolName: string, args: Record<string, unknown>) => void,
  ): Promise<DelegationOutcome> {
    const run = this.queue.then(() => {
      if (signal?.aborted) return this.cancelledOutcome();
      onStart?.();
      return this.runDelegation(input, signal, onTool);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Start a delegation in the background: the main agent keeps working while
   * the sidekick runs. `onDone` fires when it finishes (to deliver the result).
   */
  startBackground(input: DelegationInput, onDone?: (task: BackgroundTask) => void): BackgroundTask {
    this.taskCounter += 1;
    const id = `D${this.taskCounter}`;
    const controller = new AbortController();
    const task: BackgroundTask = {
      id,
      task: truncate(input.task, 200),
      status: "queued",
      startedAt: Date.now(),
      controller,
      leases: new Set(),
      promise: Promise.resolve(undefined as unknown as DelegationOutcome),
    };
    // Files named in the brief are leased up front when the sidekick can edit.
    if (this.canEdit()) for (const file of input.files ?? []) task.leases.add(path.resolve(this.cwd, file));
    task.promise = this.delegate(
      input,
      controller.signal,
      () => {
        if (task.status === "queued") task.status = "running";
      },
      (toolName, args) => {
        if (toolName !== "edit" && toolName !== "write") return;
        const target = String(args.path ?? args.file_path ?? "");
        if (target) task.leases.add(path.resolve(this.cwd, target));
      },
    ).then((outcome) => {
      task.outcome = outcome;
      if (task.status !== "cancelled") {
        task.status = outcome.isError ? "failed" : "done";
        onDone?.(task);
      }
      task.leases.clear();
      return outcome;
    });
    this.tasks.set(id, task);
    this.stats.background += 1;
    return task;
  }

  private canEdit(): boolean {
    const names = this.configuredToolNames();
    return names.includes("edit") || names.includes("write");
  }

  private cancelledOutcome(): DelegationOutcome {
    return {
      text: "",
      usage: emptyUsage(),
      turns: 0,
      isError: true,
      errorMessage: "cancelled",
      activity: [],
      hitTurnCap: false,
      meta: "cancelled",
      trace: [],
    };
  }

  /** Cancel background delegations by id (or all unfinished ones). Returns the ids cancelled. */
  cancel(ids?: string[]): string[] {
    const targets = ids?.length
      ? ids.map((id) => this.tasks.get(id)).filter((t): t is BackgroundTask => Boolean(t))
      : this.pendingTasks();
    const cancelled: string[] = [];
    for (const task of targets) {
      if (task.status !== "queued" && task.status !== "running") continue;
      task.status = "cancelled";
      task.collected = true;
      task.leases.clear();
      task.controller.abort();
      cancelled.push(task.id);
    }
    return cancelled;
  }

  /** The unfinished background delegation that holds a lease on this path, if any. */
  leaseHolder(target: string): BackgroundTask | undefined {
    const absolute = path.resolve(this.cwd, target);
    return this.pendingTasks().find((task) => task.leases.has(absolute));
  }

  /** Wait for background delegations (all unfinished ones when no ids are given). */
  async waitFor(ids?: string[]): Promise<BackgroundTask[]> {
    const wanted = ids?.length
      ? ids.map((id) => this.tasks.get(id)).filter((t): t is BackgroundTask => Boolean(t))
      : [...this.tasks.values()].filter((t) => t.status === "queued" || t.status === "running");
    for (const task of wanted) task.collected = true;
    await Promise.all(wanted.map((t) => t.promise.catch(() => undefined)));
    return wanted;
  }

  pendingTasks(): BackgroundTask[] {
    return [...this.tasks.values()].filter((t) => t.status === "queued" || t.status === "running");
  }

  /**
   * Summarise a verbose direct output with the sidekick model (a stateless call:
   * only the output is sent, not the task context), so it stays out of the
   * expensive main context. Returns undefined when compression is unavailable.
   */
  async compressOutput(command: string, output: string, signal?: AbortSignal): Promise<{ text: string; usage: Usage } | undefined> {
    const model = this.resolveSidekickModel();
    if (!model) return undefined;
    try {
      const stream = this.modelRegistry.streamSimple(
        model,
        {
          systemPrompt: "You condense tool output for a busy engineer. Be exact and terse; quote error lines verbatim.",
          messages: [{ role: "user", content: compressionPrompt(command, output.slice(-60_000)), timestamp: Date.now() }],
        },
        { signal },
      );
      const result = await stream.result();
      if (result.stopReason === "error" || result.stopReason === "aborted") return undefined;
      const text = contentText(result.content).trim();
      if (!text) return undefined;
      const usage = cloneUsage(result.usage ?? emptyUsage());
      addUsage(this.stats.sidekickUsage, usage);
      this.meters.helpers.add(usage);
      this.onUsage?.();
      const mainModel = this.liveMainModel() ?? model;
      const estimated = calculateCost(mainModel, { ...cloneUsage(emptyUsage()), input: Math.ceil(output.length / 4) } as Usage).total;
      this.stats.estimatedMainCost += estimated;
      this.lifetime.sidekickCost += usage.cost.total;
      this.lifetime.estimatedMainCost += estimated;
      this.stats.compressed += 1;
      this.stats.charsKeptOut += Math.max(0, output.length - text.length);
      return { text, usage };
    } catch (error) {
      console.error(`[${EXTENSION_TAG}] output compression failed:`, error);
      return undefined;
    }
  }

  private async runDelegation(
    input: DelegationInput,
    signal?: AbortSignal,
    onTool?: (toolName: string, args: Record<string, unknown>) => void,
  ): Promise<DelegationOutcome> {
    const agent = this.ensureAgent();
    const model = this.resolveSidekickModel();
    if (!agent || !model) {
      return {
        text: "",
        usage: emptyUsage(),
        turns: 0,
        isError: true,
        hitTurnCap: false,
        errorMessage:
          "Fusion sidekick is unavailable: no sidekick model could be resolved. Configure one with /fusion sidekick.",
        activity: [],
        meta: "sidekick unavailable",
        trace: [],
      };
    }

    this.activity = [];
    this.turnCounter = 0;
    const startIndex = agent.state.messages.length;
    const usage = emptyUsage();

    const unsubscribe = agent.subscribe((event) => {
      if (event.type === "turn_end" && event.message?.role === "assistant") {
        this.turnCounter += 1;
        addUsage(usage, event.message.usage);
        this.meters.sidekick.add(event.message.usage);
        this.onUsage?.();
        if (event.message.errorMessage) this.activity.push(`✗ ${truncate(event.message.errorMessage, 120)}`);
      } else if (event.type === "tool_execution_start") {
        this.activity.push(describeActivity(event.toolName, event.args));
        if (this.activity.length > 12) this.activity.shift();
        onTool?.(event.toolName, (event.args ?? {}) as Record<string, unknown>);
      }
    });

    const abortHandler = () => {
      try {
        agent.abort();
      } catch {
        /* ignore */
      }
    };
    if (signal) {
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }

    let isError = false;
    let errorMessage: string | undefined;
    try {
      await agent.prompt(this.buildBrief(input));
    } catch (error) {
      isError = true;
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      unsubscribe();
      signal?.removeEventListener("abort", abortHandler);
    }

    const messages = agent.state.messages.slice(startIndex).filter(Boolean);
    const turns = messages.filter((message) => message.role === "assistant").length;
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (lastAssistant && lastAssistant.role === "assistant") {
      if (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") {
        isError = true;
        errorMessage = lastAssistant.errorMessage ?? `sidekick stopped early (${lastAssistant.stopReason})`;
      }
    }

    const hitTurnCap = this.turnCounter >= Math.max(1, this.config.limits.maxTurns);
    let text = extractFinalText(messages);
    if (!isError && !text) text = "(sidekick produced no text output)";
    if (!isError && hitTurnCap) {
      text +=
        `\n\n[${EXTENSION_TAG}] sidekick hit its ${this.config.limits.maxTurns}-turn cap; ` +
        "the result above may be incomplete.";
    }
    const capped = this.capResult(text);
    text = capped.text;
    const trimmed = trimTranscript(agent.state.messages as any[], this.config.limits.maxMessages);
    if (trimmed) agent.state.messages = trimmed;

    const trace = buildTrace(messages as any[]);
    const meta = delegationMeta({ model: modelKey(model), turns, usage });
    this.lastTrace = { at: Date.now(), task: truncate(input.task, 200), model: modelKey(model), meta, isError, steps: trace };

    // Accounting: price the sidekick's tokens at the rates of the model the
    // session is actually running. This is an estimate — the main model would
    // have spent a different number of tokens on the same work.
    const mainModel = this.liveMainModel() ?? model;
    const estimated = calculateCost(mainModel, cloneUsage(usage)).total;
    this.stats.delegations += 1;
    this.stats.sidekickTurns += turns;
    addUsage(this.stats.sidekickUsage, usage);
    this.stats.estimatedMainCost += estimated;
    this.lifetime.delegations += 1;
    this.lifetime.sidekickCost += usage.cost.total;
    this.lifetime.estimatedMainCost += estimated;

    if (isError) {
      this.stats.failures += 1;
      this.lifetime.failures += 1;
      this.consecutiveFailures += 1;
    } else {
      this.consecutiveFailures = 0;
    }
    writeJsonFile(fusionStatsPath(), this.lifetime);

    return {
      text,
      usage,
      turns,
      isError,
      errorMessage,
      model: modelKey(model),
      activity: [...this.activity],
      hitTurnCap,
      meta,
      trace,
      fullTextPath: capped.path,
    };
  }

  /**
   * Keep the main agent's context lean: a sidekick result longer than the cap
   * is cut, and the full text is saved to a file the main agent can read.
   */
  capResult(text: string): { text: string; path?: string } {
    const cap = this.config.delegation?.resultCapChars ?? 0;
    if (cap <= 0 || text.length <= cap) return { text };
    let file: string | undefined;
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-result-"));
      file = path.join(dir, "result.md");
      fs.writeFileSync(file, text);
    } catch {
      file = undefined;
    }
    const head = text.slice(0, cap);
    const cut = head.lastIndexOf("\n") > cap * 0.6 ? head.slice(0, head.lastIndexOf("\n")) : head;
    return {
      text:
        `${cut}\n\n[${EXTENSION_TAG}] result cut at ${cut.length.toLocaleString()} of ${text.length.toLocaleString()} chars` +
        `${file ? `; full result: ${file} (read targeted ranges only if needed)` : ""}.`,
      path: file,
    };
  }

  // -- routing -------------------------------------------------------------

  /** Capability ladder, cheapest first, from the tiers plus both slots. */
  ladder(): Model<any>[] {
    const tiers = this.tiers();
    const seen = new Set<string>();
    const models: Model<any>[] = [];
    const add = (model?: Model<any>): void => {
      if (!model) return;
      const key = modelKey(model);
      if (seen.has(key)) return;
      seen.add(key);
      models.push(model);
    };
    add(tiers.small);
    add(tiers.daily);
    add(tiers.frontier);
    add(this.resolveSidekickModel());
    add(this.resolveMainModel());
    models.sort((a, b) => blendedCost(a) - blendedCost(b));
    return models;
  }

  ladderIndex(models: Model<any>[], current?: Model<any>): number {
    if (!current) return 0;
    const exact = models.findIndex((model) => modelsAreEqual(model, current));
    if (exact >= 0) return exact;
    // Anchor by price when the active model is not part of the ladder.
    const price = blendedCost(current);
    let best = 0;
    let bestDelta = Number.POSITIVE_INFINITY;
    models.forEach((model, index) => {
      const delta = Math.abs(blendedCost(model) - price);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = index;
      }
    });
    return best;
  }

  move(models: Model<any>[], current: Model<any> | undefined, direction: -1 | 1): Model<any> | undefined {
    if (models.length < 2) return undefined;
    const index = this.ladderIndex(models, current);
    const next = Math.min(models.length - 1, Math.max(0, index + direction));
    if (next === index) return undefined;
    return models[next];
  }

  /** Score the running task and decide where the main/sidekick models should sit. */
  async classify(_ctx: ExtensionContext, transcript: string): Promise<RoutingDecision | null> {
    const mode = this.config.routing.mode;
    if (mode === "off") return null;

    const heuristic = heuristicClassify(transcript, this.consecutiveFailures);
    if (mode === "heuristic") return heuristic;

    const classifierModel = this.resolveSidekickModel() ?? this.resolveMainModel();
    if (!classifierModel) return heuristic;

    const prompt = [
      "You are a routing classifier for a hybrid coding-agent harness.",
      "Read the task transcript and decide whether the MAIN agent model and the",
      "SIDEKICK model should move up or down a capability ladder.",
      "",
      "Reply with JSON only, no prose:",
      '{"difficulty":1-5,"main":"keep|downgrade|upgrade","sidekick":"keep|upgrade|downgrade","reason":"<=100 chars"}',
      "",
      "Rules:",
      "- downgrade the main model only when the remaining work is mechanical and low risk.",
      "- upgrade the main model when the task needs deep design, has hit repeated",
      "  failures, or the sidekick has struggled.",
      "- upgrade the sidekick when delegated subtasks keep failing or need more reasoning.",
      "- downgrade the sidekick only when delegated subtasks are trivially mechanical.",
      "- prefer keep unless the evidence is clear.",
      "",
      "Task transcript:",
      transcript.slice(0, 6000),
    ].join("\n");

    try {
      const stream = this.modelRegistry.streamSimple(classifierModel, {
        systemPrompt: "You are a precise, terse routing classifier. Reply with JSON only.",
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      });
      const result = await stream.result();
      this.meters.helpers.add(result.usage);
      this.onUsage?.();
      return parseClassifierJson(result) ?? heuristic;
    } catch (error) {
      console.error(`[${EXTENSION_TAG}] classifier failed, using heuristic:`, error);
      return heuristic;
    }
  }

  /** Apply a routing decision. Returns the records produced. */
  async applyRouting(decision: RoutingDecision, trigger: RouteRecord["trigger"]): Promise<RouteRecord[]> {
    const records: RouteRecord[] = [];
    const models = this.ladder();

    const attempt = async (slot: "main" | "sidekick", direction: "keep" | "upgrade" | "downgrade"): Promise<void> => {
      if (direction === "keep") return;
      // Main: measure from the model the session is actually running, since a
      // previous route may have moved it away from the configured slot.
      const current = slot === "main" ? this.liveMainModel() : this.resolveSidekickModel();
      const target = this.move(models, current, direction === "upgrade" ? 1 : -1);
      if (!target || (current && modelsAreEqual(target, current))) return;

      const record: RouteRecord = {
        at: Date.now(),
        trigger,
        slot,
        from: modelKey(current),
        to: modelKey(target),
        difficulty: decision.difficulty,
        reason: decision.reason,
        applied: false,
      };

      if (!this.config.routing.autoApply) {
        records.push(record);
        return;
      }

      if (slot === "sidekick") {
        this.setSidekickModel(target, undefined, { record: true });
        record.applied = true;
      } else {
        const ok = await this.pi.setModel(target);
        if (ok) {
          const effort = clampEffort(target, this.config.main?.effort);
          if (effort) this.pi.setThinkingLevel(effort);
          record.applied = true;
        } else {
          record.reason = `${decision.reason} (no auth for ${modelKey(target)})`;
        }
      }
      records.push(record);
    };

    await attempt("main", decision.main);
    await attempt("sidekick", decision.sidekick);

    for (const record of records) {
      this.stats.routes.push(record);
      if (this.stats.routes.length > 50) this.stats.routes.shift();
      this.pi.appendEntry("fusion-route", record);
    }
    return records;
  }

  /** Escalate the sidekick after repeated failed delegations. */
  async maybeEscalate(): Promise<RouteRecord[]> {
    if (!this.config.routing.enabled || !this.config.routing.escalateOnFailure) return [];
    if (this.consecutiveFailures < 2) return [];
    const failures = this.consecutiveFailures;
    const records = await this.applyRouting(
      {
        difficulty: 4,
        main: "keep",
        sidekick: "upgrade",
        reason: `${failures} consecutive failed delegations — escalating the sidekick`,
      },
      "escalation",
    );
    if (records.some((record) => record.applied)) this.consecutiveFailures = 0;
    return records;
  }

  // -- reporting -----------------------------------------------------------

  savingsRatio(): number {
    if (this.stats.estimatedMainCost <= 0) return 0;
    const saved = this.stats.estimatedMainCost - this.stats.sidekickUsage.cost.total;
    return Math.max(0, saved / this.stats.estimatedMainCost);
  }

  lifetimeSavings(): number {
    return Math.max(0, this.lifetime.estimatedMainCost - this.lifetime.sidekickCost);
  }

  /** Share of the main agent's work that went through the sidekick. */
  delegationRate(): number {
    const delegated = this.stats.delegations + this.stats.compressed;
    const total = delegated + this.stats.directCalls;
    return total > 0 ? delegated / total : 0;
  }

  /** Record one main-agent response (called from the extension's turn_end). */
  recordMainUsage(usage?: Partial<Usage> | null): void {
    if (!usage) return;
    addUsage(this.stats.mainUsage, usage);
    this.meters.main.add(usage);
    this.onUsage?.();
  }

  meterSnapshots(): { main: MeterSnapshot; sidekick: MeterSnapshot; helpers: MeterSnapshot } {
    return { main: this.meters.main.snapshot(), sidekick: this.meters.sidekick.snapshot(), helpers: this.meters.helpers.snapshot() };
  }

  /** Per-agent token lines for the widget: tokens, cache reads/writes, hit rate, cost. */
  usageLines(): string[] {
    const m = this.meterSnapshots();
    const lines = [
      `main      ${shortModelKey(this.liveMainModel())} · ${formatMeter(m.main)}`,
      `sidekick  ${shortModelKey(this.resolveSidekickModel())} · ${formatMeter(m.sidekick)}`,
    ];
    if (m.helpers.requests > 0) lines.push(`helpers   condense/route · ${formatMeter(m.helpers)}`);
    return lines;
  }

  statusLines(): string[] {
    const main = this.liveMainModel();
    const sidekick = this.resolveSidekickModel();
    const ratio = this.savingsRatio();
    const pending = this.pendingTasks().length;
    return [
      ...this.usageLines(),
      `main ${shortModelKey(main)}${this.config.main?.effort ? ` (${this.config.main.effort})` : ""}` +
        `  ·  sidekick ${shortModelKey(sidekick)}` +
        `${this.config.sidekick?.effort ? ` (${this.config.sidekick.effort})` : ""}`,
      `delegations ${this.stats.delegations} (${this.stats.failures} failed)  ·  ` +
        `sidekick ${formatCost(this.stats.sidekickUsage.cost.total)}  ·  ` +
        `est. main-only ${formatCost(this.stats.estimatedMainCost)}  ·  ` +
        `saved ${(ratio * 100).toFixed(0)}% (est.)`,
      `mode ${this.config.delegation?.mode ?? "balanced"}  ·  delegated ${(this.delegationRate() * 100).toFixed(0)}% of work  ·  ` +
        `redirected ${this.stats.redirected}  ·  compressed ${this.stats.compressed}` +
        `${pending ? `  ·  ${pending} running in background` : ""}`,
    ];
  }

  footerStatus(): string {
    const base = `⚛ fusion ${shortModelKey(this.resolveSidekickModel())}`;
    const m = this.meterSnapshots();
    const hits =
      m.main.requests + m.sidekick.requests > 0
        ? ` · hit main ${formatPercent(m.main.hitRate)} sk ${formatPercent(m.sidekick.hitRate)}` +
          ` · ${formatCost(m.main.cost + m.sidekick.cost + m.helpers.cost)}`
        : "";
    if (this.stats.delegations === 0) return `${base}${hits}`;
    return `${base}${hits} · ${(this.savingsRatio() * 100).toFixed(0)}% saved (est.)`;
  }

  snapshot(): FusionStats & { lifetime: LifetimeStats; meters: ReturnType<FusionEngine["meterSnapshots"]> } {
    return {
      meters: this.meterSnapshots(),
      delegations: this.stats.delegations,
      failures: this.stats.failures,
      sidekickTurns: this.stats.sidekickTurns,
      sidekickUsage: cloneUsage(this.stats.sidekickUsage),
      mainUsage: cloneUsage(this.stats.mainUsage),
      estimatedMainCost: this.stats.estimatedMainCost,
      routes: [...this.stats.routes],
      directCalls: this.stats.directCalls,
      redirected: this.stats.redirected,
      background: this.stats.background,
      compressed: this.stats.compressed,
      charsKeptOut: this.stats.charsKeptOut,
      lifetime: { ...this.lifetime },
    };
  }

  resetSessionStats(): void {
    this.stats = freshStats();
    this.meters.main.reset();
    this.meters.sidekick.reset();
    this.meters.helpers.reset();
  }

  /** Test hook: number of consecutive failed delegations. */
  get failureStreak(): number {
    return this.consecutiveFailures;
  }
}
