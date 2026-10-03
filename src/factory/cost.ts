/**
 * Cost reporting over the `.factory/ledger.jsonl` worker entries: totals,
 * per-phase/role/model/ticket breakdowns, and an estimate of what the same
 * work would have cost on a frontier model.
 */

import { formatCost, formatTokens } from "../shared/usage.js";
import { truncate } from "../shared/text.js";

export interface LedgerEntry {
  at?: string;
  kind?: string;
  phase?: string;
  role?: string;
  model?: string;
  ticket?: string;
  turns?: number;
  tokens?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  ok?: boolean;
  error?: string;
  runId?: string;
  [k: string]: unknown;
}

export interface CostRow {
  key: string;
  runs: number;
  tokens: number;
  costUsd: number;
}

export interface CostReport {
  totalUsd: number;
  totalTokens: number;
  workerRuns: number;
  byPhase: CostRow[];
  byRole: CostRow[];
  byModel: CostRow[];
  byTicket: CostRow[];
  /** Estimated cost of the same tokens at the frontier model's rate; null when no rate given. */
  frontierUsd: number | null;
  /** frontierUsd - totalUsd; null when unpriced. */
  savingsUsd: number | null;
  /** 0-100; null when frontierUsd is null or <= 0. */
  savingsPct: number | null;
}

export interface CostReportOptions {
  /** Include only worker entries with this runId; legacy entries without one are excluded. */
  runId?: string;
  /** Frontier per-token rates (already divided by 1e6). */
  frontier?: { inPerToken: number; outPerToken: number; blendedPerToken: number };
}

const NO_TICKET = "(no ticket)";
const MAX_ROWS = 12;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function fieldKey(entry: LedgerEntry, field: "phase" | "role" | "model"): string {
  const value = entry[field];
  return typeof value === "string" && value ? value : "?";
}

function ticketKey(entry: LedgerEntry): string {
  return typeof entry.ticket === "string" && entry.ticket ? entry.ticket : NO_TICKET;
}

function groupBy(entries: LedgerEntry[], keyOf: (entry: LedgerEntry) => string): CostRow[] {
  const rows = new Map<string, CostRow>();
  for (const entry of entries) {
    const key = keyOf(entry);
    const row = rows.get(key) ?? { key, runs: 0, tokens: 0, costUsd: 0 };
    row.runs += 1;
    row.tokens += num(entry.tokens);
    row.costUsd += num(entry.costUsd);
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.costUsd - a.costUsd || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function frontierEstimate(entry: LedgerEntry, rates: NonNullable<CostReportOptions["frontier"]>): number {
  const tokensIn = num(entry.tokensIn);
  const tokensOut = num(entry.tokensOut);
  if (tokensIn > 0 || tokensOut > 0) return tokensIn * num(rates.inPerToken) + tokensOut * num(rates.outPerToken);
  return num(entry.tokens) * num(rates.blendedPerToken);
}

export function buildCostReport(entries: LedgerEntry[], opts?: CostReportOptions): CostReport {
  const runId = opts?.runId;
  const workers = entries.filter(
    (entry) => entry.kind === "worker" && (runId === undefined || entry.runId === runId),
  );

  const totalUsd = workers.reduce((sum, entry) => sum + num(entry.costUsd), 0);
  const totalTokens = workers.reduce((sum, entry) => sum + num(entry.tokens), 0);
  const rates = opts?.frontier;
  const frontierUsd = rates ? workers.reduce((sum, entry) => sum + frontierEstimate(entry, rates), 0) : null;
  const savingsUsd = frontierUsd === null ? null : frontierUsd - totalUsd;
  const savingsPct = frontierUsd !== null && frontierUsd > 0 ? ((frontierUsd - totalUsd) / frontierUsd) * 100 : null;

  return {
    totalUsd,
    totalTokens,
    workerRuns: workers.length,
    byPhase: groupBy(workers, (entry) => fieldKey(entry, "phase")),
    byRole: groupBy(workers, (entry) => fieldKey(entry, "role")),
    byModel: groupBy(workers, (entry) => fieldKey(entry, "model")),
    byTicket: groupBy(workers, ticketKey),
    frontierUsd,
    savingsUsd,
    savingsPct,
  };
}

function pctLabel(pct: number | null): string {
  return pct !== null && Number.isFinite(pct) ? `${Math.round(pct * 10) / 10}` : "0";
}

function renderSection(lines: string[], label: string, rows: CostRow[], always: boolean): void {
  if (!rows.length || (!always && rows.length < 2)) return;
  lines.push(`${label}:`);
  const shown = rows.slice(0, MAX_ROWS);
  for (const row of shown) {
    lines.push(
      `  ${truncate(row.key, 40)}: ${row.runs} run(s) · ${formatTokens(row.tokens)} tok · ${formatCost(row.costUsd)}`,
    );
  }
  if (rows.length > shown.length) lines.push(`… and ${rows.length - shown.length} more`);
}

export function renderCostReport(report: CostReport): string[] {
  const lines: string[] = [
    `total ${formatCost(report.totalUsd)} · ${formatTokens(report.totalTokens)} tokens · ${report.workerRuns} worker run(s)`,
  ];
  if (report.frontierUsd !== null) {
    if (report.savingsUsd !== null && report.savingsUsd > 0) {
      lines.push(
        `savings vs all-frontier: ${formatCost(report.savingsUsd)} (${pctLabel(report.savingsPct)}%, estimate)`,
      );
    } else {
      lines.push("no savings vs the frontier rate (estimate)");
    }
  }
  renderSection(lines, "by phase", report.byPhase, false);
  renderSection(lines, "by role", report.byRole, false);
  renderSection(lines, "by model", report.byModel, false);
  renderSection(lines, "by ticket", report.byTicket, true);
  return lines;
}
