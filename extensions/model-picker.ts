/**
 * Two-Panel Vertical Split Model Picker, Role Manager & Effort Controller for Pi
 *
 * Capabilities:
 * 1. Two-Panel Vertical Split Picker (/models, /mp, /picker, /model-picker, Ctrl+Shift+M):
 *    - Left Panel: Provider selector with auth indicators and model counts.
 *    - Right Panel: Model selector with context window, thinking/reasoning badges, and vision indicators.
 *    - Full arrow-key navigation:
 *        ← / → : Switch focus between Provider and Model panels.
 *        ↑ / ↓ : Navigate items within the focused panel.
 *        Enter : Select and switch to highlighted model (pi.setModel).
 *        Tab   : Toggle between "Configured providers only" and "All providers".
 *        /     : Search / filter models in real time.
 *        Esc   : Clear search or exit picker.
 *
 * 2. Model Effort Picking & Reasoning Controller:
 *    - In Picker:
 *        Press 'e' : Open interactive Reasoning Effort Picker for highlighted model
 *                    (displays and allows picking ONLY levels supported by that model!).
 *                    Inside effort picker:
 *                      ↑ / ↓       : Navigate between supported effort levels.
 *                      e           : Cycle to next supported effort level.
 *                      Enter       : Apply chosen effort to model (persisted in settings.json).
 *                      Space       : Apply chosen effort AND immediately switch to that model.
 *                      Esc / ←     : Cancel back to model list.
 *                      0-9         : Jump directly to effort tier by index.
 *    - In Spec Card:
 *        Displays model thinking capability, current configured effort, and exact supported levels.
 *    - In Model List:
 *        Displays reasoning badge with effective effort (e.g. 🧠 high, 🧠 med).
 *    - Slash commands:
 *        /effort                    : Interactive selector with only supported levels for active model.
 *        /effort <level>            : Set reasoning effort directly (clamped to model capabilities).
 *        /effort <model> <level>    : Set default reasoning effort for any model.
 *        /effort <model>            : Interactive effort selector for a specific model.
 *        /thinking                  : Alias of /effort.
 *        Argument completions dynamically adapt to active model's supported levels.
 *
 * 3. Preconfigured Roles & Default Models:
 *    - Daily / Default  : Workhorse model for daily tasks & startup default (e.g. Claude 3.7 Sonnet / GPT-4o).
 *    - Small / Tiny     : Fast, lightweight model for tiny tasks (e.g. Claude 3.5 Haiku / GPT-4o-mini).
 *    - Frontier / Deep  : Advanced reasoning model for complex tasks (e.g. Claude 3.7 Sonnet / o3-mini with high effort).
 *    - In Picker:
 *        Press 'd' : Assign highlighted model as Daily / Default (clamped to model's effort support).
 *        Press 's' : Assign highlighted model as Small (clamped to model's effort support).
 *        Press 'f' : Assign highlighted model as Frontier (clamped to model's effort support).
 *        Press '1' : Quick-switch to Daily model.
 *        Press '2' : Quick-switch to Small model.
 *        Press '3' : Quick-switch to Frontier model.
 *    - Slash commands:
 *        /role [daily|small|frontier] : Switch role or open interactive role menu.
 *        /daily, /small, /frontier    : Direct role activation shortcuts.
 *        /default [model]             : Set startup default model.
 *
 * 4. Fusion Model Selection & Slot Assignment:
 *    - Model picker natively supports selecting models and effort for Fusion slots (main/sidekick).
 *    - In Picker:
 *        Press 'm' : Assign highlighted model as Fusion Main (frontier) agent.
 *        Press 'k' : Assign highlighted model as Fusion Sidekick (cheap) agent.
 *        Press '4' : Quick-switch to Fusion Main model.
 *        Press '5' : Quick-switch to Fusion Sidekick model.
 *    - Full two-panel picker with in-picker effort picking replaces separate selectors.
 *
 * 5. Clean Shutdown (/exit, /quit):
 *    - /exit : Gracefully shuts down Pi via ctx.shutdown().
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Model } from "@earendil-works/pi-ai";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  modelsAreEqual,
} from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// --- Types & Interfaces ---

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const EFFORT_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  off: "No reasoning / thinking tokens (fastest response)",
  minimal: "Minimal thinking tokens (light reasoning, ~1k tokens)",
  low: "Low thinking effort (quick analysis, ~2k tokens)",
  medium: "Medium thinking effort (balanced reasoning, ~8k tokens)",
  high: "High thinking effort (deep reasoning & architecture, ~16k tokens)",
  xhigh: "Extra high thinking effort (complex proofs & debugging, ~32k tokens)",
  max: "Maximum reasoning budget (exhaustive reasoning)",
};

export const EFFORT_ALIASES: Record<string, ThinkingLevel> = {
  off: "off",
  none: "off",
  disable: "off",
  disabled: "off",
  "0": "off",
  minimal: "minimal",
  min: "minimal",
  "1": "minimal",
  low: "low",
  "2": "low",
  medium: "medium",
  med: "medium",
  mid: "medium",
  "3": "medium",
  high: "high",
  hi: "high",
  "4": "high",
  xhigh: "xhigh",
  "extra-high": "xhigh",
  "5": "xhigh",
  max: "max",
  maximum: "max",
  full: "max",
  "6": "max",
};

export interface RoleConfig {
  provider: string;
  modelId: string;
  effort?: ThinkingLevel;
}

export interface ModelRolesState {
  roles: {
    daily?: RoleConfig;
    small?: RoleConfig;
    frontier?: RoleConfig;
  };
  defaultModel?: {
    provider: string;
    modelId: string;
  };
}

interface ProviderGroup {
  id: string;
  displayName: string;
  hasAuth: boolean;
  isCurrent: boolean;
  models: Model<any>[];
}

// --- Model Capabilities Helpers ---

/**
 * Returns true if the model supports reasoning tokens and has at least
 * one thinking level other than "off" available.
 */
export function isReasoningModel(model?: Model<any> | null): boolean {
  if (!model || !model.reasoning) return false;
  const levels = getSupportedThinkingLevels(model);
  return levels.some((l) => l !== "off");
}

/**
 * Returns the exact list of thinking levels supported by the model.
 * For non-reasoning models, returns ["off"].
 */
export function getModelSupportedThinkingLevels(model?: Model<any> | null): ThinkingLevel[] {
  if (!model) return ["off"];
  return getSupportedThinkingLevels(model) as ThinkingLevel[];
}

// --- Persistence Helpers ---

export function getAgentDir(): string {
  const custom = process.env.PI_CODING_AGENT_DIR;
  return custom && custom.trim() ? custom.trim() : path.join(os.homedir(), ".pi", "agent");
}

export const ROLES_FILE_PATH = path.join(getAgentDir(), "model-roles.json");
export const SETTINGS_FILE_PATH = path.join(getAgentDir(), "settings.json");
export const FUSION_CONFIG_PATH = path.join(getAgentDir(), "fusion.json");

// --- Fusion Config Helpers ---

export interface FusionSlotConfig {
  provider: string;
  modelId: string;
  effort?: ThinkingLevel;
}

export interface FusionConfigFile {
  enabled?: boolean;
  main?: FusionSlotConfig;
  sidekick?: FusionSlotConfig;
  sidekickTools?: string[];
  routing?: {
    enabled?: boolean;
    mode?: "llm" | "heuristic" | "off";
    autoApply?: boolean;
    onCompact?: boolean;
    escalateOnFailure?: boolean;
  };
  limits?: { maxTurns?: number; maxMessages?: number };
  sidekickPrompt?: string;
  [key: string]: unknown;
}

export function loadFusionConfig(): FusionConfigFile {
  if (fs.existsSync(FUSION_CONFIG_PATH)) {
    try {
      const content = fs.readFileSync(FUSION_CONFIG_PATH, "utf8");
      const data = JSON.parse(content);
      if (data && typeof data === "object") return data as FusionConfigFile;
    } catch {}
  }

  const roles = loadRolesState().roles;
  return {
    enabled: true,
    main: roles.frontier
      ? { provider: roles.frontier.provider, modelId: roles.frontier.modelId, effort: roles.frontier.effort }
      : { provider: "anthropic", modelId: "claude-sonnet-4-5", effort: "high" },
    sidekick: roles.small
      ? { provider: roles.small.provider, modelId: roles.small.modelId, effort: roles.small.effort }
      : { provider: "anthropic", modelId: "claude-haiku-4-5", effort: "low" },
  };
}

export function saveFusionConfig(config: FusionConfigFile): void {
  try {
    const dir = path.dirname(FUSION_CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FUSION_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  } catch (e) {
    console.error("Failed to write fusion.json:", e);
  }
}

// --- Model Picker Options & Results ---

export interface ModelPickerOptions {
  /** Target selection mode:
   * - "session": normal model picker, switches active session model on Enter (default)
   * - "fusion-main": selects model & effort for Fusion Main agent
   * - "fusion-sidekick": selects model & effort for Fusion Sidekick agent
   * - "select": general selection, returns chosen model and effort
   */
  target?: "session" | "fusion-main" | "fusion-sidekick" | "select";
  title?: string;
  initialModel?: Model<any> | { provider: string; modelId: string };
  initialEffort?: ThinkingLevel;
  applyToSession?: boolean;
}

export interface ModelPickerResult {
  model: Model<any>;
  effort: ThinkingLevel;
}

function readSettingsFile(): Record<string, any> {
  if (fs.existsSync(SETTINGS_FILE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE_PATH, "utf8"));
    } catch {
      return {};
    }
  }
  return {};
}

function writeSettingsFile(settings: Record<string, any>): void {
  try {
    const dir = path.dirname(SETTINGS_FILE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");
  } catch (e) {
    console.error("Failed to write settings.json:", e);
  }
}

/**
 * Read the configured thinking level for a specific model from ~/.pi/agent/settings.json
 * (under `modelThinkingLevels`). Pi core uses this setting natively when switching models.
 */
export function getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined {
  const settings = readSettingsFile();
  return settings.modelThinkingLevels?.[`${provider}/${modelId}`];
}

/**
 * Persist the configured thinking level for a specific model into ~/.pi/agent/settings.json
 * (under `modelThinkingLevels`).
 */
export function saveModelThinkingLevel(provider: string, modelId: string, level: ThinkingLevel): void {
  const settings = readSettingsFile();
  if (!settings.modelThinkingLevels) {
    settings.modelThinkingLevels = {};
  }
  settings.modelThinkingLevels[`${provider}/${modelId}`] = level;
  writeSettingsFile(settings);
}

export function loadRolesState(): ModelRolesState {
  if (fs.existsSync(ROLES_FILE_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(ROLES_FILE_PATH, "utf8"));
      if (data && data.roles) return data as ModelRolesState;
    } catch {}
  }

  // Generate intelligent initial state from settings.json
  const settings = readSettingsFile();
  const defaultProvider = settings.defaultProvider || "anthropic";
  const defaultModel = settings.defaultModel || "claude-3-7-sonnet";

  const initial: ModelRolesState = {
    roles: {
      daily: {
        provider: defaultProvider,
        modelId: defaultModel,
        effort: "medium",
      },
      small: {
        provider: defaultProvider === "openai" ? "openai" : "anthropic",
        modelId: defaultProvider === "openai" ? "gpt-4o-mini" : "claude-3-5-haiku",
        effort: "off",
      },
      frontier: {
        provider: defaultProvider,
        modelId: defaultModel,
        effort: "high",
      },
    },
    defaultModel: {
      provider: defaultProvider,
      modelId: defaultModel,
    },
  };

  saveRolesState(initial);
  return initial;
}

export function saveRolesState(state: ModelRolesState): void {
  try {
    const dir = path.dirname(ROLES_FILE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ROLES_FILE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch (e) {
    console.error("Failed to write model-roles.json:", e);
  }
}

export function saveDefaultModelToSettings(provider: string, modelId: string): void {
  const settings = readSettingsFile();
  settings.defaultProvider = provider;
  settings.defaultModel = modelId;
  writeSettingsFile(settings);

  // Update roles state defaultModel as well
  const rolesState = loadRolesState();
  rolesState.defaultModel = { provider, modelId };
  if (!rolesState.roles.daily) {
    rolesState.roles.daily = { provider, modelId, effort: "medium" };
  } else {
    rolesState.roles.daily.provider = provider;
    rolesState.roles.daily.modelId = modelId;
  }
  saveRolesState(rolesState);
}

/**
 * Determine the effective thinking effort for any model:
 * 1. If currently active in session and currentSessionEffort provided -> clamp that level.
 * 2. If configured in settings.json modelThinkingLevels -> use that if supported.
 * 3. If configured in fusion.json (main or sidekick) -> clamp that level.
 * 4. If configured in model-roles.json -> clamp that level.
 * 5. If global settings.json defaultThinkingLevel set -> clamp that level.
 * 6. Default fallback -> clamp "medium" (or lowest/highest supported).
 */
export function getEffectiveModelEffort(
  model: Model<any>,
  ctxModel?: Model<any>,
  currentSessionEffort?: ThinkingLevel,
  rolesState?: ModelRolesState,
  fusionConfig?: FusionConfigFile
): ThinkingLevel {
  if (!isReasoningModel(model)) {
    return "off";
  }

  const supported = getModelSupportedThinkingLevels(model);

  // 1. If active in session, active level has precedence
  if (ctxModel && modelsAreEqual(ctxModel, model) && currentSessionEffort) {
    return clampThinkingLevel(model, currentSessionEffort as any) as ThinkingLevel;
  }

  // 2. Check settings.json modelThinkingLevels
  const configured = getModelThinkingLevel(model.provider, model.id);
  if (configured && supported.includes(configured)) {
    return configured;
  }

  // 3. Check fusion config
  if (fusionConfig) {
    if (
      fusionConfig.main?.provider === model.provider &&
      fusionConfig.main?.modelId === model.id &&
      fusionConfig.main.effort
    ) {
      return clampThinkingLevel(model, fusionConfig.main.effort as any) as ThinkingLevel;
    }
    if (
      fusionConfig.sidekick?.provider === model.provider &&
      fusionConfig.sidekick?.modelId === model.id &&
      fusionConfig.sidekick.effort
    ) {
      return clampThinkingLevel(model, fusionConfig.sidekick.effort as any) as ThinkingLevel;
    }
  }

  // 4. Check roles state
  if (rolesState) {
    for (const rKey of ["daily", "frontier", "small"] as const) {
      const r = rolesState.roles[rKey];
      if (r?.provider === model.provider && r?.modelId === model.id && r.effort) {
        return clampThinkingLevel(model, r.effort as any) as ThinkingLevel;
      }
    }
  }

  // 5. Global defaultThinkingLevel in settings.json
  const settings = readSettingsFile();
  if (settings.defaultThinkingLevel) {
    return clampThinkingLevel(model, settings.defaultThinkingLevel) as ThinkingLevel;
  }

  // 6. Fallback clamped to medium (or whatever model supports)
  return clampThinkingLevel(model, "medium") as ThinkingLevel;
}

// --- Text & Formatting Helpers ---

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[22m`;
}

function pad(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w > width) return truncateToWidth(text, width);
  return text + " ".repeat(Math.max(0, width - w));
}

function formatTokens(tokens?: number): string {
  if (!tokens || tokens <= 0) return "Unknown";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m % 1 === 0 ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return `${k % 1 === 0 ? k : k.toFixed(0)}k`;
  }
  return tokens.toString();
}

function formatCost(cost?: { input: number; output: number; cacheRead?: number }): string | null {
  if (!cost || (cost.input === 0 && cost.output === 0)) return null;
  const inStr = `$${cost.input.toFixed(2)}`;
  const outStr = `$${cost.output.toFixed(2)}`;
  return `In: ${inStr}/M · Out: ${outStr}/M`;
}

function buildProviderGroups(ctx: ExtensionCommandContext | ExtensionContext, currentModel?: Model<any>): ProviderGroup[] {
  const allModels: Model<any>[] = ctx.modelRegistry.getAll() || [];
  const availableModels: Model<any>[] = ctx.modelRegistry.getAvailable() || [];
  const availableSet = new Set(availableModels.map((m) => `${m.provider}:${m.id}`));

  const providerMap = new Map<string, ProviderGroup>();

  for (const model of allModels) {
    let group = providerMap.get(model.provider);
    if (!group) {
      const displayName = ctx.modelRegistry.getProviderDisplayName(model.provider) || model.provider;
      group = {
        id: model.provider,
        displayName,
        hasAuth: false,
        isCurrent: currentModel?.provider === model.provider,
        models: [],
      };
      providerMap.set(model.provider, group);
    }
    if (
      availableSet.has(`${model.provider}:${model.id}`) ||
      ctx.modelRegistry.hasConfiguredAuth(model)
    ) {
      group.hasAuth = true;
    }
    group.models.push(model);
  }

  // Sort models in each provider
  for (const group of providerMap.values()) {
    group.models.sort((a, b) => {
      // Current active model first
      const aCurrent = currentModel?.provider === a.provider && currentModel?.id === a.id;
      const bCurrent = currentModel?.provider === b.provider && currentModel?.id === b.id;
      if (aCurrent && !bCurrent) return -1;
      if (!aCurrent && bCurrent) return 1;
      return a.id.localeCompare(b.id);
    });
  }

  // Sort providers:
  // 1. Current active provider first
  // 2. Providers with configured authentication next (alphabetical)
  // 3. Providers without auth (alphabetical)
  return Array.from(providerMap.values()).sort((a, b) => {
    if (a.isCurrent && !b.isCurrent) return -1;
    if (!a.isCurrent && b.isCurrent) return 1;
    if (a.hasAuth && !b.hasAuth) return -1;
    if (!a.hasAuth && b.hasAuth) return 1;
    return a.displayName.localeCompare(b.displayName);
  });
}

// --- Split Model Picker Component ---

// Exported for testing; pi itself only consumes the default export below.
export class SplitModelPickerComponent {
  private tui: any;
  private theme: any;
  private done: (result: (ModelPickerResult & Model<any>) | null) => void;
  private ctx: ExtensionCommandContext | ExtensionContext;
  private pi: ExtensionAPI;
  private options: ModelPickerOptions;
  private fusionConfig: FusionConfigFile;

  private allProviders: ProviderGroup[] = [];
  private filteredProviders: ProviderGroup[] = [];
  private providerIndex: number = 0;
  private modelIndex: number = 0;

  private focusedPanel: "providers" | "models" = "models";
  private showOnlyConfigured: boolean = true;
  private searchQuery: string = "";
  private isSearchMode: boolean = false;

  private rolesState: ModelRolesState;
  private statusFlash: string = "";
  private flashTimeout?: NodeJS.Timeout;

  private providerScrollOffset: number = 0;
  private modelScrollOffset: number = 0;
  private readonly visibleRows: number = 13;

  // Reasoning Effort Picker sub-state
  private isEffortPickerOpen: boolean = false;
  private effortPickerModel?: Model<any>;
  private effortPickerLevels: ThinkingLevel[] = [];
  private effortPickerIndex: number = 0;

  constructor(
    tui: any,
    theme: any,
    done: (result: (ModelPickerResult & Model<any>) | null) => void,
    ctx: ExtensionCommandContext | ExtensionContext,
    pi: ExtensionAPI,
    options?: ModelPickerOptions
  ) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.ctx = ctx;
    this.pi = pi;
    this.options = options ?? { target: "session" };

    this.rolesState = loadRolesState();
    this.fusionConfig = loadFusionConfig();

    const currentModel = ctx.model;
    this.allProviders = buildProviderGroups(ctx, currentModel);

    const hasAnyAuth = this.allProviders.some((p) => p.hasAuth);
    this.showOnlyConfigured = hasAnyAuth;

    this.updateFilter();

    // Focus on initial target model if supplied, else active provider & active model
    const initTarget = this.options.initialModel;
    if (initTarget) {
      const pId = "provider" in initTarget ? initTarget.provider : undefined;
      const mId =
        "modelId" in initTarget
          ? (initTarget as any).modelId
          : "id" in initTarget
          ? (initTarget as any).id
          : undefined;
      if (pId) {
        if (!this.filteredProviders.some((p) => p.id === pId) && this.allProviders.some((p) => p.id === pId)) {
          this.showOnlyConfigured = false;
          this.updateFilter();
        }
        const pIdx = this.filteredProviders.findIndex((p) => p.id === pId);
        if (pIdx >= 0) {
          this.providerIndex = pIdx;
          const models = this.getCurrentModels();
          if (mId) {
            const mIdx = models.findIndex((m) => m.id === mId);
            if (mIdx >= 0) {
              this.modelIndex = mIdx;
            }
          }
        }
      }
    } else if (currentModel) {
      const pIdx = this.filteredProviders.findIndex((p) => p.id === currentModel.provider);
      if (pIdx >= 0) {
        this.providerIndex = pIdx;
        const models = this.getCurrentModels();
        const mIdx = models.findIndex((m) => m.id === currentModel.id);
        if (mIdx >= 0) {
          this.modelIndex = mIdx;
        }
      }
    }

    this.ensureScrollVisibility();
  }

  private completeSelection(selectedModel: Model<any>, effort?: ThinkingLevel): void {
    const finalEffort = effort ?? this.getModelEffort(selectedModel);
    const result = Object.assign({}, selectedModel, {
      model: selectedModel,
      effort: finalEffort,
    }) as ModelPickerResult & Model<any>;
    this.done(result);
  }

  private setFlash(msg: string): void {
    this.statusFlash = msg;
    if (this.flashTimeout) clearTimeout(this.flashTimeout);
    this.flashTimeout = setTimeout(() => {
      this.statusFlash = "";
      this.tui.requestRender();
    }, 3500);
  }

  private updateFilter(): void {
    this.isEffortPickerOpen = false;
    const q = this.searchQuery.trim().toLowerCase();

    let list = this.allProviders;
    if (this.showOnlyConfigured) {
      const configured = list.filter((p) => p.hasAuth || p.isCurrent);
      if (configured.length > 0) {
        list = configured;
      }
    }

    if (q) {
      list = list.filter((p) => {
        if (p.displayName.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)) {
          return true;
        }
        return p.models.some(
          (m) =>
            m.id.toLowerCase().includes(q) ||
            (m.name && m.name.toLowerCase().includes(q))
        );
      });
    }

    this.filteredProviders = list;

    if (this.providerIndex >= this.filteredProviders.length) {
      this.providerIndex = Math.max(0, this.filteredProviders.length - 1);
    }

    const models = this.getCurrentModels();
    if (this.modelIndex >= models.length) {
      this.modelIndex = Math.max(0, models.length - 1);
    }

    this.ensureScrollVisibility();
  }

  private getCurrentProvider(): ProviderGroup | undefined {
    return this.filteredProviders[this.providerIndex];
  }

  private getCurrentModels(): Model<any>[] {
    const provider = this.getCurrentProvider();
    if (!provider) return [];

    const q = this.searchQuery.trim().toLowerCase();
    if (!q) return provider.models;

    return provider.models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        (m.name && m.name.toLowerCase().includes(q)) ||
        provider.displayName.toLowerCase().includes(q)
    );
  }

  private ensureScrollVisibility(): void {
    const pCount = this.filteredProviders.length;
    if (pCount <= this.visibleRows) {
      this.providerScrollOffset = 0;
    } else {
      if (this.providerIndex < this.providerScrollOffset) {
        this.providerScrollOffset = this.providerIndex;
      } else if (this.providerIndex >= this.providerScrollOffset + this.visibleRows) {
        this.providerScrollOffset = this.providerIndex - this.visibleRows + 1;
      }
    }

    const mCount = this.getCurrentModels().length;
    if (mCount <= this.visibleRows) {
      this.modelScrollOffset = 0;
    } else {
      if (this.modelIndex < this.modelScrollOffset) {
        this.modelScrollOffset = this.modelIndex;
      } else if (this.modelIndex >= this.modelScrollOffset + this.visibleRows) {
        this.modelScrollOffset = this.modelIndex - this.visibleRows + 1;
      }
    }
  }

  private getRoleBadges(model: Model<any>): string[] {
    const badges: string[] = [];
    const roles = this.rolesState.roles;

    if (roles.daily?.provider === model.provider && roles.daily?.modelId === model.id) {
      badges.push(this.theme.fg("warning", "[☀️ Daily]"));
    }
    if (roles.small?.provider === model.provider && roles.small?.modelId === model.id) {
      badges.push(this.theme.fg("accent", "[⚡ Small]"));
    }
    if (roles.frontier?.provider === model.provider && roles.frontier?.modelId === model.id) {
      badges.push(`\x1b[35m[🚀 Frontier]\x1b[39m`);
    }
    if (
      this.rolesState.defaultModel?.provider === model.provider &&
      this.rolesState.defaultModel?.modelId === model.id
    ) {
      badges.push(this.theme.fg("success", "[Default]"));
    }

    const fConfig = this.fusionConfig;
    if (fConfig.main?.provider === model.provider && fConfig.main?.modelId === model.id) {
      badges.push(`\x1b[36m[🔮 Fusion Main]\x1b[39m`);
    }
    if (fConfig.sidekick?.provider === model.provider && fConfig.sidekick?.modelId === model.id) {
      badges.push(`\x1b[33m[⚡ Fusion Sidekick]\x1b[39m`);
    }

    return badges;
  }

  /**
   * Helper to retrieve effective reasoning effort for a model.
   */
  private getModelEffort(model: Model<any>): ThinkingLevel {
    if (this.options.initialModel && this.options.initialEffort) {
      const initTarget = this.options.initialModel;
      const pId = "provider" in initTarget ? initTarget.provider : undefined;
      const mId =
        "modelId" in initTarget
          ? (initTarget as any).modelId
          : "id" in initTarget
          ? (initTarget as any).id
          : undefined;
      if (model.provider === pId && model.id === mId) {
        return clampThinkingLevel(model, this.options.initialEffort as any) as ThinkingLevel;
      }
    }
    return getEffectiveModelEffort(
      model,
      this.ctx.model,
      this.pi.getThinkingLevel() as ThinkingLevel,
      this.rolesState,
      this.fusionConfig
    );
  }

  /**
   * Apply an effort level to a model: saves to settings.json,
   * sets active session if model is currently active, and updates roles and fusion.
   */
  private applyModelEffort(model: Model<any>, level: ThinkingLevel): void {
    saveModelThinkingLevel(model.provider, model.id, level);

    if (this.ctx.model && modelsAreEqual(this.ctx.model, model)) {
      this.pi.setThinkingLevel(level);
    }

    let roleUpdated = false;
    for (const rKey of ["daily", "small", "frontier"] as const) {
      const r = this.rolesState.roles[rKey];
      if (r?.provider === model.provider && r?.modelId === model.id) {
        r.effort = level;
        roleUpdated = true;
      }
    }
    if (roleUpdated) {
      saveRolesState(this.rolesState);
    }

    let fusionUpdated = false;
    if (this.fusionConfig.main?.provider === model.provider && this.fusionConfig.main?.modelId === model.id) {
      this.fusionConfig.main.effort = level;
      fusionUpdated = true;
    }
    if (this.fusionConfig.sidekick?.provider === model.provider && this.fusionConfig.sidekick?.modelId === model.id) {
      this.fusionConfig.sidekick.effort = level;
      fusionUpdated = true;
    }
    if (fusionUpdated) {
      saveFusionConfig(this.fusionConfig);
      if (this.pi.events) {
        this.pi.events.emit("fusion_config_updated", this.fusionConfig);
      }
    }
  }

  handleInput(data: string): void {
    // --- Effort Picker Mode Input Handling ---
    if (this.isEffortPickerOpen && this.effortPickerModel) {
      // 1. Esc or Left: cancel and close effort picker
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
        this.isEffortPickerOpen = false;
        this.tui.requestRender();
        return;
      }

      // 2. Up: move cursor up
      if (matchesKey(data, Key.up)) {
        if (this.effortPickerLevels.length > 0) {
          this.effortPickerIndex =
            this.effortPickerIndex > 0
              ? this.effortPickerIndex - 1
              : this.effortPickerLevels.length - 1;
          this.tui.requestRender();
        }
        return;
      }

      // 3. Down: move cursor down
      if (matchesKey(data, Key.down)) {
        if (this.effortPickerLevels.length > 0) {
          this.effortPickerIndex =
            this.effortPickerIndex < this.effortPickerLevels.length - 1
              ? this.effortPickerIndex + 1
              : 0;
          this.tui.requestRender();
        }
        return;
      }

      // 4. 'e' / 'E': cycle to next supported level
      if (data === "e" || data === "E") {
        if (this.effortPickerLevels.length > 0) {
          this.effortPickerIndex =
            (this.effortPickerIndex + 1) % this.effortPickerLevels.length;
          this.tui.requestRender();
        }
        return;
      }

      // 5. Numeric shortcuts: jump directly to index
      if (data >= "0" && data <= "9") {
        const num = parseInt(data, 10);
        if (num >= 0 && num < this.effortPickerLevels.length) {
          this.effortPickerIndex = num;
          this.tui.requestRender();
          return;
        }
      }

      // 6. Enter: confirm chosen effort level
      if (matchesKey(data, Key.enter)) {
        const chosen = this.effortPickerLevels[this.effortPickerIndex];
        if (chosen) {
          this.applyModelEffort(this.effortPickerModel, chosen);
          this.isEffortPickerOpen = false;
          this.setFlash(`✓ Set reasoning effort for ${this.effortPickerModel.id} to ${chosen.toUpperCase()}`);
          this.tui.requestRender();
        }
        return;
      }

      // 7. Space: confirm effort AND immediately select/switch to model
      if (matchesKey(data, Key.space)) {
        const chosen = this.effortPickerLevels[this.effortPickerIndex];
        if (chosen) {
          this.applyModelEffort(this.effortPickerModel, chosen);
          this.isEffortPickerOpen = false;
          this.completeSelection(this.effortPickerModel, chosen);
        }
        return;
      }

      // Ignore other keystrokes while effort picker is active
      return;
    }

    // --- Normal Two-Panel Picker Input Handling ---

    // 1. ESC: Clear search or exit
    if (matchesKey(data, Key.escape)) {
      if (this.isSearchMode || this.searchQuery.length > 0) {
        this.searchQuery = "";
        this.isSearchMode = false;
        this.updateFilter();
        this.tui.requestRender();
        return;
      }
      this.done(null);
      return;
    }

    // 2. In Search Mode: capture typing
    if (this.isSearchMode) {
      if (matchesKey(data, Key.enter)) {
        this.isSearchMode = false;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        if (this.searchQuery.length > 0) {
          this.searchQuery = this.searchQuery.slice(0, -1);
          this.updateFilter();
          this.tui.requestRender();
        } else {
          this.isSearchMode = false;
          this.tui.requestRender();
        }
        return;
      }
      if (data.length === 1 && data >= " " && data <= "~") {
        this.searchQuery += data;
        this.updateFilter();
        this.tui.requestRender();
        return;
      }
    }

    // 3. Tab: Toggle Configured / All filter
    if (matchesKey(data, Key.tab)) {
      this.showOnlyConfigured = !this.showOnlyConfigured;
      this.updateFilter();
      this.tui.requestRender();
      return;
    }

    // 4. Left Arrow: Switch focus to Provider panel
    if (matchesKey(data, Key.left)) {
      this.focusedPanel = "providers";
      this.tui.requestRender();
      return;
    }

    // 5. Right Arrow: Switch focus to Model panel
    if (matchesKey(data, Key.right)) {
      this.focusedPanel = "models";
      this.tui.requestRender();
      return;
    }

    // 6. Up Arrow: Move up in focused panel
    if (matchesKey(data, Key.up)) {
      if (this.focusedPanel === "providers") {
        if (this.filteredProviders.length > 0) {
          this.providerIndex =
            this.providerIndex > 0 ? this.providerIndex - 1 : this.filteredProviders.length - 1;
          this.modelIndex = 0;
          this.modelScrollOffset = 0;
          this.ensureScrollVisibility();
        }
      } else {
        const models = this.getCurrentModels();
        if (models.length > 0) {
          this.modelIndex =
            this.modelIndex > 0 ? this.modelIndex - 1 : models.length - 1;
          this.ensureScrollVisibility();
        }
      }
      this.tui.requestRender();
      return;
    }

    // 7. Down Arrow: Move down in focused panel
    if (matchesKey(data, Key.down)) {
      if (this.focusedPanel === "providers") {
        if (this.filteredProviders.length > 0) {
          this.providerIndex =
            this.providerIndex < this.filteredProviders.length - 1 ? this.providerIndex + 1 : 0;
          this.modelIndex = 0;
          this.modelScrollOffset = 0;
          this.ensureScrollVisibility();
        }
      } else {
        const models = this.getCurrentModels();
        if (models.length > 0) {
          this.modelIndex =
            this.modelIndex < models.length - 1 ? this.modelIndex + 1 : 0;
          this.ensureScrollVisibility();
        }
      }
      this.tui.requestRender();
      return;
    }

    // 8. Enter: If on providers, switch to models; if on models, select!
    if (matchesKey(data, Key.enter)) {
      if (this.focusedPanel === "providers") {
        this.focusedPanel = "models";
        this.tui.requestRender();
        return;
      }
      const models = this.getCurrentModels();
      const selected = models[this.modelIndex];
      if (selected) {
        this.completeSelection(selected);
      }
      return;
    }

    // 9. Search trigger '/'
    if (data === "/") {
      this.isSearchMode = true;
      this.tui.requestRender();
      return;
    }

    // 10. Role & Fusion Quick Switches: '1', '2', '3', '4', '5'
    if (data === "1") {
      void this.quickSwitchRole("daily");
      return;
    }
    if (data === "2") {
      void this.quickSwitchRole("small");
      return;
    }
    if (data === "3") {
      void this.quickSwitchRole("frontier");
      return;
    }
    if (data === "4") {
      void this.quickSwitchFusion("main");
      return;
    }
    if (data === "5") {
      void this.quickSwitchFusion("sidekick");
      return;
    }

    // 11. Model Actions on highlighted model: 'd', 's', 'f', 'm', 'k', 'e'
    const selectedModel = this.getCurrentModels()[this.modelIndex];
    if (selectedModel) {
      if (data === "d" || data === "D") {
        const effort = isReasoningModel(selectedModel)
          ? (clampThinkingLevel(selectedModel, this.getModelEffort(selectedModel) || "medium") as ThinkingLevel)
          : "off";
        this.rolesState.roles.daily = {
          provider: selectedModel.provider,
          modelId: selectedModel.id,
          effort,
        };
        saveDefaultModelToSettings(selectedModel.provider, selectedModel.id);
        this.setFlash(`✓ Assigned ${selectedModel.id} as Daily & Default Model (effort: ${effort})!`);
        this.tui.requestRender();
        return;
      }
      if (data === "s" || data === "S") {
        const effort = isReasoningModel(selectedModel)
          ? (clampThinkingLevel(selectedModel, "off") as ThinkingLevel)
          : "off";
        this.rolesState.roles.small = {
          provider: selectedModel.provider,
          modelId: selectedModel.id,
          effort,
        };
        saveRolesState(this.rolesState);
        this.setFlash(`✓ Assigned ${selectedModel.id} as Small (Tiny Tasks) Model (effort: ${effort})!`);
        this.tui.requestRender();
        return;
      }
      if (data === "f" || data === "F") {
        const effort = isReasoningModel(selectedModel)
          ? (clampThinkingLevel(selectedModel, "high") as ThinkingLevel)
          : "off";
        this.rolesState.roles.frontier = {
          provider: selectedModel.provider,
          modelId: selectedModel.id,
          effort,
        };
        saveRolesState(this.rolesState);
        this.setFlash(`✓ Assigned ${selectedModel.id} as Frontier (Advanced) Model (effort: ${effort})!`);
        this.tui.requestRender();
        return;
      }
      if (data === "m" || data === "M") {
        const effort = isReasoningModel(selectedModel)
          ? (clampThinkingLevel(selectedModel, this.getModelEffort(selectedModel) || "high") as ThinkingLevel)
          : "off";
        const fConfig = loadFusionConfig();
        fConfig.main = {
          provider: selectedModel.provider,
          modelId: selectedModel.id,
          effort,
        };
        saveFusionConfig(fConfig);
        this.fusionConfig = fConfig;
        if (this.pi.events) {
          this.pi.events.emit("fusion_config_updated", fConfig);
        }
        this.setFlash(`✓ Assigned ${selectedModel.id} as Fusion Main Model (effort: ${effort})!`);
        this.tui.requestRender();
        return;
      }
      if (data === "k" || data === "K") {
        const effort = isReasoningModel(selectedModel)
          ? (clampThinkingLevel(selectedModel, this.getModelEffort(selectedModel) || "low") as ThinkingLevel)
          : "off";
        const fConfig = loadFusionConfig();
        fConfig.sidekick = {
          provider: selectedModel.provider,
          modelId: selectedModel.id,
          effort,
        };
        saveFusionConfig(fConfig);
        this.fusionConfig = fConfig;
        if (this.pi.events) {
          this.pi.events.emit("fusion_config_updated", fConfig);
        }
        this.setFlash(`✓ Assigned ${selectedModel.id} as Fusion Sidekick Model (effort: ${effort})!`);
        this.tui.requestRender();
        return;
      }

      // 'e' / 'E': Open interactive Reasoning Effort Picker for highlighted model
      if (data === "e" || data === "E") {
        if (this.focusedPanel === "providers") {
          this.focusedPanel = "models";
        }

        if (!isReasoningModel(selectedModel)) {
          this.setFlash(`⚠ ${selectedModel.id} does not support reasoning/thinking effort.`);
          this.tui.requestRender();
          return;
        }

        const supported = getModelSupportedThinkingLevels(selectedModel);
        this.isEffortPickerOpen = true;
        this.effortPickerModel = selectedModel;
        this.effortPickerLevels = supported;

        const currentEff = this.getModelEffort(selectedModel);
        const curIdx = supported.indexOf(currentEff);
        this.effortPickerIndex = curIdx >= 0 ? curIdx : 0;

        this.tui.requestRender();
        return;
      }
    }
  }

  private async quickSwitchRole(roleKey: "daily" | "small" | "frontier"): Promise<void> {
    const role = this.rolesState.roles[roleKey];
    if (!role) {
      this.setFlash(`Role "${roleKey}" is not configured yet. Press 'd', 's', or 'f' on any model to set it.`);
      this.tui.requestRender();
      return;
    }
    const model = this.ctx.modelRegistry.find(role.provider, role.modelId);
    if (!model) {
      this.setFlash(`Model ${role.provider}/${role.modelId} not found in registry.`);
      this.tui.requestRender();
      return;
    }

    if (this.options.target === "session" || this.options.applyToSession) {
      const ok = await this.pi.setModel(model);
      if (ok) {
        if (isReasoningModel(model)) {
          const targetEffort = role.effort
            ? (clampThinkingLevel(model, role.effort as any) as ThinkingLevel)
            : this.getModelEffort(model);
          this.pi.setThinkingLevel(targetEffort);
          saveModelThinkingLevel(model.provider, model.id, targetEffort);
          this.ctx.ui.notify(
            `Switched to [${roleKey.toUpperCase()}]: ${role.provider}/${role.modelId} (effort: ${targetEffort.toUpperCase()})`,
            "info"
          );
        } else {
          this.ctx.ui.notify(
            `Switched to [${roleKey.toUpperCase()}]: ${role.provider}/${role.modelId}`,
            "info"
          );
        }
        this.completeSelection(model, role.effort);
      } else {
        this.setFlash(`Failed to switch to ${role.modelId}: No API key configured.`);
        this.tui.requestRender();
      }
    } else {
      this.completeSelection(model, role.effort);
    }
  }

  private async quickSwitchFusion(slot: "main" | "sidekick"): Promise<void> {
    const fConfig = this.fusionConfig ?? loadFusionConfig();
    const target = fConfig[slot];
    if (!target) {
      this.setFlash(`Fusion ${slot} is not configured yet. Press '${slot === "main" ? "m" : "k"}' on any model to set it.`);
      this.tui.requestRender();
      return;
    }
    const model = this.ctx.modelRegistry.find(target.provider, target.modelId);
    if (!model) {
      this.setFlash(`Model ${target.provider}/${target.modelId} not found in registry.`);
      this.tui.requestRender();
      return;
    }

    if (this.options.target === "session" || this.options.applyToSession) {
      const ok = await this.pi.setModel(model);
      if (ok) {
        if (isReasoningModel(model)) {
          const targetEffort = target.effort
            ? (clampThinkingLevel(model, target.effort as any) as ThinkingLevel)
            : this.getModelEffort(model);
          this.pi.setThinkingLevel(targetEffort);
          saveModelThinkingLevel(model.provider, model.id, targetEffort);
          this.ctx.ui.notify(
            `Switched to [FUSION ${slot.toUpperCase()}]: ${target.provider}/${target.modelId} (effort: ${targetEffort.toUpperCase()})`,
            "info"
          );
        } else {
          this.ctx.ui.notify(
            `Switched to [FUSION ${slot.toUpperCase()}]: ${target.provider}/${target.modelId}`,
            "info"
          );
        }
        this.completeSelection(model, target.effort);
      } else {
        this.setFlash(`Failed to switch to ${target.modelId}: No API key configured.`);
        this.tui.requestRender();
      }
    } else {
      this.completeSelection(model, target.effort);
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const totalWidth = width;
    const innerWidth = totalWidth - 2;

    const leftWidth = Math.max(4, Math.min(32, Math.floor(totalWidth * 0.30), totalWidth - 15));
    const rightWidth = totalWidth - leftWidth - 3;

    const currentProvider = this.getCurrentProvider();
    const currentModels = this.getCurrentModels();
    const selectedModel = currentModels[this.modelIndex];
    const activeModel = this.ctx.model;

    // Top border
    lines.push("┌" + "─".repeat(leftWidth) + "┬" + "─".repeat(rightWidth) + "┐");

    // Title headers
    const pIsFocused = this.focusedPanel === "providers" && !this.isEffortPickerOpen;
    const mIsFocused = (this.focusedPanel === "models" || this.isEffortPickerOpen);

    const pDot = pIsFocused
      ? this.theme.fg("accent", "● ")
      : this.theme.fg("dim", "○ ");
    const pTitleText = pIsFocused
      ? this.theme.fg("accent", bold("PROVIDERS"))
      : this.theme.fg("text", "PROVIDERS");
    const pCountBadge = this.theme.fg("muted", ` (${this.filteredProviders.length})`);
    const leftHeader = ` ${pDot}${pTitleText}${pCountBadge}`;

    let rightHeader = "";
    if (this.isEffortPickerOpen && this.effortPickerModel) {
      const eDot = this.theme.fg("warning", "● ");
      const eTitleText = this.theme.fg("warning", bold("REASONING EFFORT"));
      const eModelTag = ` : ${this.theme.fg("accent", this.effortPickerModel.id)}`;
      const eCountBadge = this.theme.fg("muted", ` (${this.effortPickerLevels.length} levels)`);
      rightHeader = ` ${eDot}${eTitleText}${eModelTag}${eCountBadge}`;
    } else {
      const mDot = mIsFocused
        ? this.theme.fg("accent", "● ")
        : this.theme.fg("dim", "○ ");
      let titleLabel = "MODELS";
      if (this.options.title) {
        titleLabel = this.options.title.toUpperCase();
      } else if (this.options.target === "fusion-main") {
        titleLabel = "FUSION MAIN AGENT";
      } else if (this.options.target === "fusion-sidekick") {
        titleLabel = "FUSION SIDEKICK AGENT";
      } else if (this.options.target === "select") {
        titleLabel = "SELECT MODEL";
      }

      const mTitleText = mIsFocused
        ? this.theme.fg("accent", bold(titleLabel))
        : this.theme.fg("text", titleLabel);
      const pNameTag = currentProvider
        ? ` : ${this.theme.fg("accent", currentProvider.displayName)}`
        : "";
      const mCountBadge = this.theme.fg("muted", ` (${currentModels.length})`);
      rightHeader = ` ${mDot}${mTitleText}${pNameTag}${mCountBadge}`;
    }

    lines.push(
      "│" + pad(leftHeader, leftWidth) + "│" + pad(rightHeader, rightWidth) + "│"
    );

    // Quick Roles Ribbon row
    lines.push("├" + "─".repeat(leftWidth) + "┼" + "─".repeat(rightWidth) + "┤");
    const dRole = this.rolesState.roles.daily;
    const sRole = this.rolesState.roles.small;
    const fRole = this.rolesState.roles.frontier;

    const dStr = dRole ? `${dRole.modelId} (${dRole.effort || "med"})` : "not set";
    const sStr = sRole ? `${sRole.modelId} (${sRole.effort || "off"})` : "not set";
    const fStr = fRole ? `${fRole.modelId} (${fRole.effort || "high"})` : "not set";

    const rolesRibbon = ` ${this.theme.fg("warning", "[1: ☀️ Daily]")} ${dStr}  ${this.theme.fg("accent", "[2: ⚡ Small]")} ${sStr}  ${this.theme.fg("muted", "[3: 🚀 Frontier]")} ${fStr}`;
    lines.push("│" + pad(rolesRibbon, innerWidth) + "│");

    // Quick Fusion Ribbon row
    const fConfig = this.fusionConfig;
    const fMainStr = fConfig.main ? `${fConfig.main.modelId} (${fConfig.main.effort || "high"})` : "not set";
    const fSideStr = fConfig.sidekick ? `${fConfig.sidekick.modelId} (${fConfig.sidekick.effort || "low"})` : "not set";
    const fusionStateStr = fConfig.enabled !== false ? this.theme.fg("success", "● ON") : this.theme.fg("dim", "○ OFF");

    const fusionRibbon = ` ${this.theme.fg("muted", "Fusion:")} ${fusionStateStr}  ${this.theme.fg("warning", "[m/4: 🔮 Main]")} ${fMainStr}  ${this.theme.fg("accent", "[k/5: ⚡ Sidekick]")} ${fSideStr}`;
    lines.push("│" + pad(fusionRibbon, innerWidth) + "│");

    // Search bar if search mode or active query
    if (this.isSearchMode || this.searchQuery.length > 0) {
      lines.push("├" + "─".repeat(leftWidth) + "┼" + "─".repeat(rightWidth) + "┤");
      const cursorMarker = this.isSearchMode ? "█" : "";
      const searchLine = ` 🔍 Search: ${this.theme.fg("accent", bold(this.searchQuery))}${this.theme.fg("dim", cursorMarker)}  ${this.theme.fg("dim", "[Enter/Esc: finish search]")}`;
      lines.push("│" + pad(searchLine, innerWidth) + "│");
    }

    lines.push("├" + "─".repeat(leftWidth) + "┼" + "─".repeat(rightWidth) + "┤");

    // Split body rows
    for (let i = 0; i < this.visibleRows; i++) {
      // --- Left Column: Provider row ---
      let leftCell = "";
      const pIdx = this.providerScrollOffset + i;
      if (pIdx < this.filteredProviders.length) {
        const prov = this.filteredProviders[pIdx];
        const isSelected = pIdx === this.providerIndex;

        let pointer = "  ";
        if (isSelected && pIsFocused) {
          pointer = this.theme.fg("accent", "› ");
        } else if (isSelected) {
          pointer = this.theme.fg("muted", "▸ ");
        }

        const auth = prov.hasAuth
          ? this.theme.fg("success", "[✓]")
          : this.theme.fg("dim", "[ ]");

        const star = prov.isCurrent
          ? this.theme.fg("warning", "★ ")
          : "  ";

        let name = prov.displayName;
        if (isSelected && pIsFocused) {
          name = this.theme.fg("accent", bold(name));
        } else if (!prov.hasAuth) {
          name = this.theme.fg("dim", name);
        }

        const count = this.theme.fg("muted", `(${prov.models.length})`);

        leftCell = ` ${pointer}${auth} ${star}${name}`;
        const avail = leftWidth - visibleWidth(leftCell) - visibleWidth(count) - 1;
        if (avail > 0) {
          leftCell += " ".repeat(avail) + count;
        }

        if (i === 0 && this.providerScrollOffset > 0) {
          leftCell = ` ${this.theme.fg("muted", `▲ (${this.providerScrollOffset} above)`)}`;
        } else if (
          i === this.visibleRows - 1 &&
          this.providerScrollOffset + this.visibleRows < this.filteredProviders.length
        ) {
          const remaining =
            this.filteredProviders.length - (this.providerScrollOffset + this.visibleRows);
          leftCell = ` ${this.theme.fg("muted", `▼ (${remaining} below)`)}`;
        }
      }

      // --- Right Column: Model row OR Effort Picker rows ---
      let rightCell = "";

      if (this.isEffortPickerOpen && this.effortPickerModel) {
        // Effort Picker View
        const currentEff = this.getModelEffort(this.effortPickerModel);

        if (i === 0) {
          rightCell = ` ${this.theme.fg("dim", "Choose reasoning effort for ")}${this.theme.fg("accent", bold(this.effortPickerModel.id))}:`;
        } else if (i === 1) {
          rightCell = "";
        } else {
          const lvlIdx = i - 2;
          if (lvlIdx < this.effortPickerLevels.length) {
            const lvl = this.effortPickerLevels[lvlIdx];
            const isCursor = lvlIdx === this.effortPickerIndex;
            const isCurrent = lvl === currentEff;
            const isSessionActive =
              activeModel &&
              modelsAreEqual(activeModel, this.effortPickerModel) &&
              lvl === (this.pi.getThinkingLevel() as ThinkingLevel);

            const pointer = isCursor ? this.theme.fg("warning", "› ") : "  ";
            const radio = isCurrent
              ? this.theme.fg("success", "[●] ")
              : this.theme.fg("dim", "[○] ");

            let lvlText = lvl.padEnd(8);
            if (isCursor) {
              lvlText = this.theme.fg("warning", bold(lvlText));
            } else if (isCurrent) {
              lvlText = this.theme.fg("success", lvlText);
            } else {
              lvlText = this.theme.fg("text", lvlText);
            }

            const desc = this.theme.fg("dim", `- ${EFFORT_DESCRIPTIONS[lvl] || ""}`);
            const badge = isSessionActive
              ? this.theme.fg("success", " [ACTIVE]")
              : isCurrent
              ? this.theme.fg("muted", " [CONFIGURED]")
              : "";

            rightCell = ` ${pointer}${radio}${lvlText} ${desc}${badge}`;
          }
        }
      } else {
        // Normal Model View
        const mIdx = this.modelScrollOffset + i;
        if (mIdx < currentModels.length) {
          const mdl = currentModels[mIdx];
          const isSelected = mIdx === this.modelIndex;
          const isCurrentActive =
            activeModel?.provider === mdl.provider && activeModel?.id === mdl.id;

          let pointer = "  ";
          if (isSelected && mIsFocused) {
            pointer = this.theme.fg("accent", "› ");
          } else if (isSelected) {
            pointer = this.theme.fg("muted", "▸ ");
          }

          const check = isCurrentActive
            ? this.theme.fg("success", "✓ ")
            : "  ";

          let idText = mdl.id;
          if (isSelected && mIsFocused) {
            idText = this.theme.fg("accent", bold(idText));
          } else if (isCurrentActive) {
            idText = this.theme.fg("success", idText);
          }

          const roleBadges = this.getRoleBadges(mdl).join(" ");
          const isReasoning = isReasoningModel(mdl);
          let rBadge = "";
          if (isReasoning) {
            const eff = this.getModelEffort(mdl);
            rBadge = this.theme.fg("accent", `🧠 ${eff}`);
          }
          const vBadge = mdl.input?.includes("image") ? "📷" : "";
          const ctxBadge = this.theme.fg("warning", formatTokens(mdl.contextWindow));

          const infoBadges = [rBadge, vBadge, ctxBadge].filter(Boolean).join(" ");

          rightCell = ` ${pointer}${check}${idText} ${roleBadges}`.trimEnd();
          const avail = rightWidth - visibleWidth(rightCell) - visibleWidth(infoBadges) - 1;
          if (avail > 0) {
            rightCell += " ".repeat(avail) + infoBadges;
          }

          if (i === 0 && this.modelScrollOffset > 0) {
            rightCell = ` ${this.theme.fg("muted", `▲ (${this.modelScrollOffset} more above)`)}`;
          } else if (
            i === this.visibleRows - 1 &&
            this.modelScrollOffset + this.visibleRows < currentModels.length
          ) {
            const remaining =
              currentModels.length - (this.modelScrollOffset + this.visibleRows);
            rightCell = ` ${this.theme.fg("muted", `▼ (${remaining} more below)`)}`;
          }
        } else if (currentModels.length === 0 && i === 0) {
          rightCell = `  ${this.theme.fg("dim", "No models available for this provider")}`;
        }
      }

      lines.push(
        "│" + pad(leftCell, leftWidth) + "│" + pad(rightCell, rightWidth) + "│"
      );
    }

    // Mid separator above details
    lines.push("├" + "─".repeat(leftWidth) + "┴" + "─".repeat(rightWidth) + "┤");

    // Flash notification message if present
    if (this.statusFlash) {
      lines.push("│" + pad(` ${this.theme.fg("success", bold(this.statusFlash))}`, innerWidth) + "│");
    }

    // Detail spec card
    if (this.isEffortPickerOpen && this.effortPickerModel) {
      // Effort picker detail card
      const hoveredLevel = this.effortPickerLevels[this.effortPickerIndex] || "off";
      const desc = EFFORT_DESCRIPTIONS[hoveredLevel] || "";
      const curEff = this.getModelEffort(this.effortPickerModel);

      const detail1 = ` Selected Tier: ${this.theme.fg("warning", bold(hoveredLevel.toUpperCase()))} · ${desc}`;
      lines.push("│" + pad(detail1, innerWidth) + "│");

      const detail2 = ` Target Model: ${this.theme.fg("accent", bold(this.effortPickerModel.id))} · Configured: ${this.theme.fg("success", curEff.toUpperCase())} · Supported: [${this.effortPickerLevels.join(", ")}]`;
      lines.push("│" + pad(detail2, innerWidth) + "│");
    } else if (selectedModel) {
      // Normal model detail card
      const isCurrentActive =
        activeModel?.provider === selectedModel.provider &&
        activeModel?.id === selectedModel.id;

      const activeBadge = isCurrentActive
        ? ` ${this.theme.fg("success", "[ACTIVE]")}`
        : "";

      const authStatus = currentProvider?.hasAuth
        ? this.theme.fg("success", "API Key Configured ✓")
        : this.theme.fg("error", "No API Key Configured ✗");

      const isFMain =
        this.fusionConfig.main?.provider === selectedModel.provider &&
        this.fusionConfig.main?.modelId === selectedModel.id;
      const isFSide =
        this.fusionConfig.sidekick?.provider === selectedModel.provider &&
        this.fusionConfig.sidekick?.modelId === selectedModel.id;
      const fusionTag = isFMain
        ? ` ${this.theme.fg("accent", "[🔮 Fusion Main]")}`
        : isFSide
        ? ` ${this.theme.fg("warning", "[⚡ Fusion Sidekick]")}`
        : "";

      const detail1 = ` ${bold(selectedModel.name || selectedModel.id)}${activeBadge}${fusionTag} · Provider: ${this.theme.fg("accent", selectedModel.provider)} · Auth: ${authStatus}`;
      lines.push("│" + pad(detail1, innerWidth) + "│");

      const costText = formatCost(selectedModel.cost);
      const costBadge = costText ? ` · ${this.theme.fg("muted", costText)}` : "";

      const isReasoning = isReasoningModel(selectedModel);
      let thinkText = this.theme.fg("dim", "None");
      if (isReasoning) {
        const eff = this.getModelEffort(selectedModel);
        const supported = getModelSupportedThinkingLevels(selectedModel);
        thinkText = `${this.theme.fg("accent", "Yes 🧠")} (Effort: ${this.theme.fg("warning", eff.toUpperCase())} · Supported: ${supported.join(", ")})`;
      }

      const detail2 = ` Context: ${this.theme.fg("warning", formatTokens(selectedModel.contextWindow))} · Max Output: ${this.theme.fg("warning", formatTokens(selectedModel.maxTokens))} · Thinking: ${thinkText}${costBadge}`;
      lines.push("│" + pad(detail2, innerWidth) + "│");
    } else {
      lines.push("│" + pad("  No model selected", innerWidth) + "│");
      lines.push("│" + pad("", innerWidth) + "│");
    }

    // Bottom help bar
    lines.push("├" + "─".repeat(innerWidth) + "┤");
    if (this.isEffortPickerOpen) {
      const helpBar = " [↑/↓] Navigate  [Enter] Apply Effort  [Space] Apply & Select  [e] Next Level  [Esc/←] Back";
      lines.push("│" + pad(this.theme.fg("warning", helpBar), innerWidth) + "│");
    } else {
      const filterState = this.showOnlyConfigured
        ? this.theme.fg("success", "Configured Only")
        : this.theme.fg("dim", "All Providers");

      let helpBar = "";
      if (this.options.target === "fusion-main") {
        helpBar = ` [←/→] Panel  [↑/↓] Move  [Enter] Select Main  [e] Effort  [Space] Select with Effort  [/] Search  [Tab] ${filterState}  [Esc] Cancel`;
      } else if (this.options.target === "fusion-sidekick") {
        helpBar = ` [←/→] Panel  [↑/↓] Move  [Enter] Select Sidekick  [e] Effort  [Space] Select with Effort  [/] Search  [Tab] ${filterState}  [Esc] Cancel`;
      } else {
        helpBar = ` [←/→] Panel  [↑/↓] Move  [Enter] Select  [e] Effort  [d/s/f] Role  [m/k] Fusion  [1-5] Switch  [/] Search  [Tab] ${filterState}  [Esc] Close`;
      }
      lines.push("│" + pad(this.theme.fg("dim", helpBar), innerWidth) + "│");
    }
    lines.push("└" + "─".repeat(innerWidth) + "┘");

    return lines;
  }
}

// --- Handler Functions ---

export async function showModelPicker(
  ctx: ExtensionContext | ExtensionCommandContext,
  pi: ExtensionAPI,
  options?: ModelPickerOptions
): Promise<ModelPickerResult | null> {
  if (ctx.mode !== "tui") {
    return fallbackModelPicker(ctx, options);
  }

  const result = await ctx.ui.custom<(ModelPickerResult & Model<any>) | null>(
    (tui, theme, _keybindings, done) => {
      return new SplitModelPickerComponent(tui, theme, done, ctx, pi, options);
    }
  );

  return result ? { model: result.model ?? result, effort: result.effort ?? "off" } : null;
}

async function fallbackModelPicker(
  ctx: ExtensionContext | ExtensionCommandContext,
  options?: ModelPickerOptions
): Promise<ModelPickerResult | null> {
  const available = [...(ctx.modelRegistry.getAvailable() || [])].sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.id.localeCompare(b.id);
  });
  if (available.length === 0) {
    ctx.ui.notify("No models with configured auth are available.", "error");
    return null;
  }
  const title =
    options?.title ||
    (options?.target === "fusion-main"
      ? "Pick Fusion Main Model"
      : options?.target === "fusion-sidekick"
      ? "Pick Fusion Sidekick Model"
      : "Select Model");
  const choices = available.map((m) => `${m.provider}/${m.id}`);
  const picked = await ctx.ui.select(title, choices);
  if (!picked) return null;
  const model = available[choices.indexOf(picked)];
  if (!model) return null;
  const effort = getEffectiveModelEffort(model);
  return { model, effort };
}

async function openModelPicker(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Model picker requires TUI mode", "error");
    return;
  }

  const result = await showModelPicker(ctx, pi, { target: "session" });

  if (result) {
    const selectedModel = result.model;
    const currentActive = ctx.model;
    if (!currentActive || !modelsAreEqual(currentActive, selectedModel)) {
      const ok = await pi.setModel(selectedModel);
      if (ok) {
        if (isReasoningModel(selectedModel)) {
          const configuredEffort = result.effort || getEffectiveModelEffort(selectedModel);
          pi.setThinkingLevel(configuredEffort);
          ctx.ui.notify(
            `Switched model to ${selectedModel.provider}/${selectedModel.id} (effort: ${configuredEffort.toUpperCase()})`,
            "info"
          );
        } else {
          ctx.ui.notify(
            `Switched model to ${selectedModel.provider}/${selectedModel.id}`,
            "info"
          );
        }
      } else {
        ctx.ui.notify(
          `Failed to switch to ${selectedModel.provider}/${selectedModel.id}: No valid authentication found.`,
          "error"
        );
      }
    } else {
      if (isReasoningModel(selectedModel) && result.effort) {
        pi.setThinkingLevel(result.effort);
      }
    }
  }
}

async function handleEffortCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const trimmed = args.trim();

  // Case 1: Arguments provided
  if (trimmed) {
    const parts = trimmed.split(/\s+/);

    // Subcase 1A: Two arguments - e.g. /effort <model> <level>
    if (parts.length >= 2) {
      const modelQuery = parts[0];
      const levelQuery = parts.slice(1).join(" ").toLowerCase();
      const allModels = ctx.modelRegistry.getAll() || [];
      const targetModel = allModels.find(
        (m) =>
          m.id === modelQuery ||
          `${m.provider}/${m.id}` === modelQuery ||
          m.id.toLowerCase() === modelQuery.toLowerCase() ||
          `${m.provider}/${m.id}`.toLowerCase() === modelQuery.toLowerCase()
      );

      if (targetModel) {
        const targetLevel = EFFORT_ALIASES[levelQuery];
        if (!targetLevel) {
          ctx.ui.notify(
            `Unknown effort level "${levelQuery}". Valid levels: ${THINKING_LEVELS.join(", ")}`,
            "error"
          );
          return;
        }

        if (!isReasoningModel(targetModel)) {
          ctx.ui.notify(
            `Model "${targetModel.provider}/${targetModel.id}" does not support reasoning/thinking effort.`,
            "warning"
          );
          return;
        }

        const supported = getModelSupportedThinkingLevels(targetModel);
        const effective = clampThinkingLevel(targetModel, targetLevel as any) as ThinkingLevel;
        saveModelThinkingLevel(targetModel.provider, targetModel.id, effective);

        // Update role if model is assigned to one
        const rolesState = loadRolesState();
        let roleUpdated = false;
        for (const rKey of ["daily", "small", "frontier"] as const) {
          const r = rolesState.roles[rKey];
          if (r?.provider === targetModel.provider && r?.modelId === targetModel.id) {
            r.effort = effective;
            roleUpdated = true;
          }
        }
        if (roleUpdated) saveRolesState(rolesState);

        const clampedMsg =
          effective !== targetLevel
            ? ` (clamped from ${targetLevel}; supported: ${supported.join(", ")})`
            : "";

        if (ctx.model && modelsAreEqual(ctx.model, targetModel)) {
          const previous = pi.getThinkingLevel();
          pi.setThinkingLevel(effective);
          ctx.ui.notify(
            `Reasoning effort for ${targetModel.id}: ${previous} → ${effective}${clampedMsg}`,
            "info"
          );
        } else {
          ctx.ui.notify(
            `Saved default reasoning effort for ${targetModel.provider}/${targetModel.id}: ${effective}${clampedMsg}`,
            "info"
          );
        }
        return;
      }
    }

    // Subcase 1B: Single argument
    // First, check if it is a recognized effort alias (sets effort on active model)
    const targetLevel = EFFORT_ALIASES[trimmed.toLowerCase()];
    if (targetLevel) {
      if (!ctx.model) {
        ctx.ui.notify("No active model in session.", "error");
        return;
      }

      if (!isReasoningModel(ctx.model)) {
        if (targetLevel === "off") {
          pi.setThinkingLevel("off");
          ctx.ui.notify("Reasoning effort: off", "info");
          return;
        }
        ctx.ui.notify(
          `Current model "${ctx.model.id}" does not support reasoning/thinking effort.`,
          "warning"
        );
        return;
      }

      const supported = getModelSupportedThinkingLevels(ctx.model);
      const effective = clampThinkingLevel(ctx.model, targetLevel as any) as ThinkingLevel;
      const previous = pi.getThinkingLevel();
      pi.setThinkingLevel(effective);
      saveModelThinkingLevel(ctx.model.provider, ctx.model.id, effective);

      // Update role if active model is assigned to one
      const rolesState = loadRolesState();
      let roleUpdated = false;
      for (const rKey of ["daily", "small", "frontier"] as const) {
        const r = rolesState.roles[rKey];
        if (r?.provider === ctx.model.provider && r?.modelId === ctx.model.id) {
          r.effort = effective;
          roleUpdated = true;
        }
      }
      if (roleUpdated) saveRolesState(rolesState);

      const clampedMsg =
        effective !== targetLevel
          ? ` (clamped from ${targetLevel}; supported: ${supported.join(", ")})`
          : "";
      ctx.ui.notify(`Reasoning effort: ${previous} → ${effective}${clampedMsg}`, "info");
      return;
    }

    // Next, check if it matches a model in the registry (opens interactive picker for that model)
    const allModels = ctx.modelRegistry.getAll() || [];
    const targetModel = allModels.find(
      (m) =>
        m.id === trimmed ||
        `${m.provider}/${m.id}` === trimmed ||
        m.id.toLowerCase() === trimmed.toLowerCase() ||
        `${m.provider}/${m.id}`.toLowerCase() === trimmed.toLowerCase()
    );

    if (targetModel) {
      if (!isReasoningModel(targetModel)) {
        ctx.ui.notify(
          `Model "${targetModel.provider}/${targetModel.id}" does not support reasoning/thinking effort.`,
          "warning"
        );
        return;
      }

      if (ctx.hasUI) {
        const supported = getModelSupportedThinkingLevels(targetModel);
        const currentEff = getEffectiveModelEffort(targetModel);
        const choices = supported.map((level) => {
          const isCur = level === currentEff;
          const marker = isCur ? "● " : "  ";
          const desc = EFFORT_DESCRIPTIONS[level] || "";
          return `${marker}${level.padEnd(8)} - ${desc}${isCur ? " (current)" : ""}`;
        });

        const choice = await ctx.ui.select(
          `Select reasoning effort for ${targetModel.id} (${supported.join(", ")}):`,
          choices
        );

        if (!choice) return;

        const chosenLevel = choice.trim().split(/\s+/)[0].replace("●", "").trim() as ThinkingLevel;
        if (chosenLevel && supported.includes(chosenLevel)) {
          saveModelThinkingLevel(targetModel.provider, targetModel.id, chosenLevel);

          // Update role if target model is assigned to one
          const rolesState = loadRolesState();
          let roleUpdated = false;
          for (const rKey of ["daily", "small", "frontier"] as const) {
            const r = rolesState.roles[rKey];
            if (r?.provider === targetModel.provider && r?.modelId === targetModel.id) {
              r.effort = chosenLevel;
              roleUpdated = true;
            }
          }
          if (roleUpdated) saveRolesState(rolesState);

          if (ctx.model && modelsAreEqual(ctx.model, targetModel)) {
            const previous = pi.getThinkingLevel();
            pi.setThinkingLevel(chosenLevel);
            ctx.ui.notify(
              `Reasoning effort for ${targetModel.id}: ${previous} → ${chosenLevel}`,
              "info"
            );
          } else {
            ctx.ui.notify(
              `Saved reasoning effort for ${targetModel.provider}/${targetModel.id}: ${chosenLevel}`,
              "info"
            );
          }
        }
        return;
      } else {
        const supported = getModelSupportedThinkingLevels(targetModel);
        ctx.ui.notify(
          `Supported effort levels for ${targetModel.id}: ${supported.join(", ")}`,
          "info"
        );
        return;
      }
    }

    // Argument didn't match an effort level or model
    const valid =
      ctx.model && isReasoningModel(ctx.model)
        ? getModelSupportedThinkingLevels(ctx.model).join(", ")
        : THINKING_LEVELS.join(", ");
    ctx.ui.notify(
      `Unknown effort level or model "${trimmed}". Valid levels for current model: ${valid}`,
      "error"
    );
    return;
  }

  // Case 2: No arguments - interactive selection for current model
  if (!ctx.model) {
    ctx.ui.notify("No active model in session.", "error");
    return;
  }

  if (!isReasoningModel(ctx.model)) {
    ctx.ui.notify(
      `Current model "${ctx.model.id}" does not support reasoning/thinking effort.`,
      "warning"
    );
    return;
  }

  if (ctx.hasUI) {
    const supported = getModelSupportedThinkingLevels(ctx.model);
    const current = (pi.getThinkingLevel() as ThinkingLevel) || "off";
    const choices = supported.map((level) => {
      const isCur = level === current;
      const marker = isCur ? "● " : "  ";
      const desc = EFFORT_DESCRIPTIONS[level] || "";
      return `${marker}${level.padEnd(8)} - ${desc}${isCur ? " (current)" : ""}`;
    });

    const choice = await ctx.ui.select(
      `Select reasoning effort for ${ctx.model.id} (${supported.join(", ")}):`,
      choices
    );

    if (!choice) return;

    const chosenLevel = choice.trim().split(/\s+/)[0].replace("●", "").trim() as ThinkingLevel;
    if (chosenLevel && supported.includes(chosenLevel)) {
      const previous = pi.getThinkingLevel();
      pi.setThinkingLevel(chosenLevel);
      saveModelThinkingLevel(ctx.model.provider, ctx.model.id, chosenLevel);

      // Update role if current model is assigned to one
      const rolesState = loadRolesState();
      let roleUpdated = false;
      for (const rKey of ["daily", "small", "frontier"] as const) {
        const r = rolesState.roles[rKey];
        if (r?.provider === ctx.model.provider && r?.modelId === ctx.model.id) {
          r.effort = chosenLevel;
          roleUpdated = true;
        }
      }
      if (roleUpdated) saveRolesState(rolesState);

      ctx.ui.notify(`Reasoning effort: ${previous} → ${chosenLevel}`, "info");
    }
  } else {
    const supported = getModelSupportedThinkingLevels(ctx.model);
    ctx.ui.notify(
      `Current effort: ${pi.getThinkingLevel()}. Usage: /effort <${supported.join("|")}>`,
      "info"
    );
  }
}

async function handleRoleCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const rolesState = loadRolesState();
  const trimmed = args.trim().toLowerCase();

  const roleMap: Record<string, "daily" | "small" | "frontier"> = {
    daily: "daily",
    default: "daily",
    workhorse: "daily",
    small: "small",
    tiny: "small",
    fast: "small",
    frontier: "frontier",
    advanced: "frontier",
    complex: "frontier",
    deep: "frontier",
  };

  if (trimmed && roleMap[trimmed]) {
    const roleKey = roleMap[trimmed];
    const role = rolesState.roles[roleKey];
    if (!role) {
      ctx.ui.notify(`Role "${roleKey}" is not configured. Run /role or /models to set it.`, "error");
      return;
    }

    const model = ctx.modelRegistry.find(role.provider, role.modelId);
    if (!model) {
      ctx.ui.notify(`Model "${role.provider}/${role.modelId}" for role ${roleKey} not found in registry.`, "error");
      return;
    }

    const ok = await pi.setModel(model);
    if (ok) {
      if (isReasoningModel(model)) {
        const targetEffort = role.effort
          ? (clampThinkingLevel(model, role.effort as any) as ThinkingLevel)
          : getEffectiveModelEffort(model, undefined, undefined, rolesState);
        pi.setThinkingLevel(targetEffort);
        saveModelThinkingLevel(model.provider, model.id, targetEffort);
        ctx.ui.notify(
          `Switched to [${roleKey.toUpperCase()}]: ${role.provider}/${role.modelId} (effort: ${targetEffort.toUpperCase()})`,
          "info"
        );
      } else {
        ctx.ui.notify(
          `Switched to [${roleKey.toUpperCase()}]: ${role.provider}/${role.modelId}`,
          "info"
        );
      }
    } else {
      ctx.ui.notify(`Failed to switch to ${role.modelId}: No valid API key configured.`, "error");
    }
    return;
  }

  // Interactive role selector
  if (ctx.hasUI) {
    const d = rolesState.roles.daily;
    const s = rolesState.roles.small;
    const f = rolesState.roles.frontier;

    const cur = ctx.model;
    const isDailyCur = cur?.provider === d?.provider && cur?.id === d?.modelId;
    const isSmallCur = cur?.provider === s?.provider && cur?.id === s?.modelId;
    const isFrontierCur = cur?.provider === f?.provider && cur?.id === f?.modelId;

    const options = [
      `☀️ Daily (Default Tasks)   : ${d ? `${d.provider}/${d.modelId} (effort: ${d.effort || "med"})` : "not set"}${isDailyCur ? " (active)" : ""}`,
      `⚡ Small (Tiny Tasks)       : ${s ? `${s.provider}/${s.modelId} (effort: ${s.effort || "off"})` : "not set"}${isSmallCur ? " (active)" : ""}`,
      `🚀 Frontier (Complex Tasks) : ${f ? `${f.provider}/${f.modelId} (effort: ${f.effort || "high"})` : "not set"}${isFrontierCur ? " (active)" : ""}`,
      `⚙️ Open Model Picker to configure roles...`,
    ];

    const choice = await ctx.ui.select("Select model role to activate:", options);
    if (!choice) return;

    if (choice.startsWith("☀️ Daily")) {
      await handleRoleCommand("daily", ctx, pi);
    } else if (choice.startsWith("⚡ Small")) {
      await handleRoleCommand("small", ctx, pi);
    } else if (choice.startsWith("🚀 Frontier")) {
      await handleRoleCommand("frontier", ctx, pi);
    } else {
      await openModelPicker(ctx, pi);
    }
  } else {
    ctx.ui.notify("Usage: /role <daily | small | frontier>", "info");
  }
}

// --- Main Extension Registration ---

export default function (pi: ExtensionAPI) {
  let activeModelTracked: Model<any> | undefined;

  // Track model switches to provide accurate argument completions
  pi.on("model_select", (event) => {
    activeModelTracked = event.model;
  });

  // 1. /exit and /quit commands to exit Pi cleanly
  pi.registerCommand("exit", {
    description: "Exit pi cleanly",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });

  pi.registerCommand("quit", {
    description: "Exit pi cleanly",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });

  // 2. /effort and /thinking reasoning effort commands
  pi.registerCommand("effort", {
    description: "Set or pick reasoning effort level for active model or specific model",
    getArgumentCompletions: (prefix: string) => {
      const p = prefix.trim().toLowerCase();
      const validLevels =
        activeModelTracked && isReasoningModel(activeModelTracked)
          ? getModelSupportedThinkingLevels(activeModelTracked)
          : THINKING_LEVELS;

      const list = validLevels
        .filter((l) => l.startsWith(p))
        .map((l) => ({
          value: l,
          label: `${l} - ${EFFORT_DESCRIPTIONS[l] || ""}`,
        }));
      return list.length > 0 ? list : null;
    },
    handler: async (args, ctx) => {
      activeModelTracked = ctx.model;
      await handleEffortCommand(args, ctx, pi);
    },
  });

  pi.registerCommand("thinking", {
    description: "Set reasoning thinking level (alias for /effort)",
    getArgumentCompletions: (prefix: string) => {
      const p = prefix.trim().toLowerCase();
      const validLevels =
        activeModelTracked && isReasoningModel(activeModelTracked)
          ? getModelSupportedThinkingLevels(activeModelTracked)
          : THINKING_LEVELS;

      const list = validLevels
        .filter((l) => l.startsWith(p))
        .map((l) => ({
          value: l,
          label: `${l} - ${EFFORT_DESCRIPTIONS[l] || ""}`,
        }));
      return list.length > 0 ? list : null;
    },
    handler: async (args, ctx) => {
      activeModelTracked = ctx.model;
      await handleEffortCommand(args, ctx, pi);
    },
  });

  // 3. /role and /roles preconfigured role manager
  pi.registerCommand("role", {
    description: "Switch preconfigured model roles: daily, small, frontier",
    getArgumentCompletions: (prefix: string) => {
      const p = prefix.trim().toLowerCase();
      const list = [
        { value: "daily", label: "daily - Default model to run daily tasks" },
        { value: "small", label: "small - Small model to run tiny daily tasks" },
        { value: "frontier", label: "frontier - Frontier model for complex tasks & settings" },
      ].filter((item) => item.value.startsWith(p));
      return list.length > 0 ? list : null;
    },
    handler: async (args, ctx) => {
      activeModelTracked = ctx.model;
      await handleRoleCommand(args, ctx, pi);
    },
  });

  pi.registerCommand("roles", {
    description: "Switch or view preconfigured model roles (alias for /role)",
    handler: async (args, ctx) => {
      activeModelTracked = ctx.model;
      await handleRoleCommand(args, ctx, pi);
    },
  });

  // 4. Direct role switch shortcuts
  pi.registerCommand("daily", {
    description: "Switch to daily default model",
    handler: async (_args, ctx) => {
      activeModelTracked = ctx.model;
      await handleRoleCommand("daily", ctx, pi);
    },
  });

  pi.registerCommand("small", {
    description: "Switch to small model for tiny daily tasks",
    handler: async (_args, ctx) => {
      activeModelTracked = ctx.model;
      await handleRoleCommand("small", ctx, pi);
    },
  });

  pi.registerCommand("tiny", {
    description: "Switch to small model for tiny daily tasks (alias for /small)",
    handler: async (_args, ctx) => {
      activeModelTracked = ctx.model;
      await handleRoleCommand("small", ctx, pi);
    },
  });

  pi.registerCommand("frontier", {
    description: "Switch to frontier model for complex tasks with high reasoning",
    handler: async (_args, ctx) => {
      activeModelTracked = ctx.model;
      await handleRoleCommand("frontier", ctx, pi);
    },
  });

  pi.registerCommand("default", {
    description: "Set current model (or argument) as startup default model in settings.json",
    handler: async (args, ctx) => {
      activeModelTracked = ctx.model;
      const trimmed = args.trim();
      if (trimmed) {
        const all = ctx.modelRegistry.getAll();
        const found = all.find((m) => m.id === trimmed || `${m.provider}/${m.id}` === trimmed);
        if (found) {
          saveDefaultModelToSettings(found.provider, found.id);
          ctx.ui.notify(`Saved default startup model: ${found.provider}/${found.id}`, "info");
          return;
        }
      }
      if (ctx.model) {
        saveDefaultModelToSettings(ctx.model.provider, ctx.model.id);
        ctx.ui.notify(
          `Saved current model as default startup model: ${ctx.model.provider}/${ctx.model.id}`,
          "info"
        );
      } else {
        await openModelPicker(ctx, pi);
      }
    },
  });

  // 5. Two-panel split model picker commands
  pi.registerCommand("models", {
    description: "Open two-panel split model picker (Provider | Model)",
    handler: async (_args, ctx) => {
      activeModelTracked = ctx.model;
      await openModelPicker(ctx, pi);
    },
  });

  pi.registerCommand("mp", {
    description: "Open two-panel split model picker (quick shortcut)",
    handler: async (_args, ctx) => {
      activeModelTracked = ctx.model;
      await openModelPicker(ctx, pi);
    },
  });

  pi.registerCommand("picker", {
    description: "Open two-panel split model picker",
    handler: async (_args, ctx) => {
      activeModelTracked = ctx.model;
      await openModelPicker(ctx, pi);
    },
  });

  pi.registerCommand("model-picker", {
    description: "Open two-panel split model picker",
    handler: async (_args, ctx) => {
      activeModelTracked = ctx.model;
      await openModelPicker(ctx, pi);
    },
  });

  // 6. Keyboard shortcut Ctrl+Shift+M
  pi.registerShortcut(Key.ctrlShift("m"), {
    description: "Open split model picker",
    handler: async (ctx) => {
      await openModelPicker(ctx, pi);
    },
  });
}
