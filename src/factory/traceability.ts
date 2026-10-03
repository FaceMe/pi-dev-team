/** Traceability matrix linking every requirement to the tickets covering it (§12.2, M4). */

import type { Ticket } from "./types.js";

export interface TraceabilityRow {
  requirement: string;
  tickets: string[];
}

export interface TraceabilityMatrix {
  requirements: TraceabilityRow[];
  complete: boolean;
}

/** FRs first, then NFRs, then anything else a spec might have slipped in. */
function requirementBucket(id: string): number {
  if (id.startsWith("FR-")) return 0;
  if (id.startsWith("NFR-")) return 1;
  return 2;
}

function requirementNumber(id: string): number {
  const n = Number(id.slice(id.indexOf("-") + 1));
  return Number.isFinite(n) ? n : 0;
}

export function buildTraceability(tickets: Ticket[], requirementIds: string[]): TraceabilityMatrix {
  const unique = [...new Set(requirementIds)];
  const requirements = unique
    .map((requirement) => ({
      requirement,
      tickets: tickets.filter((t) => t.requirements.includes(requirement)).map((t) => t.id),
    }))
    .sort(
      (a, b) =>
        requirementBucket(a.requirement) - requirementBucket(b.requirement) ||
        requirementNumber(a.requirement) - requirementNumber(b.requirement) ||
        (a.requirement < b.requirement ? -1 : a.requirement > b.requirement ? 1 : 0),
    );
  const functional = requirements.filter((r) => r.requirement.startsWith("FR-"));
  return { requirements, complete: functional.every((r) => r.tickets.length > 0) };
}

export function traceabilitySummary(matrix: TraceabilityMatrix): string {
  const functional = matrix.requirements.filter((r) => r.requirement.startsWith("FR-"));
  const covered = functional.filter((r) => r.tickets.length > 0).length;
  const head = `traceability: ${covered}/${functional.length} functional requirements covered`;
  const missing = functional.filter((r) => r.tickets.length === 0).map((r) => r.requirement);
  if (missing.length === 0) return head;
  return `${head} (missing ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ", …" : ""})`;
}

/** Stable serialization for .factory/traceability.json. */
export function traceabilityJson(matrix: TraceabilityMatrix): string {
  return `${JSON.stringify({ version: 1, complete: matrix.complete, requirements: matrix.requirements }, null, 2)}\n`;
}
