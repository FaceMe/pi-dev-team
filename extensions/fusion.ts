/**
 * pi-fusion — a hybrid model harness for the pi coding agent.
 *
 * 1. THE SIDEKICK APPROACH
 *    Two agents run side by side: the main agent (frontier model, this pi session)
 *    and a persistent "sidekick" agent (a cheaper model) that owns its own
 *    transcript and its own toolset. The main agent delegates well-scoped,
 *    mechanical work to the sidekick through the `sidekick` tool and keeps the
 *    significant decisions for itself: the plan, the interpretation of ambiguity,
 *    and the final review. Because the sidekick keeps a persistent context, the
 *    expensive prefix is not re-sent on every call the way a stateless
 *    "ask another model" tool would.
 *
 * 2. DYNAMIC MID-SESSION ROUTING
 *    Choosing a model once up front is fragile. A lightweight classifier scores
 *    the running task and moves the main model (and/or the sidekick model) up or
 *    down a capability ladder. Routing is applied at compaction boundaries —
 *    compaction invalidates the prompt cache anyway, so switching the model there
 *    is free. The sidekick can also be upgraded in place without going back to
 *    the main model.
 *
 * Everything is opt-in and configurable through `/fusion`.
 *
 * State:
 *   ~/.pi/agent/fusion.json        — configuration (main/sidekick slots, routing, limits)
 *   ~/.pi/agent/fusion-stats.json  — lifetime cost/savings ledger
 *   ~/.pi/agent/model-roles.json   — read for defaults (frontier -> main, small -> sidekick)
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
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
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  calculateCost,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  modelsAreEqual,
  StringEnum,
} from "@earendil-works/pi-ai";
import type { Model, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { Box, Key, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { showModelPicker } from "./model-picker.js";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

const EXTENSION_TAG = "fusion";

/** Reasoning effort, including the "no thinking" level pi supports on every model. */
export type EffortLevel = ModelThinkingLevel;
const SIDEKICK_TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "powershell", "edit", "write"] as const;
const DEFAULT_SIDEKICK_TOOLS = ["read", "grep", "find", "ls", "bash"];

export interface FusionSlot {
  provider: string;
  modelId: string;
  effort?: EffortLevel;
}

export interface FusionRoutingConfig {
  /** Master switch for dynamic mid-session routing. */
  enabled: boolean;
  /** How the running task is scored. */
  mode: "llm" | "heuristic" | "off";
  /** Apply the decision automatically, or only report it. */
  autoApply: boolean;
  /** Re-route at every compaction boundary (a cache miss happens anyway). */
  onCompact: boolean;
  /** Upgrade the sidekick after repeated failed delegations. */
  escalateOnFailure: boolean;
}

export interface FusionLimits {
  /** Hard cap on sidekick turns per delegation. */
  maxTurns: number;
  /** Sliding-window size for the persistent sidekick transcript. */
  maxMessages: number;
}

export interface FusionConfig {
  enabled: boolean;
  main: FusionSlot;
  sidekick: FusionSlot;
  /** Tool names the sidekick may use. */
  sidekickTools: string[];
  routing: FusionRoutingConfig;
  limits: FusionLimits;
  /** Optional override for the sidekick system prompt. */
  sidekickPrompt?: string;
}

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
  /** What the delegated work would have cost on the main model. */
  estimatedMainCost: number;
  routes: RouteRecord[];
}

interface LifetimeStats {
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

interface DelegationInput {
  task: string;
  context?: string;
  files?: string[];
  expect?: "summary" | "diff" | "evidence" | "raw";
}

interface DelegationOutcome {
  text: string;
  usage: Usage;
  turns: number;
  isError: boolean;
  errorMessage?: string;
  model?: string;
  activity: string[];
  hitTurnCap: boolean;
}

const DEFAULT_CONFIG: FusionConfig = {
  enabled: true,
  main: { provider: "anthropic", modelId: "claude-sonnet-4-5", effort: "high" },
  sidekick: { provider: "anthropic", modelId: "claude-haiku-4-5", effort: "low" },
  sidekickTools: [...DEFAULT_SIDEKICK_TOOLS],
  routing: {
    enabled: true,
    mode: "llm",
    autoApply: true,
    onCompact: true,
    escalateOnFailure: true,
  },
  limits: { maxTurns: 12, maxMessages: 40 },
};

const CONFIG_PATH = path.join(getAgentDir(), "fusion.json");
const STATS_PATH = path.join(getAgentDir(), "fusion-stats.json");
const ROLES_PATH = path.join(getAgentDir(), "model-roles.json");

const EXPECT_GUIDANCE: Record<NonNullable<DelegationInput["expect"]>, string> = {
  summary: "Answer with a short prose summary (<=15 lines).",
  diff: "Answer with the unified diff or patch only.",
  evidence: "Answer with the raw evidence (command output, file excerpts) only.",
  raw: "Answer with whatever is most useful, unfiltered.",
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function readJsonFile(filePath: string): Record<string, any> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  } catch (error) {
    console.error(`[${EXTENSION_TAG}] failed to write ${filePath}:`, error);
  }
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(target: Usage, source?: Partial<Usage> | null): void {
  if (!source) return;
  target.input += source.input ?? 0;
  target.output += source.output ?? 0;
  target.cacheRead += source.cacheRead ?? 0;
  target.cacheWrite += source.cacheWrite ?? 0;
  target.totalTokens += source.totalTokens ?? 0;
  const cost = source.cost;
  if (cost) {
    target.cost.input += cost.input ?? 0;
    target.cost.output += cost.output ?? 0;
    target.cost.cacheRead += cost.cacheRead ?? 0;
    target.cost.cacheWrite += cost.cacheWrite ?? 0;
    target.cost.total += cost.total ?? 0;
  }
}

function cloneUsage(usage: Usage): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: { ...usage.cost },
  };
}

function modelKey(model?: Model<any> | null): string {
  return model ? `${model.provider}/${model.id}` : "(none)";
}

function shortModelKey(model?: Model<any> | null): string {
  if (!model) return "none";
  const id = model.id.length > 22 ? `${model.id.slice(0, 21)}…` : model.id;
  return `${model.provider}/${id}`;
}

function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function clampEffort(
  model: Model<any> | undefined,
  level: EffortLevel | undefined,
): EffortLevel | undefined {
  if (!model || !level) return level;
  try {
    return clampThinkingLevel(model, level) as EffortLevel;
  } catch {
    return level;
  }
}

function supportedEfforts(model: Model<any> | undefined): EffortLevel[] {
  if (!model) return ["off"];
  try {
    return getSupportedThinkingLevels(model) as EffortLevel[];
  } catch {
    return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  }
}

/** Rough blended price used to order models into a capability ladder. */
function blendedCost(model: Model<any>): number {
  const cost = model.cost ?? { input: 0, output: 0 };
  return (cost.input ?? 0) * 3 + (cost.output ?? 0);
}

function truncate(text: string, max: number): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

function describeActivity(toolName: string, args: Record<string, unknown>): string {
  const target = (args.file_path ?? args.path ?? "") as string;
  switch (toolName) {
    case "bash":
    case "powershell":
      return `$ ${truncate(String(args.command ?? ""), 70)}`;
    case "read":
      return `read ${truncate(target, 60)}`;
    case "grep":
      return `grep /${truncate(String(args.pattern ?? ""), 30)}/`;
    case "edit":
      return `edit ${truncate(target, 60)}`;
    case "write":
      return `write ${truncate(target, 60)}`;
    case "find":
      return `find ${truncate(String(args.pattern ?? ""), 40)}`;
    case "ls":
      return `ls ${truncate(String(args.path ?? "."), 50)}`;
    default:
      return `${toolName} ${truncate(JSON.stringify(args), 50)}`;
  }
}

function extractFinalText(messages: Array<{ role: string; content?: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const texts: string[] = [];
    for (const part of message.content) {
      if (part && typeof part === "object" && (part as any).type === "text") {
        texts.push(String((part as any).text ?? ""));
      }
    }
    const joined = texts.join("\n").trim();
    if (joined) return joined;
  }
  return "";
}

function parseClassifierJson(result: { content?: unknown }): RoutingDecision | null {
  let text = "";
  const content = result.content;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((part: any) => (part?.type === "text" ? String(part.text ?? "") : ""))
      .join("\n");
  }
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
function restoreRoutedSidekick(config: FusionConfig, ctx: ExtensionContext): void {
  try {
    let routed: FusionSlot | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "fusion-sidekick") continue;
      const data = entry.data as FusionSlot | undefined;
      if (data?.provider && data?.modelId) routed = data;
    }
    if (routed) config.sidekick = { ...routed };
  } catch (error) {
    console.error(`[fusion] failed to restore routed sidekick:`, error);
  }
}

/** Compact text view of the session, newest last, for the routing classifier. */
function buildTranscript(ctx: ExtensionContext, maxChars = 6000): string {
  const lines: string[] = [];
  try {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const message = (entry as any).message;
      if (!message) continue;
      if (message.role === "user") {
        const text = typeof message.content === "string" ? message.content : "";
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
        const text = Array.isArray(message.content)
          ? message.content.map((p: any) => (p?.type === "text" ? p.text : "")).join(" ")
          : "";
        lines.push(`RESULT[${flag}]: ${truncate(text, 200)}`);
      }
    }
  } catch (error) {
    console.error(`[${EXTENSION_TAG}] failed to read transcript:`, error);
  }
  const joined = lines.join("\n");
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface RoleState {
  roles?: {
    daily?: FusionSlot;
    small?: FusionSlot;
    frontier?: FusionSlot;
  };
}

function readRoleState(): RoleState {
  return (readJsonFile(ROLES_PATH) as RoleState | null) ?? {};
}

function loadConfig(): FusionConfig {
  const stored = readJsonFile(CONFIG_PATH);
  const roles = readRoleState().roles ?? {};
  const config: FusionConfig = {
    ...DEFAULT_CONFIG,
    ...(stored ?? {}),
    main: { ...DEFAULT_CONFIG.main, ...(stored?.main ?? {}) },
    sidekick: { ...DEFAULT_CONFIG.sidekick, ...(stored?.sidekick ?? {}) },
    routing: { ...DEFAULT_CONFIG.routing, ...(stored?.routing ?? {}) },
    limits: { ...DEFAULT_CONFIG.limits, ...(stored?.limits ?? {}) },
    sidekickTools: Array.isArray(stored?.sidekickTools)
      ? stored.sidekickTools.filter((name: unknown) => typeof name === "string")
      : [...DEFAULT_SIDEKICK_TOOLS],
  };

  // Seed unset slots from the model-picker roles so both extensions agree on
  // what "frontier" and "small" mean.
  if (!stored?.main) config.main = { ...(roles.frontier ?? roles.daily ?? config.main) };
  if (!stored?.sidekick) config.sidekick = { ...(roles.small ?? roles.daily ?? config.sidekick) };
  return config;
}

function loadLifetime(): LifetimeStats {
  const stored = readJsonFile(STATS_PATH) as LifetimeStats | null;
  return {
    delegations: stored?.delegations ?? 0,
    failures: stored?.failures ?? 0,
    sidekickCost: stored?.sidekickCost ?? 0,
    estimatedMainCost: stored?.estimatedMainCost ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildSidekickPrompt(config: FusionConfig, toolNames: string[]): string {
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

function buildMainGuidance(
  toolName: string,
  sidekickModel: Model<any> | undefined,
  sidekickTools: string[],
): string {
  return [
    "You are running in Fusion mode: a hybrid two-agent harness.",
    "",
    `- Sidekick agent: ${modelKey(sidekickModel)}${sidekickTools.length ? ` — tools: ${sidekickTools.join(", ")}` : ""}`,
    `- Delegate with the \`${toolName}\` tool.`,
    "",
    "Operating discipline:",
    "1. You own the plan, the interpretation of ambiguity, and the final review.",
    "   Take minimal direct actions and read only what is strictly necessary.",
    "2. By default, delegate well-scoped work to the sidekick, then monitor and verify.",
    "3. Delegate: targeted reads/greps/recon, mechanical edits with an exact brief,",
    "   running tests, builds and linters, collecting verbose output, repeat checks.",
    "4. Do not delegate: deciding what to build, resolving ambiguous requirements,",
    "   reviewing the sidekick's work for correctness, or anything that needs",
    "   judgement about the user's intent.",
    "5. Every brief must be self-contained: exact paths, exact acceptance criteria,",
    "   and the exact output you want back. The sidekick cannot see this conversation.",
    "6. Delegations run one at a time. Prefer one well-scoped brief over many tiny ones.",
    "7. Verify the sidekick's result before reporting success. If a delegated task",
    "   fails or comes back wrong, take it over yourself rather than re-sending it.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Fusion engine
// ---------------------------------------------------------------------------

export class FusionEngine {
  config: FusionConfig;
  stats: FusionStats;
  lifetime: LifetimeStats;
  activity: string[] = [];

  private pi: ExtensionAPI;
  private modelRegistry: ModelRegistry;
  private cwd: string;
  private agent?: Agent;
  private sidekickModel?: Model<any>;
  private sidekickToolNames: string[] = [];
  private turnCounter = 0;
  private consecutiveFailures = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /** Latest extension context, used to push UI updates from async callbacks. */
  latestCtx?: ExtensionContext;

  constructor(
    pi: ExtensionAPI,
    modelRegistry: ModelRegistry,
    cwd: string,
    config: FusionConfig,
  ) {
    this.pi = pi;
    this.modelRegistry = modelRegistry;
    this.cwd = cwd;
    this.config = config;
    this.lifetime = loadLifetime();
    this.stats = {
      delegations: 0,
      failures: 0,
      sidekickTurns: 0,
      sidekickUsage: emptyUsage(),
      mainUsage: emptyUsage(),
      estimatedMainCost: 0,
      routes: [],
    };
  }

  get enabled(): boolean {
    return this.config.enabled && this.resolveSidekickModel() !== undefined;
  }

  setContext(ctx: ExtensionContext): void {
    this.latestCtx = ctx;
  }

  // -- model resolution ----------------------------------------------------

  resolveModel(slot: FusionSlot): Model<any> | undefined {
    return this.modelRegistry.find(slot.provider, slot.modelId);
  }

  resolveMainModel(): Model<any> | undefined {
    return this.resolveModel(this.config.main);
  }

  resolveSidekickModel(): Model<any> | undefined {
    return this.resolveModel(this.config.sidekick);
  }

  // -- sidekick agent lifecycle -------------------------------------------

  private configuredToolNames(): string[] {
    return this.config.sidekickTools.filter((name) =>
      (SIDEKICK_TOOL_NAMES as readonly string[]).includes(name),
    );
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
        tools.push(factory(this.cwd));
      } catch (error) {
        console.error(`[${EXTENSION_TAG}] failed to build sidekick tool "${name}":`, error);
      }
    }
    return tools;
  }

  ensureAgent(): Agent | undefined {
    const model = this.resolveSidekickModel();
    if (!model) return undefined;
    const toolNames = this.configuredToolNames();

    if (this.agent && this.sidekickToolNames.join() === toolNames.join()) {
      // Keep the loaded sidekick in sync with the configured slot.
      if (!this.sidekickModel || !modelsAreEqual(this.sidekickModel, model)) {
        this.agent.state.model = model;
        this.agent.state.thinkingLevel = clampEffort(model, this.config.sidekick.effort) ?? "off";
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
        thinkingLevel: clampEffort(model, this.config.sidekick.effort) ?? "off",
        tools: this.buildSidekickTools(),
      },
      shouldStopAfterTurn: () => this.turnCounter >= Math.max(1, this.config.limits.maxTurns),
      toolExecution: "sequential",
    });
    this.sidekickModel = model;
    this.sidekickToolNames = toolNames;
    return this.agent;
  }

  /** Swap the sidekick model in place — no cache penalty, context is preserved. */
  setSidekickModel(model: Model<any>, effort?: EffortLevel): void {
    this.config.sidekick = {
      provider: model.provider,
      modelId: model.id,
      effort: effort ?? this.config.sidekick.effort,
    };
    const agent = this.agent;
    this.sidekickModel = model;
    if (agent) {
      agent.state.model = model;
      agent.state.thinkingLevel = clampEffort(model, this.config.sidekick.effort) ?? "off";
    }
    // Routing is session-scoped (like pi's own model switching), so record it in
    // the session and restore it on resume instead of rewriting the global config.
    this.pi.appendEntry("fusion-sidekick", { ...this.config.sidekick });
  }

  resetSidekick(): void {
    const agent = this.agent;
    this.agent = undefined;
    this.sidekickModel = undefined;
    this.sidekickToolNames = [];
    this.consecutiveFailures = 0;
    if (agent) {
      try {
        agent.abort();
      } catch {
        /* ignore */
      }
    }
  }

  dispose(): void {
    const agent = this.agent;
    this.agent = undefined;
    if (agent) {
      try {
        agent.abort();
      } catch {
        /* ignore */
      }
    }
  }

  // -- delegation ----------------------------------------------------------

  private buildBrief(input: DelegationInput): string {
    const parts: string[] = [`## Task\n${input.task.trim()}`];
    if (input.context?.trim()) parts.push(`## Context from the main agent\n${input.context.trim()}`);
    if (input.files?.length) {
      parts.push(`## Focus files\n${input.files.map((file) => `- ${file}`).join("\n")}`);
    }
    if (input.expect) parts.push(`## Expected response\n${EXPECT_GUIDANCE[input.expect]}`);
    parts.push(
      "Work autonomously with your own tools and report back when done. " +
        "Do not ask questions — if something is genuinely blocked, report the blocker.",
    );
    return parts.join("\n\n");
  }

  /** Serialized so parallel tool calls from the main agent queue up safely. */
  delegate(input: DelegationInput, signal?: AbortSignal): Promise<DelegationOutcome> {
    const run = this.queue.then(() => this.runDelegation(input, signal));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async runDelegation(input: DelegationInput, signal?: AbortSignal): Promise<DelegationOutcome> {
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
          "Fusion sidekick is unavailable: no sidekick model could be resolved. " +
          "Configure one with /fusion models.",
        activity: [],
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
        if (event.message.errorMessage) {
          this.activity.push(`✗ ${truncate(event.message.errorMessage, 120)}`);
        }
      } else if (event.type === "tool_execution_start") {
        this.activity.push(describeActivity(event.toolName, event.args));
        if (this.activity.length > 12) this.activity.shift();
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
      if (signal) signal.removeEventListener("abort", abortHandler);
    }

    const messages = agent.state.messages.slice(startIndex).filter(Boolean);
    const turns = messages.filter((message) => message.role === "assistant").length;
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (lastAssistant && lastAssistant.role === "assistant") {
      if (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") {
        isError = true;
        errorMessage =
          lastAssistant.errorMessage ?? `sidekick stopped early (${lastAssistant.stopReason})`;
      }
    }

    const hitTurnCap = this.turnCounter >= Math.max(1, this.config.limits.maxTurns);
    let text = extractFinalText(messages);
    if (!isError && !text) text = "(sidekick produced no text output)";
    if (!isError && hitTurnCap) {
      text += `\n\n[${EXTENSION_TAG}] sidekick hit its ${this.config.limits.maxTurns}-turn cap; ` +
        "the result above may be incomplete.";
    }
    this.trimSidekickTranscript();

    // Accounting: what the delegated work would have cost on the main model.
    // Prefer the model the session is actually running, since routing may have
    // moved it away from the configured main slot.
    const mainModel = this.latestCtx?.model ?? this.resolveMainModel() ?? model;
    const estimated = calculateCost(mainModel, cloneUsage(usage)).total;
    this.stats.delegations += 1;
    this.stats.sidekickTurns += turns;
    addUsage(this.stats.sidekickUsage, usage);
    this.stats.estimatedMainCost += estimated;
    this.lifetime.delegations += 1;
    this.lifetime.sidekickCost += usage.cost.total;
    this.lifetime.estimatedMainCost += estimated;
    writeJsonFile(STATS_PATH, this.lifetime);

    if (isError) {
      this.stats.failures += 1;
      this.lifetime.failures += 1;
      this.consecutiveFailures += 1;
    } else {
      this.consecutiveFailures = 0;
    }

    return { text, usage, turns, isError, errorMessage, model: modelKey(model), activity: [...this.activity], hitTurnCap };
  }

  /** Sliding window over the persistent sidekick transcript, cut on a user boundary. */
  private trimSidekickTranscript(): void {
    const agent = this.agent;
    if (!agent) return;
    const messages = agent.state.messages;
    const max = Math.max(6, this.config.limits.maxMessages);
    if (messages.length <= max) return;

    let cut = messages.length - Math.max(4, Math.floor(max / 2));
    while (cut < messages.length && messages[cut]?.role !== "user") cut += 1;
    if (cut <= 1 || cut >= messages.length) return;

    const system = messages.filter((message) => message.role === "system");
    const tail = messages.slice(cut);
    const first = tail[0];
    const note =
      `[${EXTENSION_TAG}] Earlier delegated work in this session was dropped to keep the ` +
      `sidekick context small. Rely on the current brief and rediscover what you need.`;
    if (first && first.role === "user") {
      const prior = typeof first.content === "string" ? first.content : "";
      tail[0] = { ...first, content: `${note}\n\n${prior}` };
    } else {
      tail.unshift({ role: "user", content: note, timestamp: Date.now() });
    }
    agent.state.messages = [...system, ...tail];
  }

  // -- routing -------------------------------------------------------------

  /**
   * Capability ladder, cheapest first, built from the model-picker roles so the
   * same "small / daily / frontier" vocabulary drives routing.
   */
  ladder(): Model<any>[] {
    const roles = readRoleState().roles ?? {};
    const slots = [roles.small, roles.daily, roles.frontier].filter(Boolean) as FusionSlot[];
    const seen = new Set<string>();
    const models: Model<any>[] = [];

    const add = (slot?: FusionSlot): void => {
      if (!slot) return;
      const model = this.resolveModel(slot);
      if (!model) return;
      const key = modelKey(model);
      if (seen.has(key)) return;
      seen.add(key);
      models.push(model);
    };

    for (const slot of slots) add(slot);
    add(this.config.sidekick);
    add(this.config.main);
    models.sort((a, b) => blendedCost(a) - blendedCost(b));
    return models;
  }

  private ladderIndex(models: Model<any>[], current?: Model<any>): number {
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

  private move(
    models: Model<any>[],
    current: Model<any> | undefined,
    direction: -1 | 1,
  ): Model<any> | undefined {
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

    const heuristic = this.heuristicClassify(transcript);
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
      return parseClassifierJson(await stream.result()) ?? heuristic;
    } catch (error) {
      console.error(`[${EXTENSION_TAG}] classifier failed, using heuristic:`, error);
      return heuristic;
    }
  }

  private heuristicClassify(transcript: string): RoutingDecision {
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
      sidekick:
        this.consecutiveFailures >= 2 ? "upgrade" : score <= 2 ? "downgrade" : "keep",
      reason: `heuristic ${score}/5 (hard=${hardHits}, easy=${easyHits}, failures=${this.consecutiveFailures})`,
    };
  }

  /** Apply a routing decision. Returns the records produced. */
  async applyRouting(
    decision: RoutingDecision,
    trigger: RouteRecord["trigger"],
  ): Promise<RouteRecord[]> {
    const records: RouteRecord[] = [];
    const models = this.ladder();

    const attempt = async (
      slot: "main" | "sidekick",
      direction: "keep" | "upgrade" | "downgrade",
    ): Promise<void> => {
      if (direction === "keep") return;
      const current = slot === "main" ? this.resolveMainModel() : this.resolveSidekickModel();
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
        this.setSidekickModel(target);
        record.applied = true;
      } else {
        const ok = await this.pi.setModel(target);
        if (ok) {
          const effort = clampEffort(target, this.config.main.effort);
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

  statusLines(): string[] {
    const main = this.resolveMainModel();
    const sidekick = this.resolveSidekickModel();
    const ratio = this.savingsRatio();
    return [
      `main ${shortModelKey(main)}${this.config.main.effort ? ` (${this.config.main.effort})` : ""}` +
        `  ·  sidekick ${shortModelKey(sidekick)}` +
        `${this.config.sidekick.effort ? ` (${this.config.sidekick.effort})` : ""}`,
      `delegations ${this.stats.delegations} (${this.stats.failures} failed)  ·  ` +
        `sidekick ${formatCost(this.stats.sidekickUsage.cost.total)}  ·  ` +
        `est. main-only ${formatCost(this.stats.estimatedMainCost)}  ·  ` +
        `saved ${(ratio * 100).toFixed(0)}%`,
    ];
  }

  footerStatus(): string {
    const base = `⚛ fusion ${shortModelKey(this.resolveSidekickModel())}`;
    if (this.stats.delegations === 0) return base;
    const saved = this.lifetimeSavings();
    return `${base} · ${(this.savingsRatio() * 100).toFixed(0)}% saved` +
      `${saved > 0 ? ` (${formatCost(saved)})` : ""}`;
  }

  snapshot(): FusionStats & { lifetime: LifetimeStats } {
    return {
      delegations: this.stats.delegations,
      failures: this.stats.failures,
      sidekickTurns: this.stats.sidekickTurns,
      sidekickUsage: cloneUsage(this.stats.sidekickUsage),
      mainUsage: cloneUsage(this.stats.mainUsage),
      estimatedMainCost: this.stats.estimatedMainCost,
      routes: [...this.stats.routes],
      lifetime: { ...this.lifetime },
    };
  }

  resetSessionStats(): void {
    this.stats = {
      delegations: 0,
      failures: 0,
      sidekickTurns: 0,
      sidekickUsage: emptyUsage(),
      mainUsage: emptyUsage(),
      estimatedMainCost: 0,
      routes: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function fusionExtension(pi: ExtensionAPI) {
  let config = loadConfig();
  let engine: FusionEngine | undefined;
  let userPickedModel = false;
  let internalModelChange = false;
  /** Session model active before fusion took over the main slot, for restore on /fusion off. */
  let preFusionModel: Model<any> | undefined;

  // Registration methods are the only API calls allowed while the extension is
  // still loading, so tool/action lookups are deferred to session_start.
  const toolName = "sidekick";
  const TOOL_MARKER = "Fusion sidekick agent";

  const persistConfig = (): void => {
    writeJsonFile(CONFIG_PATH, config);
    if (pi.events) {
      pi.events.emit("fusion_config_updated", config);
    }
  };

  if (pi.events) {
    pi.events.on("fusion_config_updated", (updated: any) => {
      if (updated && typeof updated === "object") {
        let changed = false;
        if (
          updated.main &&
          (updated.main.provider !== config.main.provider ||
            updated.main.modelId !== config.main.modelId ||
            updated.main.effort !== config.main.effort)
        ) {
          config.main = { ...config.main, ...updated.main };
          if (engine) engine.config.main = config.main;
          changed = true;
        }
        if (
          updated.sidekick &&
          (updated.sidekick.provider !== config.sidekick.provider ||
            updated.sidekick.modelId !== config.sidekick.modelId ||
            updated.sidekick.effort !== config.sidekick.effort)
        ) {
          config.sidekick = { ...config.sidekick, ...updated.sidekick };
          if (engine) {
            engine.config.sidekick = config.sidekick;
            const sidekickMdl = engine.resolveSidekickModel();
            if (sidekickMdl) {
              engine.setSidekickModel(sidekickMdl, config.sidekick.effort);
            }
          }
          changed = true;
        }
        if (changed) refreshUi();
      }
    });
  }

  const refreshUi = (ctx?: ExtensionContext): void => {
    const target = ctx ?? engine?.latestCtx;
    if (!engine || !target || !target.hasUI) return;
    try {
      target.ui.setStatus(EXTENSION_TAG, engine.footerStatus());
      target.ui.setWidget(EXTENSION_TAG, engine.statusLines());
    } catch {
      /* UI may be unavailable */
    }
  };

  const setSidekickToolActive = (active: boolean): void => {
    const current = pi.getActiveTools();
    const has = current.includes(toolName);
    if (active && !has) pi.setActiveTools([...current, toolName]);
    if (!active && has) pi.setActiveTools(current.filter((name) => name !== toolName));
  };

  // -- tool ----------------------------------------------------------------

  pi.registerTool({
    name: toolName,
    label: "Sidekick",
    description: [
      "Delegate one well-scoped, self-contained subtask to the cheaper Fusion sidekick agent",
      "and get its result back. The sidekick is a fully capable agent with its own tools and",
      "its own context; it cannot see this conversation, so the brief must stand alone.",
      "Delegations run one at a time.",
    ].join(" "),
    promptSnippet: "Delegate a well-scoped subtask to the cheaper Fusion sidekick agent",
    promptGuidelines: [
      `Use ${toolName} for mechanical, well-scoped work (targeted reads, greps, mechanical edits, running tests or builds) so the main model is reserved for planning, ambiguity and review.`,
      `Every ${toolName} brief must be self-contained: exact paths, exact acceptance criteria, and the exact output you want back.`,
    ],
    parameters: Type.Object({
      task: Type.String({
        description: "The subtask, written as a standalone brief with exact paths and acceptance criteria.",
      }),
      context: Type.Optional(
        Type.String({ description: "Extra context the sidekick needs but cannot discover itself." }),
      ),
      files: Type.Optional(Type.Array(Type.String(), { description: "Files the sidekick should focus on." })),
      expect: Type.Optional(
        StringEnum(["summary", "diff", "evidence", "raw"] as const, {
          description: "Shape of the answer you want back. Default: summary.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const activeEngine = engine;
      if (!activeEngine) {
        throw new Error("Fusion is not active in this session.");
      }
      activeEngine.setContext(ctx);

      let lastActivityCount = 0;
      const progress = setInterval(() => {
        if (activeEngine.activity.length === lastActivityCount) return;
        lastActivityCount = activeEngine.activity.length;
        onUpdate?.({
          content: [{ type: "text", text: activeEngine.activity.slice(-3).join("\n") }],
          details: { progress: true },
        });
      }, 400);

      let outcome;
      try {
        outcome = await activeEngine.delegate(
          { task: params.task, context: params.context, files: params.files, expect: params.expect },
          signal ?? undefined,
        );
      } finally {
        clearInterval(progress);
      }

      const meta =
        `${outcome.model ?? "sidekick"} · ${outcome.turns} turn${outcome.turns === 1 ? "" : "s"} · ` +
        `${formatTokens(outcome.usage.totalTokens)} tok · ${formatCost(outcome.usage.cost.total)}`;
      refreshUi(ctx);

      if (outcome.isError) {
        await activeEngine.maybeEscalate();
        refreshUi(ctx);
        const authProblem = /api key|auth|unauthorized|forbidden|credential/i.test(
          outcome.errorMessage ?? "",
        );
        throw new Error(
          `Sidekick delegation failed: ${outcome.errorMessage ?? "unknown error"}\n${meta}` +
            (authProblem ? "\n(hint: the sidekick provider may have no credentials — /fusion models)" : ""),
        );
      }

      return {
        content: [{ type: "text", text: outcome.text }],
        details: {
          model: outcome.model,
          turns: outcome.turns,
          usage: outcome.usage,
          activity: outcome.activity,
          meta,
        },
        usage: outcome.usage,
      };
    },

    renderCall(args, theme, context) {
      const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      let content = theme.fg("toolTitle", theme.bold(`${toolName} `));
      content += theme.fg("muted", truncate(String(args.task ?? ""), 72));
      component.setText(content);
      return component;
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg("warning", "… sidekick working"), 0, 0);
      }
      const details = (result.details ?? {}) as { meta?: string };
      const head = theme.fg("success", "✓ sidekick");
      const meta = theme.fg("dim", ` ${details.meta ?? ""}`);
      const preview = truncate(
        (result.content ?? []).map((part: any) => part.text ?? "").join(" "),
        100,
      );
      return new Text(`${head}${meta}\n${theme.fg("toolOutput", preview)}`, 0, 0);
    },
  });

  // -- session lifecycle ---------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig();
    restoreRoutedSidekick(config, ctx);
    engine = new FusionEngine(pi, ctx.modelRegistry, ctx.cwd, config);
    engine.setContext(ctx);
    userPickedModel = false;

    // Another extension may have claimed the same tool name; surface it rather
    // than silently losing one of the two tools.
    const registered = pi.getAllTools().find((tool) => tool.name === toolName);
    if (registered && !registered.description.includes(TOOL_MARKER) && ctx.hasUI) {
      ctx.ui.notify(
        `fusion: another extension registered a "${toolName}" tool — disable one of them.`,
        "warning",
      );
    }

    setSidekickToolActive(config.enabled);
    refreshUi(ctx);
  });

  pi.on("session_shutdown", async () => {
    engine?.dispose();
    engine = undefined;
  });

  pi.on("model_select", (event) => {
    if (internalModelChange) return;
    if (event.source === "set" || event.source === "cycle") userPickedModel = true;
  });

  // -- main-agent guidance -------------------------------------------------

  pi.on("before_agent_start", async (event) => {
    const activeEngine = engine;
    if (!activeEngine) return;
    const options = event.systemPromptOptions;
    if (!options) return;

    const sidekickModel = activeEngine.resolveSidekickModel();
    const shouldEnable = activeEngine.config.enabled && sidekickModel !== undefined;

    setSidekickToolActive(shouldEnable);
    if (!options.sections) return;
    if (!shouldEnable) {
      // Removing the key makes pi emit a section patch that drops it.
      delete options.sections[EXTENSION_TAG];
      return;
    }
    options.sections[EXTENSION_TAG] = buildMainGuidance(
      toolName,
      sidekickModel,
      activeEngine.config.sidekickTools,
    );
  });

  // -- main-model cost accounting -----------------------------------------

  pi.on("turn_end", async (event) => {
    const activeEngine = engine;
    if (!activeEngine) return;
    if (event.message?.role === "assistant") {
      addUsage(activeEngine.stats.mainUsage, event.message.usage);
    }
  });

  // -- dynamic mid-session routing ----------------------------------------

  pi.on("session_compact", async (_event, ctx) => {
    const activeEngine = engine;

    if (!activeEngine || !config.enabled) return;
    if (!config.routing.enabled || !config.routing.onCompact) return;
    // Never fight the user over an explicitly chosen model.
    if (userPickedModel) return;

    try {
      const transcript = buildTranscript(ctx);
      if (!transcript.trim()) return;
      const decision = await activeEngine.classify(ctx, transcript);
      if (!decision || (decision.main === "keep" && decision.sidekick === "keep")) return;

      internalModelChange = true;
      let records: RouteRecord[];
      try {
        records = await activeEngine.applyRouting(decision, "compact");
      } finally {
        internalModelChange = false;
      }

      const applied = records.filter((record) => record.applied);
      if (applied.length > 0 && ctx.hasUI) {
        for (const record of applied) {
          ctx.ui.notify(
            `fusion routed ${record.slot}: ${record.from} → ${record.to} (${record.reason})`,
            "info",
          );
        }
      } else if (records.length > 0 && ctx.hasUI) {
        ctx.ui.notify(
          `fusion suggests ${records.map((record) => `${record.slot}:${record.to}`).join(", ")} — /fusion route to apply`,
          "info",
        );
      }
      refreshUi(ctx);
    } catch (error) {
      console.error(`[${EXTENSION_TAG}] compaction routing failed:`, error);
    }
  });

  // -- main-slot sync ------------------------------------------------------

  /**
   * Point the session model (the footer's bottom-right display) at fusion's
   * configured main slot. `/fusion on` and the wizard state toggle call this so
   * the harness is actually live on the main model. Fusion-driven switches are
   * wrapped in `internalModelChange` so they don't count as user picks —
   * dynamic routing keeps ownership of the main slot while fusion is enabled.
   */
  const applyFusionMainSlot = async (ctx: ExtensionContext): Promise<void> => {
    const target = engine?.resolveMainModel();
    if (!target) {
      ctx.ui.notify(`fusion: main model ${modelKey()} is unavailable (no auth?) — session model unchanged.`, "error");
      return;
    }
    const current = ctx.getModel();
    if (current && modelsAreEqual(target, current)) return;

    const effort = clampEffort(target, config.main.effort);
    internalModelChange = true;
    try {
      const ok = await pi.setModel(target);
      if (!ok) {
        ctx.ui.notify(`fusion: no auth for main ${modelKey(target)} — session model unchanged.`, "error");
        return;
      }
      if (effort) pi.setThinkingLevel(effort);
      preFusionModel = current;
      ctx.ui.notify(
        `fusion main: ${current ? `${modelKey(current)} → ` : ""}${modelKey(target)}` +
          `${effort ? ` (effort: ${effort})` : ""}`,
        "info",
      );
    } finally {
      internalModelChange = false;
    }
  };

  /**
   * On /fusion off, hand the main slot back to whatever was active before
   * fusion enabled — unless the user explicitly picked a model since, in which
   * case their pick wins and stays.
   */
  const restorePreFusionModel = async (ctx: ExtensionContext): Promise<void> => {
    const target = preFusionModel;
    preFusionModel = undefined;
    if (!target || userPickedModel) return;
    const current = ctx.getModel();
    if (current && modelsAreEqual(target, current)) return;
    internalModelChange = true;
    try {
      const ok = await pi.setModel(target);
      if (ok) ctx.ui.notify(`fusion off — main restored to ${modelKey(target)}.`, "info");
    } finally {
      internalModelChange = false;
    }
  };

  // -- commands ------------------------------------------------------------

  pi.registerCommand("fusion", {
    description: "Fusion hybrid harness: status, model configuration, routing and stats",
    getArgumentCompletions: (prefix: string) => {
      const items = ["on", "off", "main", "sidekick", "status", "stats", "models", "route", "reset", "help"].map((value) => ({
        value,
        label: value,
      }));
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const activeEngine = engine;
      if (!activeEngine) {
        ctx.ui.notify("Fusion is not active in this session.", "error");
        return;
      }

      const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

      switch (sub) {
        case "main": {
          if (!ctx.hasUI) {
            ctx.ui.notify(`main=${modelKey(activeEngine.resolveMainModel())}`, "info");
            return;
          }
          const modelArg = args.trim().replace(/^main\s*/i, "").trim();
          if (modelArg) {
            const all = ctx.modelRegistry.getAll() || [];
            const targetModel = all.find(
              (m) =>
                m.id === modelArg ||
                `${m.provider}/${m.id}` === modelArg ||
                m.id.toLowerCase() === modelArg.toLowerCase() ||
                `${m.provider}/${m.id}`.toLowerCase() === modelArg.toLowerCase(),
            );
            if (targetModel) {
              const effort = clampThinkingLevel(targetModel, activeEngine.config.main.effort || "high") as EffortLevel;
              activeEngine.config.main = { provider: targetModel.provider, modelId: targetModel.id, effort };
              persistConfig();
              const ok = await pi.setModel(targetModel);
              if (ok && effort) pi.setThinkingLevel(effort);
              ctx.ui.notify(
                ok
                  ? `Main agent switched to ${modelKey(targetModel)}${effort ? ` (effort: ${effort})` : ""}.`
                  : `No auth for ${modelKey(targetModel)}.`,
                ok ? "info" : "error",
              );
              refreshUi(ctx);
              return;
            }
          }
          const result = await showModelPicker(ctx, pi, {
            target: "fusion-main",
            title: "Pick the main (frontier) agent model",
            initialModel: activeEngine.resolveMainModel() ?? activeEngine.config.main,
            initialEffort: activeEngine.config.main.effort as any,
          });
          if (result) {
            const { model, effort } = result;
            const effortLevel = effort as EffortLevel;
            activeEngine.config.main = { provider: model.provider, modelId: model.id, effort: effortLevel };
            persistConfig();
            const ok = await pi.setModel(model);
            if (ok && effortLevel) pi.setThinkingLevel(effortLevel);
            ctx.ui.notify(
              ok
                ? `Main agent switched to ${modelKey(model)}${effortLevel ? ` (effort: ${effortLevel})` : ""}.`
                : `No auth for ${modelKey(model)}.`,
              ok ? "info" : "error",
            );
            refreshUi(ctx);
          }
          return;
        }

        case "sidekick": {
          if (!ctx.hasUI) {
            ctx.ui.notify(`sidekick=${modelKey(activeEngine.resolveSidekickModel())}`, "info");
            return;
          }
          const modelArg = args.trim().replace(/^sidekick\s*/i, "").trim();
          if (modelArg) {
            const all = ctx.modelRegistry.getAll() || [];
            const targetModel = all.find(
              (m) =>
                m.id === modelArg ||
                `${m.provider}/${m.id}` === modelArg ||
                m.id.toLowerCase() === modelArg.toLowerCase() ||
                `${m.provider}/${m.id}`.toLowerCase() === modelArg.toLowerCase(),
            );
            if (targetModel) {
              const effort = clampThinkingLevel(targetModel, activeEngine.config.sidekick.effort || "low") as EffortLevel;
              activeEngine.setSidekickModel(targetModel, effort);
              persistConfig();
              ctx.ui.notify(
                `Sidekick switched to ${modelKey(targetModel)}${effort ? ` (effort: ${effort})` : ""}.`,
                "info",
              );
              refreshUi(ctx);
              return;
            }
          }
          const result = await showModelPicker(ctx, pi, {
            target: "fusion-sidekick",
            title: "Pick the sidekick (cheap) agent model",
            initialModel: activeEngine.resolveSidekickModel() ?? activeEngine.config.sidekick,
            initialEffort: activeEngine.config.sidekick.effort as any,
          });
          if (result) {
            const { model, effort } = result;
            const effortLevel = effort as EffortLevel;
            activeEngine.setSidekickModel(model, effortLevel);
            persistConfig();
            ctx.ui.notify(
              `Sidekick switched to ${modelKey(model)}${effortLevel ? ` (effort: ${effortLevel})` : ""}.`,
              "info",
            );
            refreshUi(ctx);
          }
          return;
        }
        case "on":
        case "off": {
          config.enabled = sub === "on";
          persistConfig();
          activeEngine.config = config;
          setSidekickToolActive(config.enabled);
          // Sync the session model (footer bottom-right) with the fusion main
          // slot on enable; hand it back on disable.
          if (config.enabled) {
            await applyFusionMainSlot(ctx);
          } else {
            await restorePreFusionModel(ctx);
          }
          refreshUi(ctx);
          ctx.ui.notify(`Fusion ${config.enabled ? "enabled" : "disabled"}.`, "info");
          return;
        }

        case "stats":
        case "status": {
          pi.appendEntry("fusion-stats", activeEngine.snapshot());
          return;
        }

        case "reset": {
          activeEngine.resetSidekick();
          activeEngine.resetSessionStats();
          refreshUi(ctx);
          ctx.ui.notify("Fusion sidekick context and session stats reset.", "info");
          return;
        }

        case "route": {
          const decision = await activeEngine.classify(ctx, buildTranscript(ctx));
          if (!decision) {
            ctx.ui.notify("Routing classifier is off — enable it in /fusion models.", "info");
            return;
          }
          const records = await activeEngine.applyRouting(decision, "manual");
          if (records.length === 0) {
            ctx.ui.notify(
              `No routing change suggested (difficulty ${decision.difficulty}/5: ${decision.reason}).`,
              "info",
            );
            return;
          }
          for (const record of records) {
            ctx.ui.notify(
              record.applied
                ? `fusion routed ${record.slot}: ${record.from} → ${record.to}`
                : `fusion suggests ${record.slot}: ${record.to} (auto-apply is off)`,
              "info",
            );
          }
          refreshUi(ctx);
          return;
        }

        case "models":
        case "": {
          if (!ctx.hasUI) {
            ctx.ui.notify(
              `main=${modelKey(activeEngine.resolveMainModel())} ` +
                `sidekick=${modelKey(activeEngine.resolveSidekickModel())}`,
              "info",
            );
            return;
          }
          await openConfigWizard(ctx, activeEngine, {
            persist: persistConfig,
            setMainModel: async (model) => pi.setModel(model),
            setThinkingLevel: (effort) => pi.setThinkingLevel(effort),
            appendStats: (activeEngine) => pi.appendEntry("fusion-stats", activeEngine.snapshot()),
            refreshUi,
            setEnableState: async (wizardCtx, enabled) => {
              if (enabled) await applyFusionMainSlot(wizardCtx);
              else await restorePreFusionModel(wizardCtx);
            },
          }, pi);
          return;
        }

        default: {
          ctx.ui.notify("Usage: /fusion [on|off|main|sidekick|status|stats|models|route|reset]", "info");
        }
      }
    },
  });

  pi.registerShortcut(Key.ctrlShift("f"), {
    description: "Open the Fusion menu",
    handler: async (ctx) => {
      const activeEngine = engine;
      if (!activeEngine || !ctx.hasUI) return;
      await openConfigWizard(ctx, activeEngine, {
        persist: persistConfig,
        setMainModel: async (model) => pi.setModel(model),
        setThinkingLevel: (effort) => pi.setThinkingLevel(effort),
        appendStats: (activeEngine) => pi.appendEntry("fusion-stats", activeEngine.snapshot()),
        refreshUi,
        setEnableState: async (wizardCtx, enabled) => {
          if (enabled) await applyFusionMainSlot(wizardCtx);
          else await restorePreFusionModel(wizardCtx);
        },
      }, pi);
    },
  });

  // -- transcript rendering ------------------------------------------------

  pi.registerEntryRenderer("fusion-route", (entry, { expanded }, theme) => {
    const record = (entry.data ?? {}) as RouteRecord;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const arrow = record.applied ? theme.fg("success", "→") : theme.fg("warning", "⇢");
    const slot = theme.fg("accent", record.slot ?? "?");
    box.addChild(
      new Text(
        `${theme.bold("fusion route")} ${arrow} ${slot}: ` +
          `${theme.fg("dim", record.from ?? "?")} → ${theme.fg("toolOutput", record.to ?? "?")}`,
        0,
        0,
      ),
    );
    box.addChild(
      new Text(
        theme.fg(
          "dim",
          `${record.trigger}${record.difficulty ? ` · difficulty ${record.difficulty}/5` : ""} · ${record.reason ?? ""}`,
        ),
        0,
        0,
      ),
    );
    if (expanded) {
      box.addChild(new Text(theme.fg("dim", JSON.stringify(record, null, 2)), 0, 0));
    }
    return box;
  });

  pi.registerEntryRenderer("fusion-stats", (entry, { expanded }, theme) => {
    const stats = (entry.data ?? {}) as FusionStats & { lifetime?: LifetimeStats };
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const ratio =
      stats.estimatedMainCost > 0
        ? Math.max(
            0,
            (stats.estimatedMainCost - (stats.sidekickUsage?.cost?.total ?? 0)) / stats.estimatedMainCost,
          )
        : 0;
    box.addChild(new Text(theme.bold("fusion session"), 0, 0));
    box.addChild(
      new Text(
        `delegations ${stats.delegations ?? 0} (${stats.failures ?? 0} failed) · ` +
          `sidekick turns ${stats.sidekickTurns ?? 0}`,
        0,
        0,
      ),
    );
    box.addChild(
      new Text(
        `sidekick ${formatCost(stats.sidekickUsage?.cost?.total ?? 0)} · ` +
          `main ${formatCost(stats.mainUsage?.cost?.total ?? 0)} · ` +
          `est. main-only ${formatCost(stats.estimatedMainCost ?? 0)} · ` +
          theme.fg("success", `saved ${(ratio * 100).toFixed(0)}%`),
        0,
        0,
      ),
    );
    if (stats.lifetime) {
      box.addChild(
        new Text(
          theme.fg(
            "dim",
            `lifetime: ${stats.lifetime.delegations} delegations · ` +
              `sidekick ${formatCost(stats.lifetime.sidekickCost)} · ` +
              `est. main-only ${formatCost(stats.lifetime.estimatedMainCost)} · ` +
              `saved ${formatCost(Math.max(0, stats.lifetime.estimatedMainCost - stats.lifetime.sidekickCost))}`,
          ),
          0,
          0,
        ),
      );
    }
    if (expanded && stats.routes?.length) {
      box.addChild(new Text(theme.bold("routing decisions"), 0, 0));
      for (const route of stats.routes.slice(-10)) {
        box.addChild(
          new Text(
            theme.fg(
              "dim",
              `${new Date(route.at).toLocaleTimeString()} ${route.trigger} ${route.slot}: ` +
                `${route.from} → ${route.to}${route.applied ? "" : " (not applied)"}`,
            ),
            0,
            0,
          ),
        );
      }
    }
    return box;
  });
}

// ---------------------------------------------------------------------------
// Interactive configuration wizard
// ---------------------------------------------------------------------------

interface WizardHooks {
  persist: () => void;
  setMainModel: (model: Model<any>) => Promise<boolean>;
  setThinkingLevel: (effort: EffortLevel) => void;
  appendStats: (engine: FusionEngine) => void;
  refreshUi: (ctx?: ExtensionContext) => void;
  /** Sync the session model with the main slot when fusion is toggled. */
  setEnableState: (ctx: ExtensionContext, enabled: boolean) => Promise<void>;
}

async function openConfigWizard(
  ctx: ExtensionContext,
  engine: FusionEngine,
  hooks: WizardHooks,
  pi: ExtensionAPI,
): Promise<void> {
  while (true) {
    const routing = engine.config.routing;
    const choice = await ctx.ui.select("Fusion", [
      `main agent: ${modelKey(engine.resolveMainModel())}` +
        `${engine.config.main.effort ? ` (${engine.config.main.effort})` : ""}`,
      `sidekick: ${modelKey(engine.resolveSidekickModel())}` +
        `${engine.config.sidekick.effort ? ` (${engine.config.sidekick.effort})` : ""}`,
      `sidekick tools: ${engine.config.sidekickTools.join(", ") || "(none)"}`,
      `routing: ${routing.enabled ? (routing.autoApply ? "auto" : "suggest-only") : "off"} · ${routing.mode}`,
      `state: ${engine.config.enabled ? "enabled" : "disabled"}`,
      "session stats",
      "route now",
      "reset sidekick context",
      "done",
    ]);
    if (!choice || choice === "done") return;

    if (choice.startsWith("main agent:")) {
      const result = await showModelPicker(ctx, pi, {
        target: "fusion-main",
        title: "Pick the main (frontier) agent model",
        initialModel: engine.resolveMainModel() ?? engine.config.main,
        initialEffort: engine.config.main.effort as any,
      });
      if (!result) continue;
      const { model, effort } = result;
      const effortLevel = effort as EffortLevel;
      engine.config.main = { provider: model.provider, modelId: model.id, effort: effortLevel };
      hooks.persist();
      const ok = await hooks.setMainModel(model);
      if (ok && effortLevel) hooks.setThinkingLevel(effortLevel);
      ctx.ui.notify(
        ok
          ? `Main agent switched to ${modelKey(model)}${effortLevel ? ` (effort: ${effortLevel})` : ""}.`
          : `No auth for ${modelKey(model)}.`,
        ok ? "info" : "error",
      );
      hooks.refreshUi(ctx);
      continue;
    }

    if (choice.startsWith("sidekick:")) {
      const result = await showModelPicker(ctx, pi, {
        target: "fusion-sidekick",
        title: "Pick the sidekick (cheap) agent model",
        initialModel: engine.resolveSidekickModel() ?? engine.config.sidekick,
        initialEffort: engine.config.sidekick.effort as any,
      });
      if (!result) continue;
      const { model, effort } = result;
      const effortLevel = effort as EffortLevel;
      engine.setSidekickModel(model, effortLevel);
      hooks.persist();
      ctx.ui.notify(
        `Sidekick switched to ${modelKey(model)}${effortLevel ? ` (effort: ${effortLevel})` : ""}.`,
        "info",
      );
      hooks.refreshUi(ctx);
      continue;
    }

    if (choice.startsWith("sidekick tools:")) {
      const all = ["read", "grep", "find", "ls", "bash", "edit", "write"];
      const selected = new Set(engine.config.sidekickTools);
      while (true) {
        const toolChoice = await ctx.ui.select(
          "Sidekick tools",
          [...all.map((name) => `${selected.has(name) ? "[x]" : "[ ]"} ${name}`), "done"],
        );
        if (!toolChoice || toolChoice === "done") break;
        const name = toolChoice.replace(/^\[[ x]\] /, "");
        if (selected.has(name)) selected.delete(name);
        else selected.add(name);
      }
      engine.config.sidekickTools = all.filter((name) => selected.has(name));
      engine.resetSidekick();
      hooks.persist();
      ctx.ui.notify(`Sidekick tools: ${engine.config.sidekickTools.join(", ") || "(none)"}`, "info");
      continue;
    }

    if (choice.startsWith("routing:")) {
      const modeChoice = await ctx.ui.select("Routing classifier", ["llm", "heuristic", "off"]);
      if (modeChoice) engine.config.routing.mode = modeChoice as FusionRoutingConfig["mode"];
      const applyChoice = await ctx.ui.select("Apply routing changes", ["automatically", "suggest only"]);
      engine.config.routing.autoApply = applyChoice !== "suggest only";
      const enabledChoice = await ctx.ui.select("Dynamic routing", ["enabled", "disabled"]);
      engine.config.routing.enabled = enabledChoice !== "disabled";
      hooks.persist();
      continue;
    }

    if (choice.startsWith("state:")) {
      engine.config.enabled = !engine.config.enabled;
      hooks.persist();
      await hooks.setEnableState(ctx, engine.config.enabled);
      ctx.ui.notify(`Fusion ${engine.config.enabled ? "enabled" : "disabled"}.`, "info");
      continue;
    }

    if (choice === "session stats") {
      hooks.appendStats(engine);
      continue;
    }

    if (choice === "route now") {
      const decision = await engine.classify(ctx, buildTranscript(ctx));
      if (!decision) {
        ctx.ui.notify("Routing classifier is off.", "info");
        continue;
      }
      const records = await engine.applyRouting(decision, "manual");
      ctx.ui.notify(
        records.length > 0
          ? records
              .map((record) =>
                `${record.slot}: ${record.from} → ${record.to}${record.applied ? "" : " (not applied)"}`,
              )
              .join("\n")
          : `No change suggested (difficulty ${decision.difficulty}/5: ${decision.reason})`,
        "info",
      );
      continue;
    }

    if (choice === "reset sidekick context") {
      engine.resetSidekick();
      ctx.ui.notify("Sidekick context reset.", "info");
      continue;
    }
  }
}

