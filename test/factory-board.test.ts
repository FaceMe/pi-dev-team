import { describe, expect, it } from "vitest";
import { boardLines } from "../src/factory/board.js";
import type { FactoryState, Ticket, TicketAttempt } from "../src/factory/types.js";

function attempt(): TicketAttempt {
  return { model: "test/model", outcome: "ok", costUsd: 0.01, at: "2026-10-03T00:00:00.000Z" };
}

function ticket(id: string, status: Ticket["status"], overrides: Partial<Ticket> = {}): Ticket {
  return {
    id,
    title: `ticket ${id}`,
    role: "backend",
    dependsOn: [],
    requirements: [],
    brief: "",
    acceptance: [],
    writeScope: [],
    status,
    attempts: [],
    ...overrides,
  };
}

function state(overrides: Partial<FactoryState> = {}): FactoryState {
  return {
    version: 1,
    runId: "run-board",
    idea: "a board",
    phase: "build",
    status: "running",
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    answers: [],
    interviewRounds: 0,
    tickets: [],
    spentUsd: 0,
    spentTokens: 0,
    budgetUsd: 0,
    budgetTokens: 0,
    notes: [],
    ...overrides,
  };
}

describe("boardLines", () => {
  it("orders active tickets by advancement and collapses done/skipped", () => {
    const s = state({
      spentUsd: 1.25,
      budgetUsd: 10,
      tickets: [
        ticket("T-005", "todo"),
        ticket("T-002", "done"),
        ticket("T-003", "blocked", { role: "frontend", title: "stuck login" }),
        ticket("T-004", "skipped"),
        ticket("T-001", "in_progress", { attempts: [attempt(), attempt()] }),
      ],
    });
    expect(boardLines(s)).toEqual([
      "🏭 factory · build · 1/5 tickets · $1.25/$10",
      "  ▶ T-001 backend — ticket T-001 (attempt 2)",
      "  ✗ T-003 blocked — stuck login",
      "  · T-005 todo — ticket T-005",
      "  ✓ 1 done · – 1 skipped",
    ]);
  });

  it("omits the attempt suffix for a first attempt and for non-running tickets", () => {
    const s = state({
      tickets: [ticket("T-001", "in_progress", { attempts: [attempt()] }), ticket("T-002", "blocked", { attempts: [attempt(), attempt()] })],
    });
    expect(boardLines(s).slice(1, 3)).toEqual(["  ▶ T-001 backend — ticket T-001", "  ✗ T-002 blocked — ticket T-002"]);
  });

  it("formats the budget for usd-only, tokens-only and unpriced runs", () => {
    expect(boardLines(state({ budgetUsd: 10, spentUsd: 0.05 }))[0]).toBe("🏭 factory · build · $0.05/$10");
    expect(boardLines(state({ budgetTokens: 500_000, spentTokens: 1_234 }))[0]).toBe("🏭 factory · build · 1.2k/500.0k tok");
    expect(boardLines(state())[0]).toBe("🏭 factory · build · $0.00");
    expect(boardLines(state({ spentUsd: 2 }))[0]).toBe("🏭 factory · build · $2.00");
  });

  it("shows the status in the header when not running, and nothing when there are no tickets", () => {
    expect(boardLines(state({ phase: "spec", status: "paused" }))).toEqual(["🏭 factory · spec (paused) · $0.00"]);
    expect(boardLines(state({ status: "waiting" }))[0]).toBe("🏭 factory · build (waiting) · $0.00");
  });

  it("appends extra to the header and the last two activity lines at the bottom", () => {
    const lines = boardLines(state({ tickets: [ticket("T-001", "done")] }), {
      extra: "running gates",
      activity: ["backend: first", "backend: second", "backend: third"],
    });
    expect(lines).toEqual([
      "🏭 factory · build · 1/1 tickets · $0.00 · running gates",
      "  ✓ 1 done",
      "  backend: second",
      "  backend: third",
    ]);
    expect(boardLines(state(), { activity: [] })).toHaveLength(1);
  });

  it("shows the truncated last stop only on failed runs", () => {
    const long = "x".repeat(150);
    const failed = boardLines(state({ status: "failed", lastError: long }));
    expect(failed).toEqual(["🏭 factory · build (failed) · $0.00", `  last stop: ${"x".repeat(99)}…`]);
    expect(boardLines(state({ status: "paused", lastError: long })).some((l) => l.includes("last stop"))).toBe(false);
  });

  it("caps the board at four ticket lines and ten lines overall", () => {
    const tickets = [
      ...Array.from({ length: 6 }, (_v, i) => ticket(`T-00${i + 1}`, "in_progress")),
      ticket("T-010", "done"),
      ticket("T-011", "skipped"),
    ];
    const lines = boardLines(state({ status: "failed", lastError: "boom", tickets }), { activity: ["a: 1", "b: 2", "c: 3"] });
    expect(lines).toHaveLength(9);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines.filter((l) => l.startsWith("  ▶"))).toHaveLength(4);
    expect(lines.at(-1)).toBe("  c: 3");
  });

  it("truncates long ticket titles to ~60 chars", () => {
    const lines = boardLines(state({ tickets: [ticket("T-001", "todo", { title: "y".repeat(90) })] }));
    expect(lines[1]).toBe(`  · T-001 todo — ${"y".repeat(59)}…`);
  });

  it("does not mutate the given state", () => {
    const s = state({ tickets: [ticket("T-002", "todo"), ticket("T-001", "in_progress", { attempts: [attempt()] })] });
    boardLines(s, { activity: ["x: 1"] });
    expect(s.tickets.map((t) => t.id)).toEqual(["T-002", "T-001"]);
    expect(s.tickets[1].status).toBe("in_progress");
  });
});
