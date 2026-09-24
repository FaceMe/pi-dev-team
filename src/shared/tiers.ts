/**
 * Capability tiers (small / daily / frontier) derived from whatever models the
 * user has logged in to — any provider pi supports, including custom and local
 * ones. Explicit role assignments from the model picker always win; missing
 * tiers are filled from model metadata only (never provider names or IDs).
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ModelRolesState, RoleName } from "./config.js";
import { blendedCost, isFreeModel, maxEffortIndex, modelKey } from "./models.js";

export type Tier = RoleName;
export const TIERS: readonly Tier[] = ["small", "daily", "frontier"];

export interface TierAssignment {
  small?: Model<any>;
  daily?: Model<any>;
  frontier?: Model<any>;
  /** Where each tier came from, for the setup card. */
  source: Record<Tier, "roles" | "auto" | "none">;
  /** Human-readable notes (single model, local models, …). */
  notes: string[];
}

/** Minimal registry surface, so tests can pass a fake. */
export interface ModelSource {
  getAvailable(): Model<any>[];
  find(provider: string, modelId: string): Model<any> | undefined;
}

/**
 * Capability score from metadata. Price is a meaningful signal between paid
 * models (stronger models cost more); free/local models are ranked on the rest.
 */
export function capabilityScore(model: Model<any>): number {
  let score = 0;
  if (model.reasoning) score += 3 + maxEffortIndex(model) * 0.5;
  const ctx = Math.max(1, model.contextWindow || 8_000);
  score += Math.max(0, Math.min(5, Math.log2(ctx / 8_000)));
  score += Math.max(0, Math.min(3, Math.log2(Math.max(1, model.maxTokens || 4_096) / 4_096)));
  if (Array.isArray(model.input) && model.input.includes("image")) score += 0.5;
  // Price separates tiers but is capped, so an older, pricier model does not
  // outrank a newer one with more reasoning headroom and context.
  const price = blendedCost(model);
  if (price > 0) score += Math.min(3, Math.log10(1 + price) * 2);
  return score;
}

/** Usable for agent work: enough context for a system prompt, tools and a repo slice. */
export function isAgentCapable(model: Model<any>): boolean {
  return (model.contextWindow || 0) >= 16_000;
}

function uniqueByKey(models: Model<any>[]): Model<any>[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = modelKey(model);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Assign small / daily / frontier.
 *
 * 1. Roles set in model-roles.json (resolvable and logged in) are kept.
 * 2. Otherwise: frontier = highest capability score; small = cheapest model
 *    with at least 64k context (or the lowest score when all are free);
 *    daily = the best-scoring model priced at or below frontier, excluding
 *    frontier itself when another option exists.
 */
export function assignTiers(source: ModelSource, roles?: ModelRolesState["roles"]): TierAssignment {
  const available = uniqueByKey(source.getAvailable().filter(isAgentCapable));
  const availableKeys = new Set(available.map(modelKey));
  const result: TierAssignment = { source: { small: "none", daily: "none", frontier: "none" }, notes: [] };

  for (const tier of TIERS) {
    const role = roles?.[tier];
    if (!role) continue;
    const model = source.find(role.provider, role.modelId);
    if (model && availableKeys.has(modelKey(model))) {
      result[tier] = model;
      result.source[tier] = "roles";
    }
  }

  if (available.length === 0) {
    result.notes.push("No logged-in models found. Run /login to add a provider.");
    return result;
  }

  const byScore = [...available].sort((a, b) => capabilityScore(b) - capabilityScore(a));
  const allFree = available.every(isFreeModel);

  if (!result.frontier) {
    result.frontier = byScore[0];
    result.source.frontier = "auto";
  }

  const frontier = result.frontier!;
  const frontierPrice = blendedCost(frontier);
  const best = (pool: Model<any>[]) => [...pool].sort((a, b) => capabilityScore(b) - capabilityScore(a))[0];
  const inBand = (lo: number, hi: number) =>
    available.filter((m) => {
      const ratio = blendedCost(m) / frontierPrice;
      return ratio >= lo && ratio < hi && modelKey(m) !== modelKey(frontier);
    });

  if (!result.small) {
    const roomy = available.filter((m) => (m.contextWindow || 0) >= 64_000);
    const pool = roomy.length > 0 ? roomy : available;
    let pick: Model<any> | undefined;
    if (!allFree && frontierPrice > 0) {
      // Strongest model priced at 1.5–10% of frontier: cheap, but not a toy.
      pick = best(inBand(0.015, 0.1).filter((m) => pool.includes(m)));
    }
    if (!pick) {
      pick = allFree
        ? [...pool].sort((a, b) => capabilityScore(a) - capabilityScore(b))[0]
        : [...pool].sort((a, b) => blendedCost(a) - blendedCost(b) || capabilityScore(b) - capabilityScore(a))[0];
    }
    result.small = pick;
    result.source.small = "auto";
  }

  if (!result.daily) {
    let pick: Model<any> | undefined;
    if (!allFree && frontierPrice > 0) {
      // Strongest model priced at 10–75% of frontier.
      pick = best(inBand(0.1, 0.75));
    }
    if (!pick) {
      const others = byScore.filter((m) => modelKey(m) !== modelKey(frontier));
      pick = others.find((m) => modelKey(m) !== modelKey(result.small!)) ?? others[0] ?? frontier;
    }
    result.daily = pick;
    result.source.daily = "auto";
  }

  const distinct = new Set([result.small, result.daily, result.frontier].filter(Boolean).map((m) => modelKey(m)));
  if (available.length === 1) result.notes.push("Only one model is logged in, so every role uses it.");
  else if (distinct.size < 3) result.notes.push("Fewer than three distinct models: some tiers share a model.");
  if (available.some(isFreeModel) && !allFree) result.notes.push("Free or local models are ranked by capability, not price.");
  if (allFree) result.notes.push("All models report zero cost (local or free); budgets apply to tokens.");
  return result;
}

/** Tier one step up/down, clamped. */
export function shiftTier(tier: Tier, delta: number): Tier {
  const index = Math.max(0, Math.min(TIERS.length - 1, TIERS.indexOf(tier) + delta));
  return TIERS[index];
}
