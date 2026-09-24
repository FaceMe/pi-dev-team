/**
 * The `.factory/` directory in the target project: durable, resumable state.
 *
 *   .factory/state.json      phase machine, answers, tickets, spend
 *   .factory/project.json    the project's quick-setup answers
 *   .factory/brief.md        the user's idea, verbatim
 *   .factory/spec/           spec.md, decisions.md, assumptions.md
 *   .factory/research/       research notes
 *   .factory/adr/            architecture decision records
 *   .factory/profile.json    stack + gate commands
 *   .factory/reviews/        reviewer output per ticket attempt
 *   .factory/ledger.jsonl    append-only usage/cost/gate log
 *   .factory/sessions/       worker pi sessions (git-ignored)
 *   .factory/worktrees/      the build worktree (git-ignored)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { appendJsonLine, readJsonFile, writeJsonFile, writeTextFile } from "../shared/json-store.js";
import type { FactoryState, Profile, SetupAnswers } from "./types.js";

export class FactoryStore {
  readonly root: string;

  constructor(readonly projectDir: string) {
    this.root = path.join(projectDir, ".factory");
  }

  path(...parts: string[]): string {
    return path.join(this.root, ...parts);
  }

  exists(): boolean {
    return fs.existsSync(this.path("state.json"));
  }

  ensure(): void {
    fs.mkdirSync(this.root, { recursive: true });
    const ignore = this.path(".gitignore");
    if (!fs.existsSync(ignore)) writeTextFile(ignore, "sessions/\nworktrees/\n*.tmp\n");
  }

  loadState(): FactoryState | null {
    return readJsonFile<FactoryState>(this.path("state.json"));
  }

  saveState(state: FactoryState): void {
    state.updatedAt = new Date().toISOString();
    writeJsonFile(this.path("state.json"), state);
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
