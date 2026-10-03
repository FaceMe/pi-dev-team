import { describe, expect, it } from "vitest";
import { requirementIds, validatePlan } from "../src/factory/plan.js";
import { buildTraceability, traceabilityJson, traceabilitySummary } from "../src/factory/traceability.js";
import type { Ticket } from "../src/factory/types.js";

/** A plan-ticket literal with per-ticket-disjoint write scopes so only the overridden fields can conflict. */
function raw(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: id,
    role: "backend",
    dependsOn: [],
    requirements: [],
    brief: `brief for ${id}`,
    acceptance: [],
    writeScope: [`.factory/${id}/**`],
    ...overrides,
  };
}

function plan(...tickets: Record<string, unknown>[]): any {
  return { tickets };
}

function ticketOf(id: string, requirements: string[]): Ticket {
  return { id, title: id, role: "backend", dependsOn: [], requirements, brief: id, acceptance: [], writeScope: [`${id}/**`], status: "todo", attempts: [] };
}

describe("validatePlan: dependency cycles", () => {
  it("reports a two-ticket cycle alongside the not-earlier error", () => {
    const check = validatePlan(plan(raw("T-001", { dependsOn: ["T-002"] }), raw("T-002", { dependsOn: ["T-001"] })), []);
    expect(check.errors).toEqual([
      "T-001 depends on T-002, which is not an earlier ticket",
      "ticket dependency cycle: T-001 → T-002 → T-001",
    ]);
  });

  it("reports a three-ticket cycle", () => {
    const check = validatePlan(
      plan(raw("T-001", { dependsOn: ["T-002"] }), raw("T-002", { dependsOn: ["T-003"] }), raw("T-003", { dependsOn: ["T-001"] })),
      [],
    );
    expect(check.errors).toContain("ticket dependency cycle: T-001 → T-002 → T-003 → T-001");
  });

  it("names self-dependencies", () => {
    const check = validatePlan(plan(raw("T-003", { dependsOn: ["T-003"] })), []);
    expect(check.errors).toEqual(["T-003 depends on T-003, which is not an earlier ticket", "T-003 depends on itself"]);
  });

  it("detects a cycle even when another dep merely points at a later ticket", () => {
    const check = validatePlan(
      plan(
        raw("T-001", { dependsOn: ["T-004"] }),
        raw("T-002", { dependsOn: ["T-003"] }),
        raw("T-003", { dependsOn: ["T-002"] }),
        raw("T-004"),
      ),
      [],
    );
    expect(check.errors).toEqual([
      "T-001 depends on T-004, which is not an earlier ticket",
      "T-002 depends on T-003, which is not an earlier ticket",
      "ticket dependency cycle: T-002 → T-003 → T-002",
    ]);
  });
});

describe("validatePlan: write-scope conflicts between parallel tickets", () => {
  const CONFLICT = (a: string, b: string, glob: string) =>
    `${a} and ${b} run in parallel but share write scope ${glob} (make scopes disjoint or add a dependency)`;

  it("flags identical globs on independent tickets", () => {
    const check = validatePlan(plan(raw("T-001", { writeScope: ["src/shared/**"] }), raw("T-002", { writeScope: ["src/shared/**"] })), []);
    expect(check.errors).toEqual([CONFLICT("T-001", "T-002", "src/shared/**")]);
  });

  it("treats the catch-all ** as overlapping anything", () => {
    const check = validatePlan(plan(raw("T-001", { writeScope: ["**"] }), raw("T-002", { writeScope: ["docs/**"] })), []);
    expect(check.errors).toEqual([CONFLICT("T-001", "T-002", "docs/**")]);
  });

  it("flags nested path prefixes and names the more specific glob", () => {
    const check = validatePlan(plan(raw("T-001", { writeScope: ["src/**"] }), raw("T-002", { writeScope: ["src/shared/**"] })), []);
    expect(check.errors).toEqual([CONFLICT("T-001", "T-002", "src/shared/**")]);
  });

  it("does not flag overlapping scopes when one ticket depends on the other", () => {
    const direct = validatePlan(plan(raw("T-001", { writeScope: ["src/**"] }), raw("T-002", { dependsOn: ["T-001"], writeScope: ["src/shared/**"] })), []);
    expect(direct.errors).toEqual([]);
    const transitive = validatePlan(
      plan(
        raw("T-001", { writeScope: ["src/**"] }),
        raw("T-002", { dependsOn: ["T-001"], writeScope: ["docs/**"] }),
        raw("T-003", { dependsOn: ["T-002"], writeScope: ["src/core/**"] }),
      ),
      [],
    );
    expect(transitive.errors).toEqual([]);
  });

  it("caps the conflict list at five pairs and summarises the rest", () => {
    const tickets = Array.from({ length: 8 }, (_, i) => raw(`T-${String(i + 1).padStart(3, "0")}`, { writeScope: ["src/**"] }));
    const check = validatePlan(plan(...tickets), []);
    expect(check.errors.slice(0, 5)).toEqual([
      CONFLICT("T-001", "T-002", "src/**"),
      CONFLICT("T-001", "T-003", "src/**"),
      CONFLICT("T-001", "T-004", "src/**"),
      CONFLICT("T-001", "T-005", "src/**"),
      CONFLICT("T-001", "T-006", "src/**"),
    ]);
    expect(check.errors).toHaveLength(6);
    expect(check.errors[5]).toBe("… and 23 more overlapping ticket pairs"); // C(8,2) = 28 pairs
  });

  it("accepts disjoint scopes, including look-alike prefixes", () => {
    const check = validatePlan(
      plan(
        raw("T-001", { writeScope: ["src/**"] }),
        raw("T-002", { writeScope: ["srcx/**"] }),
        raw("T-003", { writeScope: ["web/**"] }),
        raw("T-004", { writeScope: ["docs/**", "README.md"] }),
      ),
      [],
    );
    expect(check.errors).toEqual([]);
  });
});

describe("validatePlan: dependency hygiene", () => {
  it("errors on deps that do not exist in the plan, distinguishable from the not-earlier case", () => {
    const check = validatePlan(plan(raw("T-001", { requirements: ["FR-001"] }), raw("T-002", { dependsOn: ["T-009"], requirements: ["FR-001"] })), ["FR-001"]);
    expect(check.errors).toEqual(["T-002 depends on T-009, which does not exist in the plan"]);
    expect(check.errors.join(" ")).not.toMatch(/not an earlier ticket/);
  });

  it("warns about duplicate deps", () => {
    const check = validatePlan(
      plan(raw("T-001", { requirements: ["FR-001"] }), raw("T-002", { dependsOn: ["T-001", "T-001"], requirements: ["FR-001"] })),
      ["FR-001"],
    );
    expect(check.errors).toEqual([]);
    expect(check.warnings).toEqual(["T-002 lists dependency T-001 more than once"]);
  });

  it("warns when a ticket covers no requirements", () => {
    const check = validatePlan(plan(raw("T-001")), []);
    expect(check.errors).toEqual([]);
    expect(check.warnings).toEqual(["T-001 covers no requirement ids"]);
  });
});

describe("validatePlan: requirement coverage", () => {
  it("keeps the FR coverage error with exact ids", () => {
    const check = validatePlan(plan(raw("T-001", { requirements: ["FR-001"] })), ["FR-001", "FR-002"]);
    expect(check.errors).toEqual(["requirements not covered by any ticket: FR-002"]);
  });

  it("warns once about uncovered NFRs and stays quiet when they are covered", () => {
    const missing = validatePlan(plan(raw("T-001", { requirements: ["FR-001", "NFR-002"] })), ["FR-001", "NFR-001", "NFR-002"]);
    expect(missing.errors).toEqual([]);
    expect(missing.warnings).toEqual(["non-functional requirements not covered by any ticket: NFR-001"]);
    const covered = validatePlan(plan(raw("T-001", { requirements: ["FR-001", "NFR-001", "NFR-002"] })), ["FR-001", "NFR-001", "NFR-002"]);
    expect(covered.warnings.join(" ")).not.toMatch(/non-functional/);
  });
});

describe("requirementIds", () => {
  it("extracts unique FR/NFR ids of 2-4 digits in order", () => {
    expect(requirementIds("FR-001 NFR-02 FR-001 FR-1 FR-0002 NFR-0010")).toEqual(["FR-001", "NFR-02", "FR-0002", "NFR-0010"]);
    expect(requirementIds("no requirements here")).toEqual([]);
  });
});

describe("buildTraceability", () => {
  it("builds one row per unique requirement, FRs first, numeric order, spec-order dedup", () => {
    const matrix = buildTraceability(
      [ticketOf("T-001", ["FR-002", "NFR-001"]), ticketOf("T-002", ["FR-001"]), ticketOf("T-003", ["FR-001", "NFR-001"])],
      ["NFR-001", "FR-002", "FR-001", "NFR-001"],
    );
    expect(matrix.requirements).toEqual([
      { requirement: "FR-001", tickets: ["T-002", "T-003"] },
      { requirement: "FR-002", tickets: ["T-001"] },
      { requirement: "NFR-001", tickets: ["T-001", "T-003"] },
    ]);
    expect(matrix.complete).toBe(true);
  });

  it("sorts numerically, not lexicographically", () => {
    const matrix = buildTraceability([], ["FR-10", "FR-9"]);
    expect(matrix.requirements.map((r) => r.requirement)).toEqual(["FR-9", "FR-10"]);
  });

  it("completeness depends only on FR coverage", () => {
    expect(buildTraceability([ticketOf("T-001", ["FR-001", "FR-002"])], ["FR-001", "FR-002", "NFR-009"]).complete).toBe(true);
    expect(buildTraceability([ticketOf("T-001", ["FR-001"])], ["FR-001", "FR-002", "NFR-009"]).complete).toBe(false);
  });

  it("summarises coverage and caps the missing list at four ids", () => {
    const all = buildTraceability(
      [ticketOf("T-001", ["FR-001", "FR-002", "FR-003", "FR-004", "FR-005", "FR-006", "FR-007", "FR-008"])],
      ["FR-001", "FR-002", "FR-003", "FR-004", "FR-005", "FR-006", "FR-007", "FR-008"],
    );
    expect(traceabilitySummary(all)).toBe("traceability: 8/8 functional requirements covered");
    const fourMissing = buildTraceability(
      [ticketOf("T-001", ["FR-001", "FR-002"])],
      ["FR-001", "FR-002", "FR-003", "FR-004", "FR-005", "FR-006"],
    );
    expect(traceabilitySummary(fourMissing)).toBe("traceability: 2/6 functional requirements covered (missing FR-003, FR-004, FR-005, FR-006)");
    const fiveMissing = buildTraceability(
      [ticketOf("T-001", ["FR-001", "FR-002"])],
      ["FR-001", "FR-002", "FR-003", "FR-004", "FR-005", "FR-006", "FR-007"],
    );
    expect(traceabilitySummary(fiveMissing)).toBe("traceability: 2/7 functional requirements covered (missing FR-003, FR-004, FR-005, FR-006, …)");
  });

  it("serialises stable versioned JSON with a trailing newline", () => {
    const matrix = buildTraceability([ticketOf("T-001", ["FR-001"])], ["FR-001", "NFR-001"]);
    const text = traceabilityJson(matrix);
    expect(text).toBe(traceabilityJson(matrix));
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.startsWith('{\n  "version": 1,\n  "complete": true,\n  "requirements": [\n')).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe(1);
    expect(parsed.complete).toBe(true);
    expect(parsed.requirements).toEqual([
      { requirement: "FR-001", tickets: ["T-001"] },
      { requirement: "NFR-001", tickets: [] },
    ]);
  });
});

describe("plan end to end", () => {
  const ids = ["FR-001", "FR-002", "FR-003", "FR-004", "NFR-001"];
  const realistic = [
    raw("T-001", { title: "CI pipeline and Dockerfile", role: "devops", writeScope: [".github/**", "Dockerfile"] }),
    raw("T-002", { title: "Task API", requirements: ["FR-001", "NFR-001"], writeScope: ["src/server/**"] }),
    raw("T-003", { title: "Auth", dependsOn: ["T-002"], requirements: ["FR-002"], writeScope: ["src/server/auth/**"] }),
    raw("T-004", { title: "Board UI", role: "frontend", requirements: ["FR-003"], writeScope: ["web/src/**"] }),
    raw("T-005", { title: "Docs site", role: "docs", requirements: ["FR-004"], writeScope: ["docs/**"] }),
    raw("T-006", { title: "Board tests", role: "frontend", writeScope: ["web/src/**", "src/shared/**"] }),
  ];

  it("reports exactly the one parallel-scope conflict in a realistic plan", () => {
    const check = validatePlan(plan(...realistic), ids);
    expect(check.errors).toEqual([
      "T-004 and T-006 run in parallel but share write scope web/src/** (make scopes disjoint or add a dependency)",
    ]);
  });

  it("passes once the scopes are made disjoint, with only hygiene warnings left", () => {
    const fixed = realistic.map((t) => (t.id === "T-006" ? { ...t, writeScope: ["web/tests/**"] } : t));
    const check = validatePlan(plan(...fixed), ids);
    expect(check.errors).toEqual([]);
    expect(check.warnings).toEqual(["T-001 covers no requirement ids", "T-006 covers no requirement ids"]);
    expect(check.tickets.map((t) => t.id)).toEqual(["T-001", "T-002", "T-003", "T-004", "T-005", "T-006"]);
    const matrix = buildTraceability(check.tickets, ids);
    expect(matrix.complete).toBe(true);
    expect(traceabilitySummary(matrix)).toBe("traceability: 4/4 functional requirements covered");
    expect(matrix.requirements.map((r) => `${r.requirement}:${r.tickets.join("+")}`)).toEqual([
      "FR-001:T-002",
      "FR-002:T-003",
      "FR-003:T-004",
      "FR-004:T-005",
      "NFR-001:T-002",
    ]);
  });
});
