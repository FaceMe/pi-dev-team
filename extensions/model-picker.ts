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
 * 2. Preconfigured Roles & Default Models:
 *    - Daily / Default  : Workhorse model for daily tasks & startup default (e.g., Claude 3.7 Sonnet / GPT-4o).
 *    - Small / Tiny     : Fast, lightweight model for tiny tasks (e.g., Claude 3.5 Haiku / GPT-4o-mini).
 *    - Frontier / Deep  : Advanced reasoning model for complex tasks (e.g., Claude 3.7 Sonnet / o3-mini with high effort).
 *    - In Picker:
 *        Press 'd' : Assign highlighted model as Daily / Default (updates settings.json defaultModel!).
 *        Press 's' : Assign highlighted model as Small.
 *        Press 'f' : Assign highlighted model as Frontier.
 *        Press 'e' : Cycle reasoning effort for the highlighted model.
 *        Press '1' : Quick-switch to Daily model.
 *        Press '2' : Quick-switch to Small model.
 *        Press '3' : Quick-switch to Frontier model.
 *    - Slash commands:
 *        /role [daily|small|frontier] : Switch role or open interactive role menu.
 *        /daily, /small, /frontier    : Direct role activation shortcuts.
 *        /default [model]             : Set startup default model.
 *
 * 3. Reasoning Effort Controller (/effort, /thinking):
 *    - /effort <off|minimal|low|medium|high|xhigh|max> : Set reasoning effort directly.
 *    - /effort (no args) : Interactive prompt with full descriptions of all 7 effort tiers.
 *    - Argument completions for quick tab completion.
 *
 * 4. Clean Shutdown (/exit, /quit):
 *    - /exit : Gracefully shuts down Pi via ctx.shutdown().
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Model } from "@earendil-works/pi-ai";
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
  minimal: "Minimal thinking tokens (light reasoning)",
  low: "Low thinking effort (quick analysis)",
  medium: "Medium thinking effort (balanced reasoning)",
  high: "High thinking effort (deep reasoning & architecture)",
  xhigh: "Extra high thinking effort (complex proofs & debugging)",
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

// --- Persistence Helpers ---

const ROLES_FILE_PATH = path.join(os.homedir(), ".pi", "agent", "model-roles.json");
const SETTINGS_FILE_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");

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

function buildProviderGroups(ctx: ExtensionCommandContext, currentModel?: Model<any>): ProviderGroup[] {
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
  private done: (model: Model<any> | null) => void;
  private ctx: ExtensionCommandContext;
  private pi: ExtensionAPI;

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
  private readonly visibleRows: number = 14;

  constructor(
    tui: any,
    theme: any,
    done: (model: Model<any> | null) => void,
    ctx: ExtensionCommandContext,
    pi: ExtensionAPI
  ) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.ctx = ctx;
    this.pi = pi;

    this.rolesState = loadRolesState();

    const currentModel = ctx.model;
    this.allProviders = buildProviderGroups(ctx, currentModel);

    const hasAnyAuth = this.allProviders.some((p) => p.hasAuth);
    this.showOnlyConfigured = hasAnyAuth;

    this.updateFilter();

    // Focus on active provider & active model initially
    if (currentModel) {
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

  private setFlash(msg: string): void {
    this.statusFlash = msg;
    if (this.flashTimeout) clearTimeout(this.flashTimeout);
    this.flashTimeout = setTimeout(() => {
      this.statusFlash = "";
      this.tui.requestRender();
    }, 3500);
  }

  private updateFilter(): void {
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

    return badges;
  }

  handleInput(data: string): void {
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
        this.done(selected);
      }
      return;
    }

    // 9. Search trigger '/'
    if (data === "/") {
      this.isSearchMode = true;
      this.tui.requestRender();
      return;
    }

    // 10. Role Quick Switches: '1', '2', '3'
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

    // 11. Role Assignments on highlighted model: 'd' (Daily/Default), 's' (Small), 'f' (Frontier)
    const selectedModel = this.getCurrentModels()[this.modelIndex];
    if (selectedModel) {
      if (data === "d" || data === "D") {
        this.rolesState.roles.daily = {
          provider: selectedModel.provider,
          modelId: selectedModel.id,
          effort: "medium",
        };
        saveDefaultModelToSettings(selectedModel.provider, selectedModel.id);
        this.setFlash(`✓ Assigned ${selectedModel.id} as Daily & Default Model!`);
        this.tui.requestRender();
        return;
      }
      if (data === "s" || data === "S") {
        this.rolesState.roles.small = {
          provider: selectedModel.provider,
          modelId: selectedModel.id,
          effort: "off",
        };
        saveRolesState(this.rolesState);
        this.setFlash(`✓ Assigned ${selectedModel.id} as Small (Tiny Tasks) Model!`);
        this.tui.requestRender();
        return;
      }
      if (data === "f" || data === "F") {
        this.rolesState.roles.frontier = {
          provider: selectedModel.provider,
          modelId: selectedModel.id,
          effort: "high",
        };
        saveRolesState(this.rolesState);
        this.setFlash(`✓ Assigned ${selectedModel.id} as Frontier (Advanced) Model!`);
        this.tui.requestRender();
        return;
      }
      if (data === "e" || data === "E") {
        // Cycle reasoning effort
        const currentEffort = (this.pi.getThinkingLevel() as ThinkingLevel) || "off";
        const idx = THINKING_LEVELS.indexOf(currentEffort);
        const nextEffort = THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length];
        this.pi.setThinkingLevel(nextEffort);
        // If assigned to a role, update role effort too
        for (const rKey of ["daily", "small", "frontier"] as const) {
          const r = this.rolesState.roles[rKey];
          if (r?.provider === selectedModel.provider && r?.modelId === selectedModel.id) {
            r.effort = nextEffort;
            saveRolesState(this.rolesState);
          }
        }
        this.setFlash(`✓ Reasoning effort set to: ${nextEffort.toUpperCase()}`);
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
    const ok = await this.pi.setModel(model);
    if (ok) {
      if (role.effort) {
        this.pi.setThinkingLevel(role.effort);
      }
      this.ctx.ui.notify(
        `Switched to [${roleKey.toUpperCase()}]: ${role.provider}/${role.modelId} (effort: ${role.effort || "default"})`,
        "info"
      );
      this.done(model);
    } else {
      this.setFlash(`Failed to switch to ${role.modelId}: No API key configured.`);
      this.tui.requestRender();
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    // TUI contract: no returned line may exceed `width`. Every row below is
    // exactly totalWidth wide INCLUDING its border characters.
    const totalWidth = width;
    const innerWidth = totalWidth - 2; // content rows sit between the outer │ borders

    const leftWidth = Math.max(4, Math.min(32, Math.floor(totalWidth * 0.30), totalWidth - 15));
    // Row = │ + leftWidth + │ (divider) + rightWidth + │ → 3 border chars total.
    const rightWidth = totalWidth - leftWidth - 3;

    const currentProvider = this.getCurrentProvider();
    const currentModels = this.getCurrentModels();
    const selectedModel = currentModels[this.modelIndex];
    const activeModel = this.ctx.model;

    // Top border
    lines.push("┌" + "─".repeat(leftWidth) + "┬" + "─".repeat(rightWidth) + "┐");

    // Title headers
    const pIsFocused = this.focusedPanel === "providers";
    const mIsFocused = this.focusedPanel === "models";

    const pDot = pIsFocused
      ? this.theme.fg("accent", "● ")
      : this.theme.fg("dim", "○ ");
    const pTitleText = pIsFocused
      ? this.theme.fg("accent", bold("PROVIDERS"))
      : this.theme.fg("text", "PROVIDERS");
    const pCountBadge = this.theme.fg("muted", ` (${this.filteredProviders.length})`);
    const leftHeader = ` ${pDot}${pTitleText}${pCountBadge}`;

    const mDot = mIsFocused
      ? this.theme.fg("accent", "● ")
      : this.theme.fg("dim", "○ ");
    const mTitleText = mIsFocused
      ? this.theme.fg("accent", bold("MODELS"))
      : this.theme.fg("text", "MODELS");
    const pNameTag = currentProvider
      ? ` : ${this.theme.fg("accent", currentProvider.displayName)}`
      : "";
    const mCountBadge = this.theme.fg("muted", ` (${currentModels.length})`);
    const rightHeader = ` ${mDot}${mTitleText}${pNameTag}${mCountBadge}`;

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

      // --- Right Column: Model row ---
      let rightCell = "";
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
        const rBadge = mdl.reasoning ? this.theme.fg("accent", "🧠 Think") : "";
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
    if (selectedModel) {
      const isCurrentActive =
        activeModel?.provider === selectedModel.provider &&
        activeModel?.id === selectedModel.id;

      const activeBadge = isCurrentActive
        ? ` ${this.theme.fg("success", "[ACTIVE]")}`
        : "";

      const authStatus = currentProvider?.hasAuth
        ? this.theme.fg("success", "API Key Configured ✓")
        : this.theme.fg("error", "No API Key Configured ✗");

      const detail1 = ` ${bold(selectedModel.name || selectedModel.id)}${activeBadge} · Provider: ${this.theme.fg("accent", selectedModel.provider)} · Auth: ${authStatus}`;
      lines.push("│" + pad(detail1, innerWidth) + "│");

      const costText = formatCost(selectedModel.cost);
      const costBadge = costText ? ` · ${this.theme.fg("muted", costText)}` : "";
      const curEffort = (this.pi.getThinkingLevel() as ThinkingLevel) || "off";
      const thinkText = selectedModel.reasoning
        ? `${this.theme.fg("accent", "Yes 🧠")} (Effort: ${this.theme.fg("warning", curEffort.toUpperCase())})`
        : this.theme.fg("dim", "None");

      const detail2 = ` Context: ${this.theme.fg("warning", formatTokens(selectedModel.contextWindow))} · Max Output: ${this.theme.fg("warning", formatTokens(selectedModel.maxTokens))} · Thinking: ${thinkText}${costBadge}`;
      lines.push("│" + pad(detail2, innerWidth) + "│");
    } else {
      lines.push("│" + pad("  No model selected", innerWidth) + "│");
      lines.push("│" + pad("", innerWidth) + "│");
    }

    // Bottom help bar
    lines.push("├" + "─".repeat(innerWidth) + "┤");
    const filterState = this.showOnlyConfigured
      ? this.theme.fg("success", "Configured Only")
      : this.theme.fg("dim", "All Providers");

    const helpBar = ` [←/→] Panel  [↑/↓] Move  [Enter] Select  [d/s/f] Set Role  [1-3] Switch Role  [e] Effort  [/] Search  [Tab] ${filterState}  [Esc] Close`;
    lines.push("│" + pad(this.theme.fg("dim", helpBar), innerWidth) + "│");
    lines.push("└" + "─".repeat(innerWidth) + "┘");

    return lines;
  }
}

// --- Handler Functions ---

async function openModelPicker(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Model picker requires TUI mode", "error");
    return;
  }

  const selectedModel = await ctx.ui.custom<Model<any> | null>(
    (tui, theme, _keybindings, done) => {
      return new SplitModelPickerComponent(tui, theme, done, ctx, pi);
    }
  );

  if (selectedModel) {
    const ok = await pi.setModel(selectedModel);
    if (ok) {
      ctx.ui.notify(
        `Switched model to ${selectedModel.provider}/${selectedModel.id}`,
        "info"
      );
    } else {
      ctx.ui.notify(
        `Failed to switch to ${selectedModel.provider}/${selectedModel.id}: No valid authentication found.`,
        "error"
      );
    }
  }
}

async function handleEffortCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const trimmed = args.trim().toLowerCase();

  if (trimmed) {
    const target = EFFORT_ALIASES[trimmed];
    if (!target) {
      const valid = THINKING_LEVELS.join(", ");
      ctx.ui.notify(
        `Unknown effort level "${args.trim()}". Valid levels: ${valid} (or min, med, max, 0-6)`,
        "error"
      );
      return;
    }

    const previous = pi.getThinkingLevel();
    pi.setThinkingLevel(target);
    const effective = pi.getThinkingLevel();
    const clamped =
      effective !== target ? ` (clamped to ${effective} for model ${ctx.model?.id || "unknown"})` : "";

    ctx.ui.notify(`Reasoning effort: ${previous} → ${effective}${clamped}`, "info");
    return;
  }

  // Interactive selection prompt
  if (ctx.hasUI) {
    const current = (pi.getThinkingLevel() as ThinkingLevel) || "off";
    const choices = THINKING_LEVELS.map((level) => {
      const isCur = level === current;
      const marker = isCur ? "● " : "  ";
      const desc = EFFORT_DESCRIPTIONS[level];
      return `${marker}${level.padEnd(8)} - ${desc}${isCur ? " (current)" : ""}`;
    });

    const choice = await ctx.ui.select(
      `Select reasoning effort for ${ctx.model?.id || "current model"} (current: ${current}):`,
      choices
    );

    if (!choice) return;

    const chosenLevel = choice.trim().split(/\s+/)[0].replace("●", "").trim() as ThinkingLevel;
    if (chosenLevel) {
      const previous = pi.getThinkingLevel();
      pi.setThinkingLevel(chosenLevel);
      const effective = pi.getThinkingLevel();
      const clamped =
        effective !== chosenLevel ? ` (clamped to ${effective} for ${ctx.model?.id})` : "";
      ctx.ui.notify(`Reasoning effort: ${previous} → ${effective}${clamped}`, "info");
    }
  } else {
    ctx.ui.notify(
      `Current effort: ${pi.getThinkingLevel()}. Usage: /effort <${THINKING_LEVELS.join("|")}>`,
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
      if (role.effort) {
        pi.setThinkingLevel(role.effort);
      }
      ctx.ui.notify(
        `Switched to [${roleKey.toUpperCase()}]: ${role.provider}/${role.modelId} (effort: ${role.effort || "default"})`,
        "info"
      );
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
    description: "Set or pick reasoning effort level: off, minimal, low, medium, high, xhigh, max",
    getArgumentCompletions: (prefix: string) => {
      const p = prefix.trim().toLowerCase();
      const list = THINKING_LEVELS.filter((l) => l.startsWith(p)).map((l) => ({
        value: l,
        label: `${l} - ${EFFORT_DESCRIPTIONS[l]}`,
      }));
      return list.length > 0 ? list : null;
    },
    handler: async (args, ctx) => {
      await handleEffortCommand(args, ctx, pi);
    },
  });

  pi.registerCommand("thinking", {
    description: "Set reasoning thinking level (alias for /effort)",
    getArgumentCompletions: (prefix: string) => {
      const p = prefix.trim().toLowerCase();
      const list = THINKING_LEVELS.filter((l) => l.startsWith(p)).map((l) => ({
        value: l,
        label: `${l} - ${EFFORT_DESCRIPTIONS[l]}`,
      }));
      return list.length > 0 ? list : null;
    },
    handler: async (args, ctx) => {
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
      await handleRoleCommand(args, ctx, pi);
    },
  });

  pi.registerCommand("roles", {
    description: "Switch or view preconfigured model roles (alias for /role)",
    handler: async (args, ctx) => {
      await handleRoleCommand(args, ctx, pi);
    },
  });

  // 4. Direct role switch shortcuts
  pi.registerCommand("daily", {
    description: "Switch to daily default model",
    handler: async (_args, ctx) => {
      await handleRoleCommand("daily", ctx, pi);
    },
  });

  pi.registerCommand("small", {
    description: "Switch to small model for tiny daily tasks",
    handler: async (_args, ctx) => {
      await handleRoleCommand("small", ctx, pi);
    },
  });

  pi.registerCommand("tiny", {
    description: "Switch to small model for tiny daily tasks (alias for /small)",
    handler: async (_args, ctx) => {
      await handleRoleCommand("small", ctx, pi);
    },
  });

  pi.registerCommand("frontier", {
    description: "Switch to frontier model for complex tasks with high reasoning",
    handler: async (_args, ctx) => {
      await handleRoleCommand("frontier", ctx, pi);
    },
  });

  pi.registerCommand("default", {
    description: "Set current model (or argument) as startup default model in settings.json",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed) {
        // Try finding model
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
      await openModelPicker(ctx, pi);
    },
  });

  pi.registerCommand("mp", {
    description: "Open two-panel split model picker (quick shortcut)",
    handler: async (_args, ctx) => {
      await openModelPicker(ctx, pi);
    },
  });

  pi.registerCommand("picker", {
    description: "Open two-panel split model picker",
    handler: async (_args, ctx) => {
      await openModelPicker(ctx, pi);
    },
  });

  pi.registerCommand("model-picker", {
    description: "Open two-panel split model picker",
    handler: async (_args, ctx) => {
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
