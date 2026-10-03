/** Dependency ordering of the ticket list. */

import type { Ticket } from "./types.js";

/** Tickets in dependency order (stable for already-ordered plans). */
export function orderTickets(tickets: Ticket[]): Ticket[] {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const out: Ticket[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (t: Ticket) => {
    if (done.has(t.id) || visiting.has(t.id)) return;
    visiting.add(t.id);
    for (const dep of t.dependsOn) {
      const d = byId.get(dep);
      if (d) visit(d);
    }
    visiting.delete(t.id);
    done.add(t.id);
    out.push(t);
  };
  tickets.forEach(visit);
  return out;
}
