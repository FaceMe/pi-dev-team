import { describe, expect, it } from "vitest";
import { buildCostReport, renderCostReport } from "../src/factory/cost.js";
import type { LedgerEntry } from "../src/factory/cost.js";

function worker(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    at: "2026-01-01T00:00:00.000Z",
    kind: "worker",
    phase: "build",
    role: "coder",
    model: "x/y",
    turns: 1,
    tokens: 1000,
    costUsd: 0.01,
    ok: true,
    ...over,
  };
}

const RATES = { inPerToken: 3e-6, outPerToken: 15e-6, blendedPerToken: 5.4e-6 };

describe("buildCostReport", () => {
  it("counts only worker entries", () => {
    const report = buildCostReport([
      worker({ costUsd: 0.5, tokens: 1000 }),
      { at: "2026-01-01T00:00:00.000Z", kind: "gates", phase: "build", ok: true, summary: "pass", runId: "r1" },
      { at: "2026-01-01T00:00:00.000Z", kind: "note", tokens: 9999, costUsd: 99 },
    ]);
    expect(report.workerRuns).toBe(1);
    expect(report.totalUsd).toBe(0.5);
    expect(report.totalTokens).toBe(1000);
  });

  it("filters by runId and excludes legacy entries without one", () => {
    const entries: LedgerEntry[] = [
      worker({ runId: "r1", phase: "build", tokens: 1000, costUsd: 0.5 }),
      worker({ runId: "r1", phase: "review", tokens: 2000, costUsd: 0.25 }),
      worker({ runId: "r2", phase: "build", tokens: 4000, costUsd: 1 }),
      worker({ tokens: 8000, costUsd: 2 }), // legacy: written before runId existed
      { at: "2026-01-01T00:00:00.000Z", kind: "gates", phase: "build", ok: true, runId: "r1" },
    ];
    const filtered = buildCostReport(entries, { runId: "r1" });
    expect(filtered.workerRuns).toBe(2);
    expect(filtered.totalUsd).toBe(0.75);
    expect(filtered.totalTokens).toBe(3000);
    expect(filtered.byPhase.map((r) => [r.key, r.runs, r.costUsd])).toEqual([
      ["build", 1, 0.5],
      ["review", 1, 0.25],
    ]);

    const all = buildCostReport(entries);
    expect(all.workerRuns).toBe(4);
    expect(all.totalUsd).toBe(3.75);
    expect(all.totalTokens).toBe(15000);
  });

  it("groups by phase, role, model and ticket, sorted by cost then key", () => {
    const entries: LedgerEntry[] = [
      worker({ phase: "build", role: "coder", model: "a/small", ticket: "T-1", tokens: 1000, costUsd: 0.5 }),
      worker({ phase: "build", role: "reviewer", model: "a/small", ticket: "T-1", tokens: 500, costUsd: 0.25 }),
      worker({ phase: "plan", role: "coder", model: "b/mid", ticket: "T-1", tokens: 2000, costUsd: 1 }),
      worker({ phase: "build", role: "coder", model: "b/mid", ticket: "T-2", tokens: 800, costUsd: 0.5 }),
      worker({ phase: undefined, role: undefined, model: "a/small", ticket: "T-2", tokens: 100, costUsd: 0.0625 }),
    ];
    const report = buildCostReport(entries);
    expect(report.workerRuns).toBe(5);
    expect(report.totalUsd).toBe(2.3125);
    expect(report.totalTokens).toBe(4400);
    expect(report.byPhase).toEqual([
      { key: "build", runs: 3, tokens: 2300, costUsd: 1.25 },
      { key: "plan", runs: 1, tokens: 2000, costUsd: 1 },
      { key: "?", runs: 1, tokens: 100, costUsd: 0.0625 },
    ]);
    expect(report.byRole).toEqual([
      { key: "coder", runs: 3, tokens: 3800, costUsd: 2 },
      { key: "reviewer", runs: 1, tokens: 500, costUsd: 0.25 },
      { key: "?", runs: 1, tokens: 100, costUsd: 0.0625 },
    ]);
    expect(report.byModel).toEqual([
      { key: "b/mid", runs: 2, tokens: 2800, costUsd: 1.5 },
      { key: "a/small", runs: 3, tokens: 1600, costUsd: 0.8125 },
    ]);
    expect(report.byTicket).toEqual([
      { key: "T-1", runs: 3, tokens: 3500, costUsd: 1.75 },
      { key: "T-2", runs: 2, tokens: 900, costUsd: 0.5625 },
    ]);
  });

  it("breaks cost ties alphabetically by key", () => {
    const report = buildCostReport([
      worker({ phase: "zeta", costUsd: 0.25 }),
      worker({ phase: "alpha", costUsd: 1 }),
      worker({ phase: "mid", costUsd: 1 }),
    ]);
    expect(report.byPhase.map((r) => r.key)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("groups ticketless entries under (no ticket), omitting the group when empty", () => {
    const withNone = buildCostReport([
      worker({ ticket: "T-1", costUsd: 0.5 }),
      worker({ ticket: undefined, costUsd: 0.125 }),
    ]);
    expect(withNone.byTicket.map((r) => r.key)).toEqual(["T-1", "(no ticket)"]);

    const allTicketed = buildCostReport([worker({ ticket: "T-1", costUsd: 0.5 }), worker({ ticket: "T-2", costUsd: 0.25 })]);
    expect(allTicketed.byTicket.map((r) => r.key)).toEqual(["T-1", "T-2"]);
  });
});

describe("frontier estimate", () => {
  it("prices tokensIn/tokensOut when present, blended tokens otherwise", () => {
    const report = buildCostReport(
      [
        worker({ tokens: 1_500_000, tokensIn: 1_000_000, tokensOut: 500_000, costUsd: 1.5 }), // 10.5
        worker({ tokens: 2_000_000, costUsd: 1 }), // legacy: blended 10.8
        worker({ tokens: 1_000_000, tokensIn: 0, tokensOut: 0, costUsd: 0.5 }), // zeros fall back to blended 5.4
      ],
      { frontier: RATES },
    );
    expect(report.frontierUsd).toBeCloseTo(26.7, 6);
    expect(report.savingsUsd).toBeCloseTo(23.7, 6);
    expect(report.savingsPct).toBeCloseTo(88.764, 2);
  });

  it("uses inPerToken alone when only tokensIn is set", () => {
    const report = buildCostReport([worker({ tokens: 1_000_000, tokensIn: 400_000, costUsd: 0.25 })], {
      frontier: RATES,
    });
    expect(report.frontierUsd).toBeCloseTo(1.2, 6);
  });

  it("leaves the estimate null when no rates are given", () => {
    const report = buildCostReport([worker({ tokens: 1000, tokensIn: 800, tokensOut: 200, costUsd: 0.01 })]);
    expect(report.frontierUsd).toBeNull();
    expect(report.savingsUsd).toBeNull();
    expect(report.savingsPct).toBeNull();
  });

  it("nulls savingsPct when frontierUsd <= 0", () => {
    const report = buildCostReport([], { frontier: RATES });
    expect(report.frontierUsd).toBe(0);
    expect(report.savingsUsd).toBe(0);
    expect(report.savingsPct).toBeNull();
  });
});

describe("renderCostReport", () => {
  it("renders totals, savings and every breakdown", () => {
    const report = buildCostReport([
      worker({ phase: "build", role: "coder", model: "a/small", ticket: "T-1", tokens: 1000, costUsd: 0.5 }),
      worker({ phase: "build", role: "reviewer", model: "a/small", ticket: "T-1", tokens: 500, costUsd: 0.25 }),
      worker({ phase: "plan", role: "coder", model: "b/mid", ticket: "T-1", tokens: 2000, costUsd: 1 }),
      worker({ phase: "build", role: "coder", model: "b/mid", ticket: "T-2", tokens: 800, costUsd: 0.5 }),
      worker({ phase: undefined, role: undefined, model: "a/small", ticket: "T-2", tokens: 100, costUsd: 0.0625 }),
    ]);
    expect(renderCostReport(report)).toEqual([
      "total $2.31 · 4.4k tokens · 5 worker run(s)",
      "by phase:",
      "  build: 3 run(s) · 2.3k tok · $1.25",
      "  plan: 1 run(s) · 2.0k tok · $1.00",
      "  ?: 1 run(s) · 100 tok · $0.06",
      "by role:",
      "  coder: 3 run(s) · 3.8k tok · $2.00",
      "  reviewer: 1 run(s) · 500 tok · $0.25",
      "  ?: 1 run(s) · 100 tok · $0.06",
      "by model:",
      "  b/mid: 2 run(s) · 2.8k tok · $1.50",
      "  a/small: 3 run(s) · 1.6k tok · $0.81",
      "by ticket:",
      "  T-1: 3 run(s) · 3.5k tok · $1.75",
      "  T-2: 2 run(s) · 900 tok · $0.56",
    ]);
  });

  it("skips the savings line without rates", () => {
    const lines = renderCostReport(buildCostReport([worker({ costUsd: 0.5 })]));
    expect(lines[0]).toBe("total $0.50 · 1.0k tokens · 1 worker run(s)");
    expect(lines.some((line) => line.includes("savings"))).toBe(false);
  });

  it("renders positive savings with a percentage", () => {
    const report = buildCostReport(
      [
        worker({ tokens: 1_500_000, tokensIn: 1_000_000, tokensOut: 500_000, costUsd: 1.5 }),
        worker({ tokens: 2_000_000, costUsd: 1 }),
        worker({ tokens: 1_000_000, tokensIn: 0, tokensOut: 0, costUsd: 0.5 }),
      ],
      { frontier: RATES },
    );
    const lines = renderCostReport(report);
    expect(lines[0]).toBe("total $3.00 · 4.50M tokens · 3 worker run(s)");
    expect(lines[1]).toBe("savings vs all-frontier: $23.70 (88.8%, estimate)");
  });

  it("renders no-savings when the estimate does not beat the frontier", () => {
    const negative = buildCostReport(
      [worker({ tokens: 1_000_000, tokensIn: 1_000_000, tokensOut: 0, costUsd: 30 })],
      { frontier: RATES },
    );
    expect(negative.savingsUsd).toBeCloseTo(-27, 6);
    expect(renderCostReport(negative)).toContain("no savings vs the frontier rate (estimate)");

    const zero = buildCostReport([worker({ tokens: 1_000_000, tokensIn: 1_000_000, tokensOut: 0, costUsd: 3 })], {
      frontier: RATES,
    });
    expect(zero.savingsUsd).toBeCloseTo(0, 6);
    expect(zero.savingsPct).toBeCloseTo(0, 6);
    expect(renderCostReport(zero)).toContain("no savings vs the frontier rate (estimate)");
  });

  it("hides single-row breakdowns except by ticket", () => {
    const report = buildCostReport([
      worker({ phase: "build", role: "coder", model: "a/small", ticket: "T-1", tokens: 1000, costUsd: 0.25 }),
      worker({ phase: "build", role: "coder", model: "b/mid", ticket: "T-1", tokens: 1000, costUsd: 0.5 }),
    ]);
    expect(renderCostReport(report)).toEqual([
      "total $0.75 · 2.0k tokens · 2 worker run(s)",
      "by model:",
      "  b/mid: 1 run(s) · 1.0k tok · $0.50",
      "  a/small: 1 run(s) · 1.0k tok · $0.25",
      "by ticket:",
      "  T-1: 2 run(s) · 2.0k tok · $0.75",
    ]);
  });

  it("caps breakdowns at 12 rows", () => {
    const entries = Array.from({ length: 15 }, (_, i) =>
      worker({ ticket: `T-${String(i + 1).padStart(2, "0")}`, tokens: 100, costUsd: 0.125 }),
    );
    const report = buildCostReport(entries);
    expect(report.byTicket).toHaveLength(15);
    const lines = renderCostReport(report);
    expect(lines).toHaveLength(2 + 12 + 1);
    expect(lines[1]).toBe("by ticket:");
    expect(lines[2]).toBe("  T-01: 1 run(s) · 100 tok · $0.13");
    expect(lines.at(-1)).toBe("… and 3 more");
    expect(lines.slice(2, 14).every((line) => line.startsWith("  T-"))).toBe(true);
  });

  it("renders an empty ledger as a bare total line", () => {
    const report = buildCostReport([]);
    expect(report).toMatchObject({
      totalUsd: 0,
      totalTokens: 0,
      workerRuns: 0,
      byPhase: [],
      byRole: [],
      byModel: [],
      byTicket: [],
      frontierUsd: null,
      savingsUsd: null,
      savingsPct: null,
    });
    expect(renderCostReport(report)).toEqual(["total $0.00 · 0 tokens · 0 worker run(s)"]);
  });
});
