/**
 * Model usage history for the quick-switch slots (Alt+1 … Alt+8).
 *
 *   <agentDir>/model-usage.json — per model: last effort, use count, frecency score
 *
 * Every switch adds 1 to a model's score after decaying the old score with a
 * one-week half-life, so the ranking blends "popular" and "recently used": a
 * model used daily stays on top, and one used once a month ago fades out.
 */

import * as path from "node:path";
import { agentDir, loadFusionConfig, loadRolesState } from "./config.js";
import { readJsonFile, writeJsonFile } from "./json-store.js";
import type { EffortLevel, ModelRef } from "./models.js";
import { refKey } from "./models.js";

export const QUICK_SLOT_COUNT = 8;
export const USAGE_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TRACKED_MODELS = 50;

export interface ModelUsageEntry extends ModelRef {
  count: number;
  /** Frecency score as of `lastUsed`; use `decayedScore` to compare entries. */
  score: number;
  lastUsed: number;
}

export interface ModelUsageState {
  models: Record<string, ModelUsageEntry>;
}

export const modelUsagePath = (): string => path.join(agentDir(), "model-usage.json");

export function loadModelUsage(): ModelUsageState {
  const data = readJsonFile<ModelUsageState>(modelUsagePath());
  return data && data.models && typeof data.models === "object" ? { models: { ...data.models } } : { models: {} };
}

export function decayedScore(entry: ModelUsageEntry, now: number = Date.now()): number {
  const age = Math.max(0, now - entry.lastUsed);
  return entry.score * Math.pow(0.5, age / USAGE_HALF_LIFE_MS);
}

/** Record a switch to a model (one use). Keeps the stored effort unless a new one is given. */
export function recordModelUse(provider: string, modelId: string, effort?: EffortLevel, now: number = Date.now()): void {
  const state = loadModelUsage();
  const key = refKey({ provider, modelId });
  const prev = state.models[key];
  state.models[key] = {
    provider,
    modelId,
    effort: effort ?? prev?.effort,
    count: (prev?.count ?? 0) + 1,
    score: (prev ? decayedScore(prev, now) : 0) + 1,
    lastUsed: now,
  };
  const keep = Object.entries(state.models)
    .sort(([, a], [, b]) => decayedScore(b, now) - decayedScore(a, now))
    .slice(0, MAX_TRACKED_MODELS);
  writeJsonFile(modelUsagePath(), { models: Object.fromEntries(keep) });
}

/** Remember the effort last used with a model, without counting it as a use. */
export function recordModelEffort(provider: string, modelId: string, effort: EffortLevel): void {
  const state = loadModelUsage();
  const entry = state.models[refKey({ provider, modelId })];
  if (!entry || entry.effort === effort) return;
  entry.effort = effort;
  writeJsonFile(modelUsagePath(), state);
}

/**
 * The quick-switch slots: the highest-scoring used models first, then (until
 * there are `limit`) the configured roles, Fusion slots and default model.
 * `exists` filters out models that are no longer in the registry.
 */
export function rankQuickModels(
  exists: (ref: ModelRef) => boolean,
  options: { limit?: number; now?: number } = {}
): ModelRef[] {
  const limit = options.limit ?? QUICK_SLOT_COUNT;
  const now = options.now ?? Date.now();
  const seen = new Set<string>();
  const slots: ModelRef[] = [];
  const add = (ref: ModelRef | undefined) => {
    if (!ref || slots.length >= limit) return;
    const key = refKey(ref);
    if (seen.has(key) || !exists(ref)) return;
    seen.add(key);
    slots.push({ provider: ref.provider, modelId: ref.modelId, effort: ref.effort });
  };

  const used = Object.values(loadModelUsage().models).sort(
    (a, b) => decayedScore(b, now) - decayedScore(a, now) || b.lastUsed - a.lastUsed
  );
  for (const entry of used) add(entry);

  const roles = loadRolesState();
  add(roles.roles.daily);
  add(roles.roles.frontier);
  add(roles.roles.small);
  const fusion = loadFusionConfig();
  add(fusion.main);
  add(fusion.sidekick);
  add(roles.defaultModel);
  return slots;
}
