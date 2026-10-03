/**
 * The `.factory/` directory in the target project: durable, resumable state.
 *
 *   .factory/factory.lock.json  the run lock: phase machine, settings snapshot,
 *                               answers, tickets, spend (M1 called this state.json;
 *                               older runs are migrated on first load)
 *   .factory/runs/<runId>.json  archived finished runs
 *   .factory/project.json       the project's quick-setup answers
 *   .factory/brief.md           the user's idea, verbatim
 *   .factory/spec/              spec.md, decisions.md, assumptions.md
 *   .factory/research/          research notes
 *   .factory/adr/               architecture decision records
 *   .factory/profile.json       stack + gate commands
 *   .factory/reviews/           reviewer output per ticket attempt
 *   .factory/qa/                exploratory QA reports per verification round, open-bugs.json
 *   .factory/contributor.md     the new-contributor check (contributor.json: last outcome)
 *   .factory/release-notes.md   delivered, fixed during verification, known issues
 *   .factory/report.md          final report · retro.md: the retrospective
 *   .factory/ledger.jsonl       append-only usage/cost/gate/ticket-event log
 *   .factory/sessions/          worker pi sessions (git-ignored)
 *   .factory/worktrees/         the integration worktree and one per ticket being built (git-ignored)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { appendJsonLine, readJsonFile, writeJsonFile, writeTextFile } from "../shared/json-store.js";
import { normalizeReadiness } from "./readiness.js";
import { PHASE_ORDER } from "./types.js";
import type { FactoryState, Profile, SetupAnswers } from "./types.js";

const LOCK_FILE = "factory.lock.json";
const LEGACY_LOCK_FILE = "state.json";

/**
 * Coerce an unknown parsed file into a FactoryState, repairing what can be
 * repaired. Returns null when the file is not a factory state at all (missing
 * runId/idea) so callers treat it as "no run" rather than crashing.
 */
export function normalizeState(raw: unknown): FactoryState | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, any>;
  if (typeof s.runId !== "string" || typeof s.idea !== "string") return null;
  const phase = PHASE_ORDER.includes(s.phase) ? (s.phase as FactoryState["phase"]) : s.tickets?.length ? "planning" : "discovery";
  const status = ["running", "paused", "waiting", "failed", "done"].includes(s.status) ? s.status : "paused";
  return {
    version: 1,
    runId: s.runId,
    idea: s.idea,
    phase,
    status,
    createdAt: typeof s.createdAt === "string" ? s.createdAt : new Date().toISOString(),
    updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : new Date().toISOString(),
    settings: s.settings && typeof s.settings === "object" ? s.settings : undefined,
    baseBranch: typeof s.baseBranch === "string" ? s.baseBranch : undefined,
    baseCommit: typeof s.baseCommit === "string" ? s.baseCommit : undefined,
    branch: typeof s.branch === "string" ? s.branch : undefined,
    worktree: typeof s.worktree === "string" ? s.worktree : undefined,
    answers: Array.isArray(s.answers) ? s.answers : [],
    interviewRounds: Number.isFinite(s.interviewRounds) ? s.interviewRounds : 0,
    readiness: normalizeReadiness(s.readiness) ?? undefined,
    tickets: Array.isArray(s.tickets) ? s.tickets : [],
    spentUsd: Number.isFinite(s.spentUsd) ? s.spentUsd : 0,
    spentTokens: Number.isFinite(s.spentTokens) ? s.spentTokens : 0,
    budgetUsd: Number.isFinite(s.budgetUsd) ? s.budgetUsd : 0,
    budgetTokens: Number.isFinite(s.budgetTokens) ? s.budgetTokens : 0,
    lastError: typeof s.lastError === "string" ? s.lastError : undefined,
    notes: Array.isArray(s.notes) ? s.notes.filter((n: unknown) => typeof n === "string") : [],
  };
}

export class FactoryStore {
  readonly root: string;

  constructor(readonly projectDir: string) {
    this.root = path.join(projectDir, ".factory");
  }

  path(...parts: string[]): string {
    return path.join(this.root, ...parts);
  }

  exists(): boolean {
    return fs.existsSync(this.path(LOCK_FILE)) || fs.existsSync(this.path(LEGACY_LOCK_FILE));
  }

  ensure(): void {
    fs.mkdirSync(this.root, { recursive: true });
    const ignore = this.path(".gitignore");
    if (!fs.existsSync(ignore)) writeTextFile(ignore, "sessions/\nworktrees/\n*.tmp\n");
  }

  /** The lock, migrating an M1-era `state.json` to `factory.lock.json` on first load. */
  loadState(): FactoryState | null {
    let raw = readJsonFile<unknown>(this.path(LOCK_FILE));
    if (!raw) {
      const legacy = readJsonFile<unknown>(this.path(LEGACY_LOCK_FILE));
      if (!legacy) return null;
      raw = legacy;
    }
    const state = normalizeState(raw);
    if (!state) return null;
    if (!fs.existsSync(this.path(LOCK_FILE))) {
      // First load of a legacy run: persist under the new name, drop the old file.
      this.saveState(state);
      fs.rmSync(this.path(LEGACY_LOCK_FILE), { force: true });
    }
    return state;
  }

  saveState(state: FactoryState): void {
    state.updatedAt = new Date().toISOString();
    writeJsonFile(this.path(LOCK_FILE), state);
  }

  /** Move the current lock to runs/<runId>.json (a finished or abandoned run). */
  archiveState(runId: string): void {
    fs.mkdirSync(this.path("runs"), { recursive: true });
    for (const name of [LOCK_FILE, LEGACY_LOCK_FILE]) {
      const file = this.path(name);
      if (fs.existsSync(file)) {
        fs.rmSync(this.path("runs", `${runId}.json`), { force: true });
        fs.renameSync(file, this.path("runs", `${runId}.json`));
      }
    }
  }

  loadProject(): Partial<SetupAnswers> | null {
    return readJsonFile<Partial<SetupAnswers>>(this.path("project.json"));
  }

  saveProject(answers: SetupAnswers): void {
    writeJsonFile(this.path("project.json"), answers);
  }

  loadProfile(): Profile | null {
    return readJsonFile<Profile>(this.path("profile.json"));
  }

  saveProfile(profile: Profile): void {
    writeJsonFile(this.path("profile.json"), profile);
  }

  read(rel: string): string | undefined {
    try {
      return fs.readFileSync(this.path(rel), "utf8");
    } catch {
      return undefined;
    }
  }

  write(rel: string, text: string): void {
    writeTextFile(this.path(rel), text.endsWith("\n") ? text : `${text}\n`);
  }

  ledger(entry: Record<string, unknown>): void {
    appendJsonLine(this.path("ledger.jsonl"), { at: new Date().toISOString(), ...entry });
  }

  readLedger(): Array<Record<string, any>> {
    const text = this.read("ledger.jsonl") ?? "";
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Array<Record<string, any>>;
  }

  get sessionsDir(): string {
    return this.path("sessions");
  }
}
