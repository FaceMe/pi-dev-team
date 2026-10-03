/**
 * The readiness checklist (plan §9.3): the nine topics the discovery interview
 * must resolve before the spec is drafted. Each is "known" (the user answered),
 * "assumed" (a safe default is recorded in the answers) or "unknown" (still
 * needs a question). The checklist — not the analyst's own judgement — decides
 * when the interview has gone deep enough.
 */

export const READINESS_TOPICS: readonly string[] = [
  "problem",
  "users",
  "journeys",
  "data",
  "integrations",
  "nfrs",
  "constraints",
  "outOfScope",
  "acceptance",
];

export const READINESS_LABELS: Readonly<Record<string, string>> = {
  problem: "Problem and success metrics",
  users: "Users and permissions",
  journeys: "Core user journeys",
  data: "Data and privacy",
  integrations: "Integrations",
  nfrs: "Non-functional requirements",
  constraints: "Constraints",
  outOfScope: "Out of scope for v1",
  acceptance: "How the user will accept it",
};

export type ReadinessStatus = "known" | "assumed" | "unknown";

export interface ReadinessItem {
  topic: string;
  status: ReadinessStatus;
  note?: string;
}

export interface Readiness {
  items: ReadinessItem[];
  /** Items not "unknown" over total, 0..1. */
  score: number;
}

const STATUSES: readonly ReadinessStatus[] = ["known", "assumed", "unknown"];

/** Compare topics ignoring case and separators, so ids and display names both work. */
const topicKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

const CANONICAL_TOPICS = new Map<string, string>();
for (const topic of READINESS_TOPICS) {
  CANONICAL_TOPICS.set(topicKey(topic), topic);
  CANONICAL_TOPICS.set(topicKey(READINESS_LABELS[topic]), topic);
}

export function readinessLabel(topic: string): string {
  return READINESS_LABELS[topic] ?? topic;
}

/**
 * Coerce a model reply (or persisted state) into a full checklist: accepts
 * { items: [...] } or a bare array; unknown topics are dropped, missing topics
 * are filled with "unknown"; items end sorted in READINESS_TOPICS order with
 * every topic present exactly once. Returns null for input that is not a
 * checklist at all.
 */
export function normalizeReadiness(value: unknown): Readiness | null {
  const rawItems = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)
      ? ((value as { items: unknown[] }).items as unknown[])
      : null;
  if (!rawItems) return null;
  const byTopic = new Map<string, ReadinessItem>();
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const topic = typeof item.topic === "string" ? CANONICAL_TOPICS.get(topicKey(item.topic)) : undefined;
    if (!topic) continue;
    byTopic.set(topic, {
      topic,
      status: STATUSES.includes(item.status as ReadinessStatus) ? (item.status as ReadinessStatus) : "unknown",
      note: typeof item.note === "string" && item.note.trim() ? item.note.trim() : undefined,
    });
  }
  const items = READINESS_TOPICS.map((topic) => byTopic.get(topic) ?? { topic, status: "unknown" as const, note: "not assessed" });
  const resolved = items.filter((item) => item.status !== "unknown").length;
  return { items, score: items.length ? resolved / items.length : 0 };
}

export function isReady(r: Readiness): boolean {
  return r.items.every((item) => item.status !== "unknown");
}

export function readinessMarkdown(r: Readiness): string {
  const resolved = r.items.filter((item) => item.status !== "unknown").length;
  const lines = [
    "# Readiness",
    "",
    "| Topic | Status | Note |",
    "|---|---|---|",
    ...r.items.map((item) => `| ${readinessLabel(item.topic)} | ${item.status} | ${item.note ?? ""} |`),
    "",
    `Readiness score: ${resolved}/${r.items.length} (${Math.round(r.score * 100)}%)${isReady(r) ? " — every topic is known or assumed" : ""}.`,
  ];
  return `${lines.join("\n")}\n`;
}
