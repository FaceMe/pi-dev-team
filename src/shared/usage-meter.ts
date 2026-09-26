/**
 * Per-agent token meter: requests, input/output, cache reads/writes, cost and
 * cache hit rate, updated as each model response lands (real time).
 *
 * pi-ai normalises every provider so that `input` excludes cached tokens; the
 * prompt a request sent is therefore input + cacheRead + cacheWrite, and the
 * cache hit rate is cacheRead / prompt.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { formatCost, formatTokens } from "./usage.js";

export interface MeterTotals {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface MeterSnapshot extends MeterTotals {
  /** Prompt tokens sent (input + cacheRead + cacheWrite). */
  prompt: number;
  /** cacheRead / prompt over all requests, or undefined when nothing was sent. */
  hitRate?: number;
  /** The most recent request, for spotting a cold cache as it happens. */
  last?: MeterTotals & { prompt: number; hitRate?: number; at: number };
  /** True once the provider reported any cache activity. */
  cacheReported: boolean;
}

const zero = (): MeterTotals => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

export function promptTokens(u: Pick<MeterTotals, "input" | "cacheRead" | "cacheWrite">): number {
  return u.input + u.cacheRead + u.cacheWrite;
}

export function hitRate(u: Pick<MeterTotals, "input" | "cacheRead" | "cacheWrite">): number | undefined {
  const prompt = promptTokens(u);
  return prompt > 0 ? u.cacheRead / prompt : undefined;
}

export class UsageMeter {
  private totals = zero();
  private last?: MeterSnapshot["last"];

  /** Record one model response's usage. Ignores empty/zero usage (e.g. aborted before any tokens). */
  add(usage?: Partial<Usage> | null): void {
    if (!usage) return;
    const entry: MeterTotals = {
      requests: 1,
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      cost: usage.cost?.total ?? 0,
    };
    if (promptTokens(entry) + entry.output === 0) return;
    for (const key of Object.keys(entry) as Array<keyof MeterTotals>) this.totals[key] += entry[key];
    this.last = { ...entry, prompt: promptTokens(entry), hitRate: hitRate(entry), at: Date.now() };
  }

  snapshot(): MeterSnapshot {
    const t = { ...this.totals };
    return {
      ...t,
      prompt: promptTokens(t),
      hitRate: hitRate(t),
      last: this.last ? { ...this.last } : undefined,
      cacheReported: t.cacheRead + t.cacheWrite > 0,
    };
  }

  reset(): void {
    this.totals = zero();
    this.last = undefined;
  }
}

const pct = (value?: number) => (value === undefined ? "–" : `${Math.round(value * 100)}%`);

/**
 * Detailed line: "14 req · ↑456k (6.2k new · 412k cache read · 38k cache write) · 90% cached (last 97%) · ↓3.1k · $0.61".
 * ↑ is everything sent to the model (the prompt), ↓ is what it generated.
 */
export function formatMeter(s: MeterSnapshot): string {
  if (s.requests === 0) return "no requests yet";
  const up = s.cacheReported
    ? `↑${formatTokens(s.prompt)} (${formatTokens(s.input)} new · ${formatTokens(s.cacheRead)} cache read · ${formatTokens(s.cacheWrite)} cache write)` +
      ` · ${pct(s.hitRate)} cached${s.last ? ` (last ${pct(s.last.hitRate)})` : ""}`
    : `↑${formatTokens(s.prompt)} (no cache reported)`;
  return `${s.requests} req · ${up} · ↓${formatTokens(s.output)} · ${formatCost(s.cost)}`;
}

/** Compact cells for the one-line-per-agent widget: ["↑456k", "90% cached", "↓3.1k", "$0.61"]. */
export function meterCells(s: MeterSnapshot): { up: string; cached: string; down: string; cost: string } {
  return {
    up: `↑${formatTokens(s.prompt)}`,
    cached: s.cacheReported ? `${pct(s.hitRate)} cached` : "no cache",
    down: `↓${formatTokens(s.output)}`,
    cost: formatCost(s.cost),
  };
}

export { pct as formatPercent };
