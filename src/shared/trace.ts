/**
 * Bounded, structured traces of an agent run: thinking blocks, tool calls with
 * output excerpts, and errors. Used for Fusion sidekick delegations and factory
 * worker runs, rendered on demand (collapsed by default).
 */

import type { Usage } from "@earendil-works/pi-ai";
import { excerpt, truncate } from "./text.js";
import { formatCost, formatTokens } from "./usage.js";

export const TRACE_STEP_LIMIT = 80;
export const TRACE_THINKING_CHARS = 2000;
export const TRACE_OUTPUT_CHARS = 1200;
export const TRACE_OUTPUT_LINES = 12;

/** One step of a trace: thinking, a tool call, or an error. */
export interface TraceStep {
  kind: "thinking" | "tool" | "error";
  title: string;
  detail?: string;
  /** Tool result excerpt (tool steps only). */
  output?: string;
  isError?: boolean;
}

export interface DelegationTrace {
  at: number;
  task: string;
  model?: string;
  meta: string;
  isError: boolean;
  steps: TraceStep[];
}

export function describeActivity(toolName: string, args: Record<string, unknown>): string {
  const target = (args.file_path ?? args.path ?? "") as string;
  switch (toolName) {
    case "bash":
    case "powershell":
      return `$ ${truncate(String(args.command ?? ""), 70)}`;
    case "read":
      return `read ${truncate(target, 60)}`;
    case "grep":
      return `grep /${truncate(String(args.pattern ?? ""), 30)}/`;
    case "edit":
      return `edit ${truncate(target, 60)}`;
    case "write":
      return `write ${truncate(target, 60)}`;
    case "find":
      return `find ${truncate(String(args.pattern ?? ""), 40)}`;
    case "ls":
      return `ls ${truncate(String(args.path ?? "."), 50)}`;
    case "web_search":
      return `search ${truncate(String(args.query ?? (Array.isArray(args.queries) ? args.queries.join(" | ") : "")), 60)}`;
    case "fetch_content":
      return `fetch ${truncate(String(args.url ?? (Array.isArray(args.urls) ? args.urls.join(" ") : "")), 60)}`;
    default:
      return `${toolName} ${truncate(JSON.stringify(args), 50)}`;
  }
}

export function extractFinalText(messages: Array<{ role: string; content?: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const texts: string[] = [];
    for (const part of message.content) {
      if (part && typeof part === "object" && (part as any).type === "text") {
        texts.push(String((part as any).text ?? ""));
      }
    }
    const joined = texts.join("\n").trim();
    if (joined) return joined;
  }
  return "";
}

/** Compact `model · turns · tokens · cost` line shared by results and traces. */
export function delegationMeta(outcome: { model?: string; turns: number; usage: Usage }): string {
  return (
    `${outcome.model ?? "agent"} · ${outcome.turns} turn${outcome.turns === 1 ? "" : "s"} · ` +
    `${formatTokens(outcome.usage.totalTokens)} tok · ${formatCost(outcome.usage.cost.total)}`
  );
}

/** Build a trace from a transcript slice (assistant and toolResult messages). */
export function buildTrace(messages: Array<Record<string, any>>): TraceStep[] {
  const steps: TraceStep[] = [];
  const byCallId = new Map<string, TraceStep>();
  let turn = 0;
  for (const message of messages) {
    if (message?.role === "assistant") {
      turn += 1;
      for (const part of message.content ?? []) {
        if (part?.type === "thinking") {
          const text = part.redacted
            ? "(redacted by the provider)"
            : truncate(String(part.thinking ?? ""), TRACE_THINKING_CHARS);
          if (text) steps.push({ kind: "thinking", title: `turn ${turn} thinking`, detail: text });
        } else if (part?.type === "toolCall") {
          const name = String(part.name ?? "tool");
          const step: TraceStep = {
            kind: "tool",
            title: name,
            detail: describeActivity(name, (part.arguments ?? {}) as Record<string, unknown>),
          };
          steps.push(step);
          if (part.id) byCallId.set(String(part.id), step);
        }
      }
      if (message.stopReason === "error" || message.stopReason === "aborted" || message.errorMessage) {
        steps.push({
          kind: "error",
          title: `turn ${turn} ${message.stopReason ?? "error"}`,
          detail: message.errorMessage ?? "stopped early",
          isError: true,
        });
      }
    } else if (message?.role === "toolResult") {
      const step = message.toolCallId ? byCallId.get(String(message.toolCallId)) : undefined;
      if (!step) continue;
      const text = (Array.isArray(message.content) ? message.content : [])
        .map((part: any) => (part?.type === "text" ? String(part.text ?? "") : `[${part?.type}]`))
        .join("\n");
      const output = excerpt(text, TRACE_OUTPUT_CHARS, TRACE_OUTPUT_LINES);
      if (output) step.output = output;
      step.isError = Boolean(message.isError);
    }
  }
  return steps.length > TRACE_STEP_LIMIT ? steps.slice(-TRACE_STEP_LIMIT) : steps;
}

/** Trace lines for expanded tool rows and trace entries. */
export function renderTraceSteps(steps: TraceStep[], theme: any): string[] {
  const lines: string[] = [];
  for (const step of steps) {
    if (step.kind === "thinking") {
      lines.push(`${theme.fg("dim", "⋯")} ${theme.fg("dim", step.title)}`);
      if (step.detail) lines.push(theme.fg("dim", `  ${step.detail}`));
    } else if (step.kind === "error") {
      lines.push(theme.fg("error", `✗ ${step.title}${step.detail ? ` — ${truncate(step.detail, 200)}` : ""}`));
    } else {
      const marker = step.isError ? theme.fg("error", "✗") : theme.fg("accent", "•");
      lines.push(`${marker} ${theme.fg("toolTitle", step.title)} ${theme.fg("muted", step.detail ?? "")}`);
      if (step.output) {
        for (const line of step.output.split("\n")) lines.push(theme.fg("toolOutput", `  ${line}`));
      }
    }
  }
  return lines;
}
