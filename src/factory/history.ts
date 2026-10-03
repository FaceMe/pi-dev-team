/**
 * Ticket history from the ledger (/factory history [ticket]): every worker
 * run, gate run and ticket event (started, QA, attempts, review, conflicts,
 * merges, escalation) for one ticket, or a one-line summary per ticket.
 */

import { formatCost, formatTokens } from "../shared/usage.js";
import { formatDiagnostic } from "./gate-parse.js";
import type { Diagnostic } from "./gate-parse.js";

type Entry = Record<string, any>;

function time(at: unknown): string {
  return typeof at === "string" && at.length >= 19 ? at.slice(11, 19) : "--:--:--";
}

function shortSha(sha: unknown): string {
  return typeof sha === "string" ? sha.slice(0, 7) : "";
}

function list(value: unknown, max = 4): string {
  if (!Array.isArray(value) || value.length === 0) return "";
  const shown = value.slice(0, max).map(String).join(", ");
  return value.length > max ? `${shown} +${value.length - max}` : shown;
}

function eventLine(e: Entry): string {
  switch (e.event) {
    case "started":
      return `started on ${e.branch ?? "its branch"}${e.base ? ` from ${shortSha(e.base)}` : ""}${e.model ? ` with ${e.model}` : ""}`;
    case "qa":
      return `QA: ${e.result}${e.reason ? ` (${e.reason})` : ""}${e.tests ? ` — ${list(e.tests)}` : ""}${e.error ? ` — ${e.error}` : ""}`;
    case "attempt":
      return `attempt ${e.attempt}: ${e.outcome} · ${e.model}${e.note ? ` — ${String(e.note).split("\n")[0].slice(0, 100)}` : ""}`;
    case "scope_revert":
      return `reverted out-of-scope files: ${list(e.files)}`;
    case "review":
      return `review: ${e.verdict}${e.blocking ? ` (${e.blocking} blocking)` : ""} · ${e.model ?? "reviewer"}`;
    case "conflict":
      return `merge conflict with integration${e.files?.length ? `: ${list(e.files)}` : e.error ? `: ${e.error}` : ""}`;
    case "integration_fail":
      return `gates failed on integration after merging${e.gate ? ` (${e.gate})` : ""}; merge undone`;
    case "merged":
      return `merged into integration ${shortSha(e.commit)}${e.files ? ` (${e.files} files)` : ""}`;
    case "escalated":
      return `escalated ${e.from} → ${e.to}`;
    case "done":
      return `✓ done after ${e.attempts} attempt(s)`;
    case "skipped":
      return "– skipped by you";
    case "blocked":
      return "✗ blocked — waiting for you";
    default:
      return String(e.event ?? "event");
  }
}

function gateLine(e: Entry): string {
  const where = e.where === "integration" ? " on integration" : e.where === "qa" ? " (QA red check)" : "";
  const failures = e.failures as { tests?: string[]; errors?: Diagnostic[] } | undefined;
  const detail = !e.ok && failures
    ? [failures.tests?.length ? `failing: ${list(failures.tests, 3)}` : "", failures.errors?.length ? formatDiagnostic(failures.errors[0]) : ""].filter(Boolean).join(" · ")
    : "";
  return `gates${where} ${e.ok ? "passed" : "FAILED"}: ${e.summary ?? ""}${detail ? ` — ${detail.slice(0, 140)}` : ""}`;
}

/** Every ledger line for one ticket, oldest first. */
export function ticketHistory(entries: Entry[], ticket: string, runId?: string): string[] {
  const mine = entries.filter((e) => e.ticket === ticket && (runId === undefined || e.runId === runId));
  if (mine.length === 0) return [`No history for ${ticket}${runId ? ` in ${runId}` : ""}.`];
  let cost = 0;
  let tokens = 0;
  const lines = mine.map((e) => {
    if (e.kind === "worker") {
      cost += e.costUsd ?? 0;
      tokens += e.tokens ?? 0;
      return `${time(e.at)}  ${e.role} · ${e.model} · ${e.turns ?? "?"} turn(s) · ${formatTokens(e.tokens ?? 0)} tok · ${formatCost(e.costUsd ?? 0)}${e.ok === false ? ` · error: ${String(e.error ?? "").slice(0, 80)}` : ""}`;
    }
    if (e.kind === "gates") return `${time(e.at)}  ${gateLine(e)}`;
    if (e.kind === "ticket") return `${time(e.at)}  ${eventLine(e)}`;
    return `${time(e.at)}  ${e.kind}`;
  });
  return [`history of ${ticket} — ${formatCost(cost)} · ${formatTokens(tokens)} tok`, ...lines];
}

/** One line per ticket: status, attempts, outcomes, cost. */
export function historyOverview(
  entries: Entry[],
  tickets: Array<{ id: string; title: string; status: string; attempts: Array<{ outcome: string }>; escalated?: boolean }>,
  runId?: string,
): string[] {
  if (tickets.length === 0) return ["No tickets yet."];
  const costOf = (id: string) =>
    entries.filter((e) => e.kind === "worker" && e.ticket === id && (runId === undefined || e.runId === runId)).reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
  const mark: Record<string, string> = { done: "✓", skipped: "–", blocked: "✗", in_progress: "▶", todo: "·" };
  return [
    "ticket history (/factory history <ticket> for details)",
    ...tickets.map((t) => {
      const outcomes = t.attempts.map((a) => a.outcome).join(" → ");
      return `${mark[t.status] ?? "·"} ${t.id} ${t.title.slice(0, 50)} · ${t.attempts.length} attempt(s)${outcomes ? ` (${outcomes})` : ""}${t.escalated ? " · escalated" : ""} · ${formatCost(costOf(t.id))}`;
    }),
  ];
}
