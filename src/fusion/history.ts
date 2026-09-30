/**
 * Fusion task history: what the main agent asked for and what the sidekick did
 * about it, for the current session's active branch.
 *
 * Two sources are merged chronologically:
 *   1. Archived snapshots — engine.ts appends one immutable record per
 *      delegation as a `fusion-task-history` custom entry (stored entries are
 *      excluded from the LLM context and have no renderer by default). The
 *      latest snapshot per stable delegation id wins.
 *   2. The raw session branch — each real user message is a main task (full
 *      request, assistant text/model and tool activity collected until the
 *      next user message, pre-compaction originals included), plus best-effort
 *      legacy sidekick records rebuilt from the real pi shapes: assistant
 *      sidekick toolCalls paired with their toolResults (verdict included),
 *      background launches ("Started background delegation D<n>"), delivery
 *      messages (custom_message / custom `fusion-result`) and sidekick_wait
 *      toolResults.
 *
 * Nothing here truncates task or result text, and nothing here may be sent
 * back into a model context. Main tasks omit provider thinking blocks;
 * sidekick records retain the existing bounded trace. Legacy `previewOnly`
 * records flag text that was capped for the main context — the cut portion
 * was never stored and is not pretend-recovered.
 */

import type { TraceStep } from "../shared/trace.js";

/** Custom entry type used to persist task-history snapshots. */
export const TASK_HISTORY_ENTRY = "fusion-task-history";
/** Bump when TaskHistoryRecord changes shape; older snapshots are then ignored. */
export const TASK_HISTORY_SCHEMA_VERSION = 1;
/** Id prefixes: main tasks M<n> (from the user entry id), delegations D<n>. */
export const MAIN_ID_PREFIX = "M";
export const DELEGATION_ID_PREFIX = "D";

/** The slice of pi's session manager the history needs. */
export interface TaskHistorySessionManager {
  getBranch?: () => any[];
  getEntries?: () => any[];
}

export type TaskAgent = "main" | "sidekick";
export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted";

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled" || status === "interrupted";
}

/** Harness evidence captured with a finished delegation (counts only; no output dumps). */
export interface TaskCheckEvidence {
  checksRun?: number;
  checksFailed?: number;
  acceptanceMet?: number;
  acceptanceTotal?: number;
  verdict?: string;
}

export interface TaskHistoryRecord {
  schema: number;
  /** Main tasks: `M` + the user entry id. Delegations: `D<seq>` (or legacy ids). */
  id: string;
  agent: TaskAgent;
  /** The full request (main) or brief (sidekick), never truncated. */
  task: string;
  status: TaskStatus;
  startedAt: number;
  /** Set only for terminal items. */
  endedAt?: number;
  /** Model key for the assistant reply (main) or the sidekick run. */
  model?: string;
  meta?: string;
  /** Full result text (sidekick) or the assistant's reply text (main), uncapped. */
  result?: string;
  /** Full error text for failed/cancelled delegations. */
  error?: string;
  /** Original brief inputs, kept so the archive is self-contained. */
  context?: string;
  files?: string[];
  acceptance?: string[];
  verify?: string[];
  /** Extension tool-call id of the sidekick call, for legacy dedupe. */
  toolCallId?: string;
  background?: boolean;
  /** Tool activity lines for main tasks (name + brief input). */
  activity?: string[];
  /** Harness evidence (checks/acceptance tallies and verdict). */
  evidence?: TaskCheckEvidence;
  /** The delegation trace, in the existing bounded format. */
  trace?: TraceStep[];
  /** True for best-effort records recovered from the raw branch. */
  legacy?: boolean;
  /**
   * True when the archived text is a legacy capped preview (possibly with a
   * "full result: <path>" pointer); the cut portion was never recovered.
   */
  previewOnly?: boolean;
}

const STATUSES: readonly TaskStatus[] = ["queued", "running", "done", "failed", "cancelled", "interrupted"];

function takeString(raw: Record<string, any>, key: string): string | undefined {
  return typeof raw[key] === "string" ? raw[key] : undefined;
}

function takeStringArray(raw: Record<string, any>, key: string): string[] | undefined {
  const value = raw[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : undefined;
}

/** Validate an unknown snapshot; returns undefined for anything not current-schema. */
export function parseTaskHistoryRecord(data: unknown): TaskHistoryRecord | undefined {
  if (!data || typeof data !== "object") return undefined;
  const raw = data as Record<string, any>;
  if (raw.schema !== TASK_HISTORY_SCHEMA_VERSION) return undefined;
  if (typeof raw.id !== "string" || !raw.id) return undefined;
  if (raw.agent !== "main" && raw.agent !== "sidekick") return undefined;
  if (!STATUSES.includes(raw.status)) return undefined;
  if (typeof raw.task !== "string") return undefined;
  if (!Number.isFinite(raw.startedAt)) return undefined;
  const record: TaskHistoryRecord = {
    schema: raw.schema as number,
    id: raw.id,
    agent: raw.agent,
    task: raw.task,
    status: raw.status,
    startedAt: raw.startedAt,
  };
  if (Number.isFinite(raw.endedAt)) record.endedAt = raw.endedAt;
  for (const key of ["model", "meta", "result", "error", "context", "toolCallId"] as const) {
    const value = takeString(raw, key);
    if (value !== undefined) record[key] = value;
  }
  for (const key of ["files", "acceptance", "verify", "activity"] as const) {
    const value = takeStringArray(raw, key);
    if (value !== undefined) record[key] = value;
  }
  if (typeof raw.background === "boolean") record.background = raw.background;
  if (typeof raw.legacy === "boolean") record.legacy = raw.legacy;
  if (typeof raw.previewOnly === "boolean") record.previewOnly = raw.previewOnly;
  if (raw.evidence && typeof raw.evidence === "object") record.evidence = { ...raw.evidence };
  if (Array.isArray(raw.trace)) record.trace = [...raw.trace];
  return record;
}

// ---------------------------------------------------------------------------
// Collector: pure functions over the raw session branch
// ---------------------------------------------------------------------------

/** Plain text of a user request; image-only requests get a placeholder. */
export function userRequestText(content: unknown): string {
  if (typeof content === "string") return content.trim() ? content : "";
  if (Array.isArray(content)) {
    const texts = content
      .filter((block: any) => block?.type === "text")
      .map((block: any) => String(block?.text ?? ""))
      .filter((text: string) => text.trim().length > 0);
    if (texts.length) return texts.join("\n");
    if (content.some((block: any) => block?.type === "image")) return "[image-only request]";
  }
  return "";
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: any) => block?.type === "text")
      .map((block: any) => String(block?.text ?? ""))
      .join("\n");
  }
  return "";
}

function entryTimestamp(entry: any): number {
  const raw = entry?.timestamp ?? entry?.message?.timestamp;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** The model that actually produced an assistant message (provider + model). */
function assistantModel(message: any): string | undefined {
  if (typeof message?.provider === "string" && typeof message?.model === "string") {
    return `${message.provider}/${message.model}`;
  }
  const info = message?.modelInfo;
  if (info && (info.id || info.modelId)) return `${info.provider ?? ""}/${info.id ?? info.modelId}`;
  if (typeof message?.model === "string") return message.model;
  return undefined;
}

function toolActivityLine(message: any): string {
  const name = String(message?.toolName ?? message?.name ?? "tool");
  const text = blockText(message?.content ?? message?.output).replace(/\s+/g, " ").trim();
  // Brief per-call line; the full tool output stays in the session transcript.
  return `${name}: ${text.length > 160 ? `${text.slice(0, 160)}…` : text || "(no output)"}`;
}

/**
 * Main tasks: one per real user message on the branch, classified by the final
 * assistant reply of the span: stop (or text without tool calls) => done,
 * toolUse / no answer => running while trailing, interrupted once a later user
 * message supersedes it, aborted => cancelled, error => failed. Recovery
 * responses after an error stay in the same task. Pre-compaction originals
 * remain on the branch, so they are included. Custom entries are never tasks,
 * and provider thinking blocks are never copied.
 */
export function collectMainTasks(branch: any[]): TaskHistoryRecord[] {
  const items: TaskHistoryRecord[] = [];
  let current: TaskHistoryRecord | undefined;
  let result: string[] = [];
  let activity: string[] = [];
  let model: string | undefined;
  let lastAssistantAt: number | undefined;
  let lastStop: { stopReason?: string; hasText: boolean; hasToolCalls: boolean; errorMessage?: string } | undefined;
  let fallbackSeq = 0;

  const reset = (): void => {
    current = undefined;
    result = [];
    activity = [];
    model = undefined;
    lastAssistantAt = undefined;
    lastStop = undefined;
  };

  const close = (fallbackAt: number, trailing: boolean): void => {
    if (!current) return;
    const stop = lastStop;
    let status: TaskStatus;
    let error: string | undefined;
    if (stop?.stopReason === "aborted") {
      status = "cancelled";
      error = stop.errorMessage ?? "aborted";
    } else if (stop?.stopReason === "error") {
      status = "failed";
      error = stop.errorMessage ?? "assistant error";
    } else if (stop?.stopReason === "length") {
      status = "interrupted";
    } else if (!stop || stop.hasToolCalls || ["toolUse", "pending", "deferred"].includes(stop.stopReason ?? "") || (!stop.hasText && stop.stopReason !== "stop")) {
      // Commentary accompanying a tool call is not a completed answer.
      status = trailing ? "running" : "interrupted";
    } else {
      status = "done";
    }
    const terminal = status !== "running";
    items.push({
      ...current,
      status,
      ...(terminal ? { endedAt: lastAssistantAt ?? fallbackAt } : {}),
      model: model ?? current.model,
      result: result.length ? result.join("\n\n") : undefined,
      error,
      meta: activity.length ? `${activity.length} tool call${activity.length === 1 ? "" : "s"}` : current.meta,
      activity: activity.length ? [...activity] : undefined,
    });
    reset();
  };

  for (const entry of branch ?? []) {
    if (!entry || entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    const at = entryTimestamp(entry);
    if (message.role === "user") {
      if (message.isCompaction) continue; // compaction context, not a request
      const text = userRequestText(message.content);
      if (!text) continue;
      close(at, false); // the previous task ended earlier; a reply-less task was superseded
      fallbackSeq += 1;
      current = {
        schema: TASK_HISTORY_SCHEMA_VERSION,
        id: `${MAIN_ID_PREFIX}${entry.id ?? fallbackSeq}`,
        agent: "main",
        task: text,
        status: "running",
        startedAt: at,
      };
      continue;
    }
    if (!current) continue;
    if (message.role === "assistant") {
      const text = blockText(message.content);
      if (text.trim()) result.push(text);
      model = assistantModel(message) ?? model;
      lastAssistantAt = at;
      const content = Array.isArray(message.content) ? message.content : [];
      lastStop = {
        stopReason: message.stopReason,
        hasText: Boolean(text.trim()),
        hasToolCalls: content.some((block: any) => block?.type === "toolCall" || block?.type === "tool_use"),
        errorMessage: message.errorMessage,
      };
      continue;
    }
    if (message.role === "toolResult" || message.role === "tool") {
      activity.push(toolActivityLine(message));
    }
  }
  // Branch end: classify the trailing span (running / done / cancelled / failed).
  const branchEnd = (branch ?? []).length ? entryTimestamp((branch ?? []).at(-1)) : Date.now();
  close(branchEnd, true);
  return items;
}

/** Archived snapshots on the branch, in append order (latest per id wins later). */
export function snapshotsFromBranch(branch: any[]): TaskHistoryRecord[] {
  const out: TaskHistoryRecord[] = [];
  for (const entry of branch ?? []) {
    if (!entry || entry.type !== "custom" || entry.customType !== TASK_HISTORY_ENTRY) continue;
    const parsed = parseTaskHistoryRecord(entry.data);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Normalise delivered background ids: "D2", "2", or "D1, D2" lists. */
function deliveredIds(raw: unknown): string[] {
  return String(raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? `D${part}` : part))
    .filter((id) => /^D\d+$/.test(id));
}

/** Split the harness's per-D sections, without assigning another task's output. */
function backgroundResultSections(text: string, ids: string[]): Map<string, string> {
  const headers = [...text.matchAll(/^(D\d+)(?:[ \t]+FAILED:|[ \t]+\([^\n]*\)(?::|[ \t]+—)|:)[^\n]*/gm)]
    .filter((match) => ids.includes(match[1]));
  const sections = new Map<string, string>();
  for (const [index, header] of headers.entries()) {
    const end = headers[index + 1]?.index ?? text.length;
    sections.set(header[1], text.slice(header.index, end).trimEnd());
  }
  if (!headers.length && ids.length === 1 && text) sections.set(ids[0], text);
  return sections;
}

function failedResult(text: string): boolean {
  return /^D\d+[ \t]+FAILED:/.test(text) || /(?:^|\n)\[fusion\] verdict:\s*FAILED\b/.test(text);
}

/**
 * Best-effort records for sidekick delegations from before archiving existed,
 * built from the real pi structures:
 *   - assistant sidekick toolCall + toolResult (details carry verdict/model/
 *     meta/trace; a FAILED harness verdict is failed even when isError is false);
 *   - background launches: the launch toolResult carries details.background/id
 *     (or the "Started background delegation D<n>" text) and yields one D-id
 *     record — never a separate done L-record;
 *   - sidekick_wait toolResults (details.ids) and delivered `fusion-result`
 *     messages (custom_message with content+details, or the older custom
 *     entry shape) update that same record; deliveries are deduped by id;
 *   - non-delegation ids ("review" reminders) are ignored.
 */
export function collectLegacyDelegations(branch: any[]): TaskHistoryRecord[] {
  const items = new Map<string, TaskHistoryRecord>();
  const toolResults = new Map<string, any>();

  for (const entry of branch ?? []) {
    if (!entry || entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role !== "toolResult" && message.role !== "tool") continue;
    const id = message.toolCallId ?? message.tool_call_id;
    if (id) toolResults.set(String(id), message);
  }

  const briefInputs = (args: Record<string, any>) => ({
    context: typeof args?.context === "string" ? args.context : undefined,
    files: Array.isArray(args?.files) ? args.files.map(String) : undefined,
    acceptance: Array.isArray(args?.acceptance) ? args.acceptance.map(String) : undefined,
    verify: Array.isArray(args?.verify) ? args.verify.map(String) : undefined,
  });

  for (const entry of branch ?? []) {
    if (!entry || entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type !== "toolCall" && block?.type !== "tool_use") continue;
      const name = String(block?.name ?? "");
      const toolCallId = String(block?.id ?? "");
      const args = (block?.arguments ?? block?.input ?? {}) as Record<string, any>;
      const result = toolCallId ? toolResults.get(toolCallId) : undefined;

      if (name === "sidekick") {
        const details = (result?.details ?? {}) as Record<string, any>;
        const text = blockText(result?.content);
        // A background launch: one D-id record, updated later by the delivery.
        const launchId = deliveredIds(details?.background ? details?.id : undefined)[0] ?? text.match(/Started background delegation (D\d+)/)?.[1];
        if (launchId) {
          const existing = items.get(launchId);
          const record: TaskHistoryRecord = existing ?? {
            schema: TASK_HISTORY_SCHEMA_VERSION,
            id: launchId,
            agent: "sidekick",
            task: String(args?.task ?? "(unknown task)"),
            status: "running",
            startedAt: entryTimestamp(entry),
            background: true,
            toolCallId: toolCallId || undefined,
            legacy: true,
            ...briefInputs(args),
          };
          if (details.model) record.model = String(details.model);
          if (details.meta) record.meta = String(details.meta);
          items.set(launchId, record);
          continue;
        }
        const failed = result ? result.isError === true || details?.verdict === "failed" || failedResult(text) : false;
        const id = `L-${toolCallId || `call-${items.size + 1}`}`;
        items.set(id, {
          schema: TASK_HISTORY_SCHEMA_VERSION,
          id,
          agent: "sidekick",
          task: String(args?.task ?? "(unknown task)"),
          status: !result ? "interrupted" : failed ? "failed" : "done",
          startedAt: entryTimestamp(entry),
          model: details?.model ? String(details.model) : undefined,
          meta: details?.meta ? String(details.meta) : undefined,
          result: failed || !result ? undefined : text || undefined,
          error: failed ? text || "delegation failed" : undefined,
          evidence: details?.verdict ? { verdict: String(details.verdict) } : undefined,
          trace: Array.isArray(details?.trace) ? details.trace : undefined,
          toolCallId: toolCallId || undefined,
          legacy: true,
          previewOnly: !result || result.isError === true || /\[fusion\] result cut/.test(text),
          ...briefInputs(args),
        });
        continue;
      }

      if (name === "sidekick_wait" && result) {
        const ids = deliveredIds(result.details?.ids);
        const sections = backgroundResultSections(blockText(result.content), ids);
        for (const id of ids) {
          const text = sections.get(id);
          const existing = items.get(id);
          const record: TaskHistoryRecord = existing ?? {
            schema: TASK_HISTORY_SCHEMA_VERSION, id, agent: "sidekick",
            task: "(unknown task)", status: "done", startedAt: entryTimestamp(entry), legacy: true,
          };
          const failed = text !== undefined && failedResult(text);
          record.status = failed ? "failed" : record.status === "failed" || record.status === "cancelled" ? record.status : "done";
          record.endedAt = result.timestamp ?? entryTimestamp(entry);
          if (text) record.result = text;
          if (failed) record.error = "Delegation failed (see result).";
          record.previewOnly = !text || /\[fusion\] result cut/.test(text);
          items.set(id, record);
        }
      }
    }
  }

  // Delivered background results: custom_message (real pi) and the older
  // custom-entry shape. Only the first delivery per id counts (duplicates are
  // ignored); later deliveries must not downgrade an already-archived result.
  const delivered = new Set<string>();
  for (const entry of branch ?? []) {
    const source = entry?.type === "message" ? entry.message : entry;
    const isMessage = (source?.type === "custom_message" || source?.role === "custom") && source?.customType === "fusion-result";
    const isCustom = entry?.type === "custom" && entry?.customType === "fusion-result";
    if (!isMessage && !isCustom) continue;
    const details = ((isMessage ? source.details : entry.data?.details) ?? {}) as Record<string, any>;
    const text = blockText(isMessage ? source.content : entry.data?.content);
    const ids = deliveredIds(details.id);
    const sections = backgroundResultSections(text, ids);
    for (const id of ids) {
      if (delivered.has(id)) continue;
      delivered.add(id);
      const body = sections.get(id);
      const isError = (ids.length === 1 && details.isError === true) || (body !== undefined && failedResult(body));
      const record: TaskHistoryRecord = items.get(id) ?? {
        schema: TASK_HISTORY_SCHEMA_VERSION, id, agent: "sidekick", legacy: true,
        task: String(details.task ?? "(unknown task)"), status: "done", startedAt: entryTimestamp(entry),
      };
      record.status = isError ? "failed" : "done";
      record.endedAt = entryTimestamp(entry);
      if (details.task && record.task === "(unknown task)") record.task = String(details.task);
      if (body) record.result = body;
      if (isError) record.error = body || record.error || "delegation failed";
      if (Array.isArray(details.trace)) record.trace = details.trace;
      if (details.meta) record.meta = String(details.meta);
      record.previewOnly = !body || /\[fusion\] result cut/.test(body);
      items.set(id, record);
    }
  }

  return [...items.values()];
}

/**
 * The full task history for a branch: archived snapshots (latest per id wins),
 * merged with legacy fallbacks (skipped when a snapshot covers the same
 * delegation via id or toolCallId) and the main tasks, chronologically.
 */
export function collectTaskHistory(branch: any[], snapshots: TaskHistoryRecord[] = snapshotsFromBranch(branch)): TaskHistoryRecord[] {
  const byId = new Map<string, TaskHistoryRecord>();
  const byToolCall = new Map<string, TaskHistoryRecord>();
  for (const snapshot of snapshots) {
    byId.set(snapshot.id, snapshot);
    if (snapshot.toolCallId) byToolCall.set(snapshot.toolCallId, snapshot);
  }
  for (const legacy of collectLegacyDelegations(branch)) {
    if (legacy.toolCallId && byToolCall.has(legacy.toolCallId)) continue;
    if (byId.has(legacy.id)) continue;
    byId.set(legacy.id, legacy);
  }
  for (const main of collectMainTasks(branch)) {
    if (!byId.has(main.id)) byId.set(main.id, main);
  }
  return [...byId.values()].sort(
    (a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id, "en", { numeric: true }),
  );
}
