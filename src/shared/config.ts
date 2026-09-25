/**
 * The single source of truth for this package's user-level config files:
 *
 *   <agentDir>/settings.json     — pi's own settings (defaultModel, modelThinkingLevels)
 *   <agentDir>/model-roles.json  — small / daily / frontier role assignments
 *   <agentDir>/fusion.json       — Fusion main/sidekick slots, routing, limits
 *
 * Paths are resolved on every call (not at import time) so PI_CODING_AGENT_DIR
 * changes, and tests, are honoured. Loading never writes a file.
 */

import * as path from "node:path";
import { getAgentDir as piAgentDir } from "@earendil-works/pi-coding-agent";
import { readJsonFile, writeJsonFile } from "./json-store.js";
import type { EffortLevel, ModelRef } from "./models.js";
import { DEFAULT_DELEGATION } from "../fusion/policy.js";
import type { DelegationConfig } from "../fusion/policy.js";

export function agentDir(): string {
  return piAgentDir();
}

export const settingsPath = (): string => path.join(agentDir(), "settings.json");
export const rolesPath = (): string => path.join(agentDir(), "model-roles.json");
export const fusionConfigPath = (): string => path.join(agentDir(), "fusion.json");
export const fusionStatsPath = (): string => path.join(agentDir(), "fusion-stats.json");
export const factoryConfigPath = (): string => path.join(agentDir(), "factory.json");

// ---------------------------------------------------------------------------
// settings.json
// ---------------------------------------------------------------------------

export function readSettings(): Record<string, any> {
  return readJsonFile(settingsPath()) ?? {};
}

export function writeSettings(settings: Record<string, any>): void {
  writeJsonFile(settingsPath(), settings);
}

export function getModelThinkingLevel(provider: string, modelId: string): EffortLevel | undefined {
  return readSettings().modelThinkingLevels?.[`${provider}/${modelId}`];
}

export function saveModelThinkingLevel(provider: string, modelId: string, level: EffortLevel): void {
  const settings = readSettings();
  settings.modelThinkingLevels = { ...(settings.modelThinkingLevels ?? {}), [`${provider}/${modelId}`]: level };
  writeSettings(settings);
}

// ---------------------------------------------------------------------------
// model-roles.json
// ---------------------------------------------------------------------------

export type RoleName = "daily" | "small" | "frontier";
export type RoleConfig = ModelRef;

export interface ModelRolesState {
  roles: { daily?: RoleConfig; small?: RoleConfig; frontier?: RoleConfig };
  defaultModel?: { provider: string; modelId: string };
}

/**
 * Role assignments. When the file does not exist yet, roles are empty — there
 * are no hard-coded model IDs to go stale, and nothing is written on read.
 * Tier defaults are derived from the logged-in models instead (see tiers.ts).
 */
export function loadRolesState(): ModelRolesState {
  const data = readJsonFile<ModelRolesState>(rolesPath());
  if (data && data.roles && typeof data.roles === "object") return { ...data, roles: { ...data.roles } };
  const settings = readSettings();
  const state: ModelRolesState = { roles: {} };
  if (settings.defaultProvider && settings.defaultModel) {
    state.defaultModel = { provider: settings.defaultProvider, modelId: settings.defaultModel };
  }
  return state;
}

export function saveRolesState(state: ModelRolesState): void {
  writeJsonFile(rolesPath(), state);
}

export function saveDefaultModelToSettings(provider: string, modelId: string): void {
  const settings = readSettings();
  settings.defaultProvider = provider;
  settings.defaultModel = modelId;
  writeSettings(settings);

  const rolesState = loadRolesState();
  rolesState.defaultModel = { provider, modelId };
  rolesState.roles.daily = rolesState.roles.daily
    ? { ...rolesState.roles.daily, provider, modelId }
    : { provider, modelId, effort: "medium" };
  saveRolesState(rolesState);
}

// ---------------------------------------------------------------------------
// fusion.json
// ---------------------------------------------------------------------------

export type FusionSlot = ModelRef;

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
  /**
   * Trim the sidekick's history when its last prompt used more than this
   * fraction of its model's context window. Trimming changes the cached
   * prefix, so it should be rare.
   */
  maxContextFraction: number;
}

export interface FusionCacheConfig {
  /**
   * Prompt-cache retention for sidekick requests. "auto" asks for long
   * retention when the model declares a long cache lifetime (e.g. 1 h on
   * Anthropic, 24 h on OpenAI) so the cache survives gaps between
   * delegations, and otherwise uses the provider default. PI_CACHE_RETENTION
   * in the environment still wins for "auto".
   */
  sidekickRetention: "auto" | "short" | "long" | "none";
}

export interface FusionConfig {
  enabled: boolean;
  /** Unset until chosen or seeded from roles; resolved from logged-in models otherwise. */
  main?: FusionSlot;
  sidekick?: FusionSlot;
  /** Tool names the sidekick may use. */
  sidekickTools: string[];
  routing: FusionRoutingConfig;
  limits: FusionLimits;
  /** Prompt-cache settings for the sidekick. */
  cache: FusionCacheConfig;
  /** How strongly the main agent is steered to delegate (see src/fusion/policy.ts). */
  delegation: DelegationConfig;
  /** Optional override for the sidekick system prompt. */
  sidekickPrompt?: string;
  /** Keyboard shortcut that opens the Fusion menu (pi keybinding syntax). */
  shortcut?: string;
}

export const DEFAULT_SIDEKICK_TOOLS = ["read", "grep", "find", "ls", "bash"];
export const DEFAULT_FUSION_SHORTCUT = "ctrl+shift+d";

export function defaultFusionConfig(): FusionConfig {
  return {
    enabled: true,
    sidekickTools: [...DEFAULT_SIDEKICK_TOOLS],
    routing: { enabled: true, mode: "llm", autoApply: true, onCompact: true, escalateOnFailure: true },
    limits: { maxTurns: 12, maxMessages: 400, maxContextFraction: 0.5 },
    cache: { sidekickRetention: "auto" },
    delegation: { ...DEFAULT_DELEGATION },
    shortcut: DEFAULT_FUSION_SHORTCUT,
  };
}

function validSlot(value: unknown): FusionSlot | undefined {
  const slot = value as FusionSlot | undefined;
  return slot && typeof slot.provider === "string" && typeof slot.modelId === "string" ? { ...slot } : undefined;
}

/**
 * Load fusion.json merged over defaults. Unset slots are seeded from the
 * model-picker roles (frontier → main, small → sidekick) so both extensions
 * agree on what those words mean.
 */
export function loadFusionConfig(): FusionConfig {
  const stored = readJsonFile<Record<string, any>>(fusionConfigPath()) ?? {};
  const defaults = defaultFusionConfig();
  const roles = loadRolesState().roles;
  const config: FusionConfig = {
    ...defaults,
    enabled: typeof stored.enabled === "boolean" ? stored.enabled : defaults.enabled,
    main: validSlot(stored.main) ?? validSlot(roles.frontier ?? roles.daily),
    sidekick: validSlot(stored.sidekick) ?? validSlot(roles.small ?? roles.daily),
    sidekickTools: Array.isArray(stored.sidekickTools)
      ? stored.sidekickTools.filter((name: unknown) => typeof name === "string")
      : [...DEFAULT_SIDEKICK_TOOLS],
    routing: { ...defaults.routing, ...(stored.routing ?? {}) },
    limits: normalizeLimits(stored.limits, defaults.limits),
    cache: {
      sidekickRetention: ["auto", "short", "long", "none"].includes(stored.cache?.sidekickRetention)
        ? stored.cache.sidekickRetention
        : defaults.cache.sidekickRetention,
    },
    delegation: normalizeDelegation(stored.delegation),
    sidekickPrompt: typeof stored.sidekickPrompt === "string" ? stored.sidekickPrompt : undefined,
    shortcut:
      typeof stored.shortcut === "string" && stored.shortcut.trim()
        ? stored.shortcut.trim().toLowerCase()
        : defaults.shortcut,
  };
  return config;
}

function normalizeLimits(raw: any, defaults: FusionLimits): FusionLimits {
  const limits = { ...defaults, ...(raw && typeof raw === "object" ? raw : {}) };
  // 40 was the old default written into fusion.json; it trimmed (and broke the
  // sidekick's prompt cache) every 10-20 delegations. Treat it as the new default.
  if (limits.maxMessages === 40) limits.maxMessages = defaults.maxMessages;
  if (!Number.isFinite(limits.maxContextFraction) || limits.maxContextFraction <= 0 || limits.maxContextFraction > 0.95) {
    limits.maxContextFraction = defaults.maxContextFraction;
  }
  return limits;
}

function normalizeDelegation(raw: any): DelegationConfig {
  const d = { ...DEFAULT_DELEGATION };
  if (raw && typeof raw === "object") {
    if (["advisory", "balanced", "strict"].includes(raw.mode)) d.mode = raw.mode;
    if (Number.isFinite(raw.nudgeAfter) && raw.nudgeAfter >= 0) d.nudgeAfter = Math.floor(raw.nudgeAfter);
    if (Number.isFinite(raw.compressOutputChars) && raw.compressOutputChars >= 0) d.compressOutputChars = Math.floor(raw.compressOutputChars);
    for (const key of ["slowCommandMs", "commandTimeoutSec", "resultCapChars"] as const) {
      if (Number.isFinite(raw[key]) && raw[key] >= 0) d[key] = Math.floor(raw[key]);
    }
    if (typeof raw.briefContext === "boolean") d.briefContext = raw.briefContext;
  }
  return d;
}

export function saveFusionConfig(config: FusionConfig): void {
  writeJsonFile(fusionConfigPath(), config);
}

/** Read-modify-write a subset of fusion.json, preserving everything else. */
export function updateFusionConfig(patch: Partial<FusionConfig>): FusionConfig {
  const next = { ...loadFusionConfig(), ...patch };
  saveFusionConfig(next);
  return next;
}

/** Event name used to tell a running Fusion extension that fusion.json changed. */
export const FUSION_CONFIG_EVENT = "fusion_config_updated";
