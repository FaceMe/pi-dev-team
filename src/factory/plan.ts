/** Validation of the planner's ticket list. */

import type { Ticket } from "./types.js";

export interface PlanCheck {
  tickets: Ticket[];
  errors: string[];
  warnings: string[];
}

const TICKET_ROLES = new Set(["backend", "frontend", "devops", "docs"]);

export function validatePlan(raw: any, requirementIds: string[]): PlanCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const list = Array.isArray(raw?.tickets) ? raw.tickets : Array.isArray(raw) ? raw : null;
  if (!list) return { tickets: [], errors: ['the reply needs a "tickets" array'], warnings };
  if (list.length === 0) errors.push("the plan has no tickets");

  const tickets: Ticket[] = [];
  const seen = new Set<string>();
  list.forEach((item: any, index: number) => {
    const id = typeof item?.id === "string" && item.id.trim() ? item.id.trim() : `T-${String(index + 1).padStart(3, "0")}`;
    if (seen.has(id)) errors.push(`duplicate ticket id ${id}`);
    const deps = Array.isArray(item?.dependsOn) ? item.dependsOn.filter((d: unknown) => typeof d === "string") : [];
    for (const dep of deps) if (!seen.has(dep)) errors.push(`${id} depends on ${dep}, which is not an earlier ticket`);
    seen.add(id);
    let role = typeof item?.role === "string" ? item.role.trim().toLowerCase() : "backend";
    if (!TICKET_ROLES.has(role)) {
      warnings.push(`${id}: unknown role "${role}", assigned to backend`);
      role = "backend";
    }
    const writeScope = Array.isArray(item?.writeScope) ? item.writeScope.filter((g: unknown) => typeof g === "string" && g.trim()) : [];
    if (writeScope.length === 0) errors.push(`${id} has no writeScope`);
    const brief = typeof item?.brief === "string" ? item.brief.trim() : "";
    if (!brief) errors.push(`${id} has no brief`);
    tickets.push({
      id,
      title: typeof item?.title === "string" && item.title.trim() ? item.title.trim() : id,
      role,
      dependsOn: deps,
      requirements: Array.isArray(item?.requirements) ? item.requirements.filter((r: unknown) => typeof r === "string") : [],
      brief,
      acceptance: Array.isArray(item?.acceptance) ? item.acceptance.filter((a: unknown) => typeof a === "string") : [],
      writeScope,
      status: "todo",
      attempts: [],
    });
  });

  const covered = new Set(tickets.flatMap((t) => t.requirements));
  const missing = requirementIds.filter((id) => id.startsWith("FR-") && !covered.has(id));
  if (missing.length > 0) errors.push(`requirements not covered by any ticket: ${missing.join(", ")}`);
  if (tickets.length > 40) warnings.push(`${tickets.length} tickets is a lot; consider merging small ones`);
  return { tickets, errors, warnings };
}

/** Requirement IDs (FR-001, NFR-002, …) mentioned in a spec. */
export function requirementIds(spec: string): string[] {
  return [...new Set(spec.match(/\b(?:FR|NFR)-\d{2,4}\b/g) ?? [])];
}
