/** Compact status board for a factory run: the status widget and /factory board. */

import { truncate } from "../shared/text.js";
import { formatCost, formatTokens } from "../shared/usage.js";
import type { FactoryState, Ticket } from "./types.js";

export interface WorkerSnapshot {
  id: string;
  role: string;
  model: string;
  ticket?: string;
  status: "running";
  activity?: string;
  startedAt?: number;
}

/** Full task list. The compact widget deliberately shows fewer rows. */
export function taskLines(state: FactoryState, id?: string): string[] {
  const tasks = id ? state.tickets.filter(task => task.id === id) : state.tickets;
  if (!tasks.length) return [id ? `No task named ${id}.` : `No tasks yet. Current phase: ${state.phase}.`];
  const lines = [`Tasks · ${state.tickets.filter(task => task.status === "done").length}/${state.tickets.length} complete`];
  for (const task of tasks) {
    lines.push(`${task.id} · ${task.status} · ${task.role} · ${task.title}`);
    const waiting = task.dependsOn.filter(dep => state.tickets.find(t => t.id === dep)?.status !== "done");
    if (waiting.length) lines.push(`  Waiting for: ${waiting.join(", ")}`);
    const last = task.attempts.at(-1);
    if (last) lines.push(`  Last attempt: ${last.outcome} · ${last.model}${last.note ? ` · ${truncate(last.note, 180)}` : ""}`);
    if (id) {
      lines.push(`  Requirements: ${task.requirements.join(", ") || "none"}`, `  Files: ${task.writeScope.join(", ") || "read-only"}`);
      if (task.brief) lines.push("", task.brief);
      if (task.acceptance.length) lines.push("", "Acceptance checks:", ...task.acceptance.map(check => `  - ${check}`));
    }
  }
  return lines;
}

/** Live process records and completed ledger records are separate sources. */
export function agentLines(state: FactoryState | null, live: WorkerSnapshot[], ledger: Array<Record<string, any>>): string[] {
  const lines = [`Subagents · ${live.length} running`];
  for (const worker of live) {
    lines.push(`▶ ${worker.role} · ${worker.model}${worker.ticket ? ` · ${worker.ticket}` : ""}`);
    if (worker.activity) lines.push(`  ${truncate(worker.activity, 160)}`);
  }
  if (!live.length) lines.push("No live workers in this session.");
  const recent = ledger.filter(entry => entry.kind === "worker" && state && entry.runId === state.runId).slice(-12).reverse();
  if (recent.length) {
    lines.push("", "Recent results (newest first):");
    for (const entry of recent) lines.push(`${entry.ok === false ? "✗" : "✓"} ${entry.role} · ${entry.model}${entry.ticket ? ` · ${entry.ticket}` : ""} · ${entry.ok === false ? "failed" : "complete"} · ${entry.at ?? ""}`);
  }
  lines.push("", "Use /factory trace <role|task> to inspect tool activity.");
  return lines;
}

/** Most advanced status first; done/skipped are only ever collapsed. */
const STATUS_RANK: Record<Ticket["status"], number> = { in_progress: 0, blocked: 1, todo: 2, done: 3, skipped: 3 };

export function boardLines(state: FactoryState, opts: { activity?: string[]; workers?: WorkerSnapshot[]; extra?: string } = {}): string[] {
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
  if (opts.workers?.length) {
    for (const worker of opts.workers.slice(0, 3)) lines.push(`  ↳ ${worker.role} · ${worker.model}${worker.ticket ? ` · ${worker.ticket}` : ""}${worker.activity ? ` · ${truncate(worker.activity, 70)}` : ""}`);
    if (opts.workers.length > 3) lines.push(`  + ${opts.workers.length - 3} more workers · /factory agents`);
  }

  const active = state.tickets
    .filter((t) => t.status !== "done" && t.status !== "skipped")
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])
    .slice(0, opts.workers?.length ? 3 : 4);
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
