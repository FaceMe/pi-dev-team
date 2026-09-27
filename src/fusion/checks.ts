/**
 * Harness-side evidence for delegations.
 *
 * A sidekick's "tests pass" is a claim from a cheaper model. The main agent
 * owns verification, so the harness gives it evidence the sidekick cannot
 * shape:
 *
 *   checks      — commands the main agent names in `verify`; the harness runs
 *                 them itself after the sidekick finishes and reports the real
 *                 exit code, duration and output tail.
 *   acceptance  — criteria the main agent names in `acceptance`; the sidekick
 *                 must answer each one, and the harness tallies the answers
 *                 (a self-report, so it is labelled as such).
 *   changes     — what the sidekick actually changed, from git.
 */

import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { truncate } from "../shared/text.js";
import { neverExits } from "./policy.js";

export interface CheckResult {
  command: string;
  /** Process exit code; null when it was killed or refused. */
  exitCode: number | null;
  durationMs: number;
  passed: boolean;
  timedOut: boolean;
  /** Why the harness would not run it (e.g. it never exits). */
  refused?: string;
  /** The last lines of combined stdout/stderr. */
  tail: string;
  /** Full output, when it was longer than the tail. */
  logPath?: string;
}

export const MAX_CHECKS = 5;
const TAIL_LINES_FAILED = 40;
const TAIL_LINES_PASSED = 4;
const TAIL_CHARS = 3000;
const MAX_BUFFER = 2_000_000;

function lastLines(text: string, lines: number): string {
  const all = text.replace(/\s+$/, "").split("\n");
  const tail = all.slice(-lines).join("\n");
  return tail.length > TAIL_CHARS ? `…${tail.slice(-TAIL_CHARS)}` : tail;
}

/** Run one check command in `cwd` with a timeout. Never throws. */
export function runCheck(command: string, cwd: string, timeoutSec: number, signal?: AbortSignal): Promise<CheckResult> {
  const refused = neverExits(command);
  if (refused) {
    return Promise.resolve({ command, exitCode: null, durationMs: 0, passed: false, timedOut: false, refused, tail: "" });
  }
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let timedOut = false;
    let settled = false;
    const posix = process.platform !== "win32";
    const child = spawn(command, { cwd, shell: true, detached: posix, stdio: ["ignore", "pipe", "pipe"] });
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > MAX_BUFFER) output = output.slice(-MAX_BUFFER);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const kill = () => {
      try {
        if (posix && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const timer = timeoutSec > 0 ? setTimeout(() => ((timedOut = true), kill()), timeoutSec * 1000) : undefined;
    timer?.unref?.();
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const passed = exitCode === 0 && !timedOut;
      const tail = lastLines(output, passed ? TAIL_LINES_PASSED : TAIL_LINES_FAILED);
      let logPath: string | undefined;
      if (output.trim() && tail.length < output.trim().length) {
        try {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-check-"));
          logPath = path.join(dir, "output.log");
          fs.writeFileSync(logPath, output);
        } catch {
          logPath = undefined;
        }
      }
      resolve({ command, exitCode, durationMs: Date.now() - started, passed, timedOut, tail, logPath });
    };
    child.on("error", (error) => {
      output += `\n${error.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    if (signal?.aborted) kill();
  });
}

/** Run checks one after another (they often share build output). */
export async function runChecks(commands: string[], cwd: string, timeoutSec: number, signal?: AbortSignal): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const command of commands.map((c) => c.trim()).filter(Boolean).slice(0, MAX_CHECKS)) {
    if (signal?.aborted) break;
    results.push(await runCheck(command, cwd, timeoutSec, signal));
  }
  return results;
}

function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

export function formatChecks(results: CheckResult[]): string {
  if (results.length === 0) return "";
  const lines = ["## Harness checks (run by Fusion after the sidekick finished — not the sidekick's claim)"];
  for (const r of results) {
    const status = r.refused
      ? "refused"
      : r.timedOut
        ? `timed out after ${seconds(r.durationMs)}`
        : `exit ${r.exitCode ?? "?"} · ${seconds(r.durationMs)}`;
    lines.push(`${r.passed ? "✓" : "✗"} \`${r.command}\` — ${status}${r.logPath ? ` (full log: ${r.logPath})` : ""}`);
    if (r.refused) lines.push(`    ${r.refused}`);
    else if (r.tail) lines.push(...r.tail.split("\n").map((line) => `    ${line}`));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Acceptance criteria
// ---------------------------------------------------------------------------

export type CriterionState = "met" | "unmet" | "unreported";

export interface AcceptanceReport {
  criteria: Array<{ index: number; text: string; state: CriterionState; note?: string }>;
  met: number;
  total: number;
}

/** The checklist the sidekick is asked to end its report with. */
export function acceptanceInstructions(criteria: string[]): string {
  return [
    criteria.map((c, i) => `${i + 1}. ${c.trim()}`).join("\n"),
    "",
    "End your report with this checklist, one line per criterion, in this exact form:",
    "## Acceptance",
    "- [x] 1 — <the evidence that shows it is met: command output, file:line>",
    "- [ ] 2 — <why it is not met>",
    "Tick a box only when you checked it yourself.",
  ].join("\n");
}

const CHECK_LINE = /^\s*(?:[-*+]\s*)?\[([ xX✓✔✗✘-])\]\s*#?(\d+)\b[.):]?\s*(?:[—–:-]\s*)?(.*)$/;

/** Tally the sidekick's checklist against the criteria. The last answer per criterion wins. */
export function parseAcceptance(text: string, criteria: string[]): AcceptanceReport {
  const answers = new Map<number, { met: boolean; note: string }>();
  const section = text.lastIndexOf("## Acceptance");
  const body = section >= 0 ? text.slice(section) : text;
  for (const line of body.split("\n")) {
    const match = line.match(CHECK_LINE);
    if (!match) continue;
    const index = Number(match[2]);
    if (index < 1 || index > criteria.length) continue;
    answers.set(index, { met: /[xX✓✔]/.test(match[1]), note: match[3].trim() });
  }
  const list = criteria.map((text, i) => {
    const answer = answers.get(i + 1);
    const state: CriterionState = !answer ? "unreported" : answer.met ? "met" : "unmet";
    return { index: i + 1, text: text.trim(), state, note: answer?.note || undefined };
  });
  return { criteria: list, met: list.filter((c) => c.state === "met").length, total: list.length };
}

export function formatAcceptance(report: AcceptanceReport): string {
  if (report.total === 0) return "";
  const mark: Record<CriterionState, string> = { met: "✓", unmet: "✗", unreported: "?" };
  return [
    `## Acceptance (sidekick's self-report: ${report.met}/${report.total} met — confirm against the evidence)`,
    ...report.criteria.map(
      (c) => `${mark[c.state]} ${c.index}. ${truncate(c.text, 120)}${c.state === "unreported" ? " — not answered" : c.note ? ` — ${truncate(c.note, 160)}` : ""}`,
    ),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// What the sidekick changed
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? undefined : String(stdout)));
  });
}

export interface FileChange {
  file: string;
  added?: number;
  removed?: number;
  isNew?: boolean;
}

/** Line counts per file from git (paths relative to cwd); files git doesn't track are marked new. */
export async function changeSummary(files: string[], cwd: string): Promise<FileChange[]> {
  const rel = [...new Set(files.map((f) => path.relative(cwd, path.resolve(cwd, f)) || f))].slice(0, 50);
  if (rel.length === 0) return [];
  const numstat = await git(["diff", "--numstat", "HEAD", "--", ...rel], cwd);
  if (numstat === undefined) return rel.map((file) => ({ file }));
  const counts = new Map<string, { added?: number; removed?: number }>();
  for (const line of numstat.split("\n")) {
    const [a, r, file] = line.split("\t");
    if (file) counts.set(file, { added: Number(a) || 0, removed: Number(r) || 0 });
  }
  const untracked = new Set(
    ((await git(["ls-files", "--others", "--exclude-standard", "--", ...rel], cwd)) ?? "").split("\n").filter(Boolean),
  );
  return rel.map((file) => (untracked.has(file) ? { file, isNew: true } : { file, ...counts.get(file) }));
}

export function formatChanges(changes: FileChange[]): string {
  return changes
    .map((c) => (c.isNew ? `${c.file} (new)` : c.added !== undefined ? `${c.file} (+${c.added} −${c.removed})` : c.file))
    .join(", ");
}
