/** Compact status board for a factory run: the status widget and /factory board. */

import { truncate } from "../shared/text.js";
import { formatCost, formatTokens } from "../shared/usage.js";
import type { FactoryState, Ticket } from "./types.js";

/** Most advanced status first; done/skipped are only ever collapsed. */
const STATUS_RANK: Record<Ticket["status"], number> = { in_progress: 0, blocked: 1, todo: 2, done: 3, skipped: 3 };

export function boardLines(state: FactoryState, opts: { activity?: string[]; extra?: string } = {}): string[] {
  const done = state.tickets.filter((t) => t.status === "done").length;
  const skipped = state.tickets.filter((t) => t.status === "skipped").length;
  const budget =
    state.budgetUsd > 0
      ? `${formatCost(state.spentUsd)}/$${state.budgetUsd}`
      : state.budgetTokens > 0
        ? `${formatTokens(state.spentTokens)}/${formatTokens(state.budgetTokens)} tok`
        : formatCost(state.spentUsd);
  const label = state.status === "running" ? state.phase : `${state.phase} (${state.status})`;
  const ticketsLabel = state.tickets.length ? ` · ${done}/${state.tickets.length} tickets` : "";
  const lines = [`🏭 factory · ${label}${ticketsLabel} · ${budget}${opts.extra ? ` · ${opts.extra}` : ""}`];

  const active = state.tickets
    .filter((t) => t.status !== "done" && t.status !== "skipped")
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])
    .slice(0, 4);
  for (const t of active) {
    const title = truncate(t.title, 60);
    if (t.status === "in_progress") {
      const attempts = t.attempts.length > 1 ? ` (attempt ${t.attempts.length})` : "";
      lines.push(`  ▶ ${t.id} ${t.role} — ${title}${attempts}`);
    } else if (t.status === "blocked") {
      lines.push(`  ✗ ${t.id} blocked — ${title}`);
    } else {
      lines.push(`  · ${t.id} todo — ${title}`);
    }
  }

  const collapsed = [done > 0 ? `✓ ${done} done` : "", skipped > 0 ? `– ${skipped} skipped` : ""].filter(Boolean).join(" · ");
  if (collapsed) lines.push(`  ${collapsed}`);

  if (state.status === "failed" && state.lastError) lines.push(`  last stop: ${truncate(state.lastError, 100)}`);
  if (opts.activity?.length) for (const line of opts.activity.slice(-2)) lines.push(`  ${line}`);
  return lines.slice(0, 10);
}
