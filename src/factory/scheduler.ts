/**
 * The build scheduler (plan §10.2): which tickets may start now.
 *
 * A ticket starts only when every dependency is settled (done, or skipped by
 * the user) and its write scope overlaps no running ticket's scope, up to
 * `maxParallel` at once. The planner already rejects overlapping scopes between
 * tickets that could run in parallel; checking again here keeps a hand-edited
 * tickets.json (or the lockfiles added to manifest-owning scopes) safe.
 */

import { orderTickets } from "./order.js";
import { firstOverlap } from "./plan.js";
import type { Ticket } from "./types.js";

const SETTLED = new Set<Ticket["status"]>(["done", "skipped"]);

export function isSettled(ticket: Ticket): boolean {
  return SETTLED.has(ticket.status);
}

/** Tickets that can start now, in dependency order. `running` holds the ids already in flight. */
export function nextRunnable(
  tickets: Ticket[],
  running: ReadonlySet<string>,
  maxParallel: number,
  scopeOf: (ticket: Ticket) => string[] = (t) => t.writeScope,
): Ticket[] {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const busy = tickets.filter((t) => running.has(t.id));
  const picked: Ticket[] = [];
  for (const ticket of orderTickets(tickets)) {
    if (busy.length + picked.length >= maxParallel) break;
    if (running.has(ticket.id) || isSettled(ticket) || ticket.status === "blocked") continue;
    // A dependency the plan does not contain cannot block (validatePlan already rejects it).
    const waiting = ticket.dependsOn.some((dep) => {
      const d = byId.get(dep);
      return d !== undefined && !isSettled(d);
    });
    if (waiting) continue;
    const scope = scopeOf(ticket);
    if ([...busy, ...picked].some((other) => firstOverlap(scope, scopeOf(other)) !== undefined)) continue;
    picked.push(ticket);
  }
  return picked;
}
