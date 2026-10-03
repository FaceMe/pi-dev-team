/** Validation of the planner's ticket list. */

import type { Ticket } from "./types.js";

export interface PlanCheck {
  tickets: Ticket[];
  errors: string[];
  warnings: string[];
}

const TICKET_ROLES = new Set(["backend", "frontend", "devops", "docs"]);
const MAX_SCOPE_ERRORS = 5;

/**
 * Conservative write-scope overlap heuristic: identical globs, the catch-all
 * `**` (writeScope entries are never empty strings), or — after stripping a
 * trailing `/**` — one glob being a path prefix of the other.
 */
function globsOverlap(a: string, b: string): boolean {
  if (a === "**" || b === "**") return true;
  if (a === b) return true;
  const base = (g: string) => (g.endsWith("/**") ? g.slice(0, -3) : g);
  const [ba, bb] = [base(a), base(b)];
  return ba === bb || ba.startsWith(bb + "/") || bb.startsWith(ba + "/");
}

/** First overlapping glob pair of two scopes, reported as the more specific (longer) glob. */
export function firstOverlap(a: string[], b: string[]): string | undefined {
  for (const ga of a) {
    for (const gb of b) {
      if (globsOverlap(ga, gb)) return ga.length >= gb.length ? ga : gb;
    }
  }
  return undefined;
}

/**
 * Cycles over dependsOn edges between existing tickets, each as a closed path
 * [id, …, id]. One error per back edge found by the DFS, so every reported
 * cycle names edges that really exist.
 */
function dependencyCycles(tickets: Ticket[]): string[][] {
  const ids = new Set(tickets.map((t) => t.id));
  const depsOf = new Map(tickets.map((t) => [t.id, t.dependsOn.filter((d) => ids.has(d))]));
  // 0 = unvisited, 1 = on the current DFS path, 2 = fully explored
  const state = new Map<string, number>(tickets.map((t) => [t.id, 0]));
  const path: string[] = [];
  const cycles: string[][] = [];
  const visit = (id: string): void => {
    state.set(id, 1);
    path.push(id);
    for (const dep of depsOf.get(id) ?? []) {
      if (state.get(dep) === 1) cycles.push([...path.slice(path.indexOf(dep)), dep]);
      else if (state.get(dep) === 0) visit(dep);
    }
    path.pop();
    state.set(id, 2);
  };
  for (const t of tickets) if (state.get(t.id) === 0) visit(t.id);
  return cycles;
}

function cycleError(cycle: string[]): string {
  if (cycle.length === 2 && cycle[0] === cycle[1]) return `${cycle[0]} depends on itself`;
  return `ticket dependency cycle: ${cycle.join(" → ")}`;
}

/** Transitive dependsOn closure per ticket id, safe to call on cyclic graphs. */
function transitiveDeps(tickets: Ticket[]): Map<string, Set<string>> {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const memo = new Map<string, Set<string>>();
  const reach = (id: string): Set<string> => {
    const cached = memo.get(id);
    if (cached) return cached;
    const out = new Set<string>();
    memo.set(id, out); // seeded before recursing so cycles terminate
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dep) && dep !== id) {
        out.add(dep);
        for (const transitive of reach(dep)) out.add(transitive);
      }
    }
    return out;
  };
  for (const t of tickets) reach(t.id);
  return memo;
}

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

  // Dependency hygiene: deps must exist in the plan, point at earlier tickets, and be listed once.
  const ids = new Set(tickets.map((t) => t.id));
  tickets.forEach((ticket, index) => {
    const earlier = new Set(tickets.slice(0, index).map((t) => t.id));
    const listed = new Set<string>();
    for (const dep of ticket.dependsOn) {
      if (!ids.has(dep)) errors.push(`${ticket.id} depends on ${dep}, which does not exist in the plan`);
      else if (!earlier.has(dep)) errors.push(`${ticket.id} depends on ${dep}, which is not an earlier ticket`);
      if (listed.has(dep)) warnings.push(`${ticket.id} lists dependency ${dep} more than once`);
      listed.add(dep);
    }
    if (ticket.requirements.length === 0) warnings.push(`${ticket.id} covers no requirement ids`);
  });

  for (const cycle of dependencyCycles(tickets)) errors.push(cycleError(cycle));

  // Parallel tickets (neither transitively depends on the other) must not share a write scope (M4).
  const closures = transitiveDeps(tickets);
  const conflicts: string[] = [];
  for (let i = 0; i < tickets.length; i++) {
    for (let j = i + 1; j < tickets.length; j++) {
      const a = tickets[i];
      const b = tickets[j];
      if (closures.get(a.id)?.has(b.id) || closures.get(b.id)?.has(a.id)) continue;
      const overlap = firstOverlap(a.writeScope, b.writeScope);
      if (overlap) conflicts.push(`${a.id} and ${b.id} run in parallel but share write scope ${overlap} (make scopes disjoint or add a dependency)`);
    }
  }
  errors.push(...conflicts.slice(0, MAX_SCOPE_ERRORS));
  if (conflicts.length > MAX_SCOPE_ERRORS) errors.push(`… and ${conflicts.length - MAX_SCOPE_ERRORS} more overlapping ticket pairs`);

  const covered = new Set(tickets.flatMap((t) => t.requirements));
  const missingFr = requirementIds.filter((id) => id.startsWith("FR-") && !covered.has(id));
  if (missingFr.length > 0) errors.push(`requirements not covered by any ticket: ${missingFr.join(", ")}`);
  const missingNfr = requirementIds.filter((id) => id.startsWith("NFR-") && !covered.has(id));
  if (missingNfr.length > 0) warnings.push(`non-functional requirements not covered by any ticket: ${missingNfr.join(", ")}`);
  if (tickets.length > 40) warnings.push(`${tickets.length} tickets is a lot; consider merging small ones`);
  return { tickets, errors, warnings };
}

/** Requirement IDs (FR-001, NFR-002, …) mentioned in a spec. */
export function requirementIds(spec: string): string[] {
  return [...new Set(spec.match(/\b(?:FR|NFR)-\d{2,4}\b/g) ?? [])];
}
