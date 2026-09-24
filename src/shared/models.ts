/**
 * Provider-agnostic model helpers.
 *
 * Nothing here matches provider names or model IDs to decide behaviour: model
 * ordering and capability come from pi's model metadata (reasoning support,
 * thinking levels, context window, input types, price). The only name-based
 * helper is `modelFamily`, used as a soft preference for cross-family review.
 */

import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

export type EffortLevel = ModelThinkingLevel;

export const EFFORT_ORDER: readonly EffortLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ModelRef {
  provider: string;
  modelId: string;
  effort?: EffortLevel;
}

export function modelKey(model?: Pick<Model<any>, "provider" | "id"> | null): string {
  return model ? `${model.provider}/${model.id}` : "(none)";
}

export function refKey(ref?: ModelRef | null): string {
  return ref ? `${ref.provider}/${ref.modelId}` : "(none)";
}

export function shortModelKey(model?: Pick<Model<any>, "provider" | "id"> | null): string {
  if (!model) return "none";
  const id = model.id.length > 22 ? `${model.id.slice(0, 21)}…` : model.id;
  return `${model.provider}/${id}`;
}

export function clampEffort(model: Model<any> | undefined, level: EffortLevel | undefined): EffortLevel | undefined {
  if (!model || !level) return level;
  try {
    return clampThinkingLevel(model, level) as EffortLevel;
  } catch {
    return level;
  }
}

export function supportedEfforts(model: Model<any> | undefined): EffortLevel[] {
  if (!model) return ["off"];
  try {
    return getSupportedThinkingLevels(model) as EffortLevel[];
  } catch {
    return [...EFFORT_ORDER];
  }
}

/** Highest supported thinking level as an index into EFFORT_ORDER (0 = off only). */
export function maxEffortIndex(model: Model<any>): number {
  if (!model.reasoning) return 0;
  const levels = supportedEfforts(model);
  return levels.reduce((best, level) => Math.max(best, EFFORT_ORDER.indexOf(level)), 0);
}

/** Rough blended price per million tokens (input-heavy agent workloads). */
export function blendedCost(model: Pick<Model<any>, "cost">): number {
  const cost = model.cost ?? { input: 0, output: 0 };
  return (cost.input ?? 0) * 3 + (cost.output ?? 0);
}

/** Dollars per token for a typical agent turn mix (80% input, 20% output). */
export function pricePerToken(model: Pick<Model<any>, "cost">): number {
  const cost = model.cost ?? { input: 0, output: 0 };
  return ((cost.input ?? 0) * 0.8 + (cost.output ?? 0) * 0.2) / 1_000_000;
}

export function isFreeModel(model: Pick<Model<any>, "cost">): boolean {
  return blendedCost(model) <= 0;
}

const FAMILY_PATTERNS: Array<[RegExp, string]> = [
  [/claude|opus|sonnet|haiku|fable/i, "claude"],
  [/\bgpt|^o\d|codex|chatgpt/i, "gpt"],
  [/gemini|gemma/i, "gemini"],
  [/qwen|qwq/i, "qwen"],
  [/llama/i, "llama"],
  [/deepseek/i, "deepseek"],
  [/mistral|codestral|devstral|magistral|ministral/i, "mistral"],
  [/grok/i, "grok"],
  [/kimi|moonshot/i, "kimi"],
  [/glm|zhipu/i, "glm"],
  [/minimax/i, "minimax"],
  [/nova/i, "nova"],
  [/command|cohere/i, "cohere"],
  [/phi-?\d/i, "phi"],
];

/**
 * Best-effort model family, used only as a soft preference (a reviewer from a
 * different family than the author). Falls back to the provider name.
 */
export function modelFamily(model: Pick<Model<any>, "provider" | "id"> & { name?: string }): string {
  const hay = `${model.id} ${model.name ?? ""}`;
  for (const [pattern, family] of FAMILY_PATTERNS) {
    if (pattern.test(hay)) return family;
  }
  return model.provider;
}

/** Resolve "provider/id", "id", or a case-insensitive variant against a model list. */
export function findModelByRef(models: Model<any>[], ref: string): Model<any> | undefined {
  const wanted = ref.trim();
  if (!wanted) return undefined;
  const lower = wanted.toLowerCase();
  return (
    models.find((m) => `${m.provider}/${m.id}` === wanted) ??
    models.find((m) => m.id === wanted) ??
    models.find((m) => `${m.provider}/${m.id}`.toLowerCase() === lower) ??
    models.find((m) => m.id.toLowerCase() === lower)
  );
}

export function sameModel(a?: ModelRef | null, b?: Pick<Model<any>, "provider" | "id"> | null): boolean {
  return Boolean(a && b && a.provider === b.provider && a.modelId === b.id);
}
