/**
 * The team: every role resolved to a concrete model from whatever the user has
 * logged in to. Pins (from the setup card or a role file) win; otherwise the
 * role's tier maps through the capability tiers. Presets shift tiers; the
 * reviewer prefers a different model family from the builders.
 */

import type { Model } from "@earendil-works/pi-ai";
import { loadRolesState } from "../shared/config.js";
import { clampEffort, findModelByRef, modelFamily, modelKey } from "../shared/models.js";
import { assignTiers, capabilityScore, shiftTier } from "../shared/tiers.js";
import type { ModelSource, Tier, TierAssignment } from "../shared/tiers.js";
import type { RoleDef, SetupAnswers, TeamMember, TeamPreset } from "./types.js";

export interface Team {
  members: Record<string, TeamMember>;
  tiers: TierAssignment;
  notes: string[];
}

export interface TeamSource extends ModelSource {
  getAll(): Model<any>[];
}

export function presetTier(role: RoleDef, preset: TeamPreset): Tier {
  if (preset === "best") return "frontier";
  if (preset === "cheap") {
    const shifted = shiftTier(role.tier, -1);
    // Judgement roles never go below daily.
    return role.judgement && shifted === "small" ? "daily" : shifted;
  }
  return role.tier;
}

function member(role: RoleDef, model: Model<any>, tier: Tier, effort = role.effort): TeamMember {
  return {
    role: role.name,
    provider: model.provider,
    modelId: model.id,
    effort: clampEffort(model, effort),
    tier,
    family: modelFamily(model),
  };
}

export function buildTeam(
  source: TeamSource,
  roles: Map<string, RoleDef>,
  answers: Pick<SetupAnswers, "teamPreset" | "pins">,
): Team {
  const tiers = assignTiers(source, loadRolesState().roles);
  const notes = [...tiers.notes];
  const members: Record<string, TeamMember> = {};
  const available = source.getAvailable();

  for (const role of roles.values()) {
    const pin = answers.pins[role.name];
    if (pin) {
      const model = source.find(pin.provider, pin.modelId);
      if (model) {
        members[role.name] = member(role, model, role.tier, pin.effort ?? role.effort);
        continue;
      }
      notes.push(`${role.name}: pinned model ${pin.provider}/${pin.modelId} is not available; using its tier.`);
    }
    if (role.model) {
      const model = findModelByRef(available, role.model);
      if (model) {
        members[role.name] = member(role, model, role.tier);
        continue;
      }
      notes.push(`${role.name}: role file pins ${role.model}, which is not logged in; using its tier.`);
    }
    const tier = presetTier(role, answers.teamPreset);
    const model = tiers[tier] ?? tiers.daily ?? tiers.frontier ?? tiers.small;
    if (model) members[role.name] = member(role, model, tier);
  }

  // Reviewer diversity: prefer a strong model from a different family than the builders.
  for (const role of roles.values()) {
    if (!role.reviewDiversity || answers.pins[role.name] || role.model) continue;
    const current = members[role.name];
    if (!current) continue;
    const builderFamilies = new Set(
      ["backend", "frontend"].map((name) => members[name]?.family).filter((f): f is string => Boolean(f)),
    );
    if (!builderFamilies.has(current.family)) continue;
    // Within 85% of the daily tier's capability: strong enough to judge the builders' work.
    const floor = tiers.daily ? capabilityScore(tiers.daily) * 0.85 : 0;
    const alternative = available
      .filter((m) => !builderFamilies.has(modelFamily(m)) && capabilityScore(m) >= floor && (m.contextWindow || 0) >= 64_000)
      .sort((a, b) => capabilityScore(b) - capabilityScore(a))[0];
    if (alternative) members[role.name] = member(role, alternative, current.tier);
    else notes.push("Reviewer shares a model family with the builders (only one strong family is logged in).");
  }

  return { members, tiers, notes: [...new Set(notes)] };
}

/** Next model up a role's escalation ladder from the current one, if any. */
export function escalate(team: Team, role: RoleDef, current: TeamMember): TeamMember | undefined {
  const ladder = role.escalation;
  const index = ladder.indexOf(current.tier);
  for (let i = Math.max(0, index + 1); i < ladder.length; i++) {
    const tier = ladder[i];
    const model = team.tiers[tier];
    if (model && modelKey(model) !== `${current.provider}/${current.modelId}`) {
      return member(role, model, tier, role.effort ?? current.effort);
    }
  }
  return undefined;
}

/** One line per distinct model: "roles → provider/model". */
export function describeTeam(team: Team): string[] {
  const byModel = new Map<string, string[]>();
  for (const m of Object.values(team.members)) {
    const key = `${m.provider}/${m.modelId}`;
    byModel.set(key, [...(byModel.get(key) ?? []), m.role]);
  }
  return [...byModel.entries()].map(([model, roles]) => `${roles.join(", ")} → ${model}`);
}
