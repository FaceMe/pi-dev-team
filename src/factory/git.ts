/** Thin git helpers (execFile, no shell). The factory owns all git operations. */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

export function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as any).code === "number" ? (error as any).code : 1) : 0;
      resolve({ ok: !error, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code });
    });
  });
}

/** Identity flags so commits work even when the user has no git identity configured. */
async function identityArgs(cwd: string): Promise<string[]> {
  const name = await git(cwd, ["config", "user.name"]);
  const email = await git(cwd, ["config", "user.email"]);
  const args: string[] = [];
  if (!name.stdout.trim()) args.push("-c", "user.name=pi factory");
  if (!email.stdout.trim()) args.push("-c", "user.email=factory@localhost");
  return args;
}

export async function isRepo(cwd: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).stdout.trim() === "true";
}

export async function gitAvailable(): Promise<boolean> {
  return (await git(process.cwd(), ["--version"])).ok;
}

/** Ensure cwd is a git repo with at least one commit (worktrees need a HEAD). */
export async function ensureRepo(cwd: string): Promise<{ created: boolean; error?: string }> {
  let created = false;
  if (!(await isRepo(cwd))) {
    const init = await git(cwd, ["init"]);
    if (!init.ok) return { created, error: init.stderr.trim() || "git init failed" };
    created = true;
  }
  const head = await git(cwd, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) {
    const id = await identityArgs(cwd);
    const commit = await git(cwd, [...id, "commit", "--allow-empty", "-m", "chore: initial commit"]);
    if (!commit.ok) return { created, error: commit.stderr.trim() || "initial commit failed" };
  }
  return { created };
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
  const res = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const name = res.stdout.trim();
  return res.ok && name && name !== "HEAD" ? name : undefined;
}

export async function headCommit(cwd: string): Promise<string | undefined> {
  const res = await git(cwd, ["rev-parse", "HEAD"]);
  return res.ok ? res.stdout.trim() : undefined;
}

export async function isClean(cwd: string): Promise<boolean> {
  const res = await git(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
  // .factory/ is the factory's own state; it doesn't make the tree "dirty" for merging.
  const lines = res.stdout.split("\n").filter((line) => line.trim() && !line.slice(3).startsWith(".factory"));
  return res.ok && lines.length === 0;
}

/** Create (or reuse) the build worktree on its own branch from the base commit. */
export async function ensureWorktree(repo: string, worktree: string, branch: string, base: string): Promise<{ error?: string }> {
  if (fs.existsSync(path.join(worktree, ".git"))) return {};
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const exists = (await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`])).ok;
  const args = exists ? ["worktree", "add", worktree, branch] : ["worktree", "add", "-b", branch, worktree, base];
  const res = await git(repo, args);
  return res.ok ? {} : { error: res.stderr.trim() || "git worktree add failed" };
}

/** Files changed (tracked and untracked) relative to HEAD, as repo-relative POSIX paths. */
export async function changedFiles(cwd: string): Promise<string[]> {
  const res = await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  return res.stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const file = line.slice(3);
      const arrow = file.indexOf(" -> ");
      return (arrow >= 0 ? file.slice(arrow + 4) : file).replace(/^"|"$/g, "");
    });
}

/** Diff of the working tree against HEAD, including untracked files, bounded in size. */
export async function workingDiff(cwd: string, maxChars = 60_000): Promise<string> {
  await git(cwd, ["add", "-A", "--intent-to-add"]);
  const res = await git(cwd, ["diff", "HEAD", "--stat", "--patch", "--no-color"]);
  const text = res.stdout;
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (diff truncated at ${maxChars} chars)` : text;
}

export async function commitAll(cwd: string, message: string): Promise<{ commit?: string; error?: string; empty?: boolean }> {
  await git(cwd, ["add", "-A"]);
  const staged = await git(cwd, ["diff", "--cached", "--quiet"]);
  if (staged.ok) return { empty: true };
  const id = await identityArgs(cwd);
  const res = await git(cwd, [...id, "commit", "-m", message]);
  if (!res.ok) return { error: res.stderr.trim() || "git commit failed" };
  return { commit: await headCommit(cwd) };
}

/** Throw away uncommitted changes in the worktree (after a failed ticket attempt). */
export async function discardChanges(cwd: string): Promise<void> {
  await git(cwd, ["reset", "--hard", "HEAD"]);
  await git(cwd, ["clean", "-fd"]);
}

/** Merge the factory branch into the base branch in the main working tree. */
export async function mergeInto(repo: string, branch: string, message: string): Promise<{ ok: boolean; error?: string }> {
  const id = await identityArgs(repo);
  const ff = await git(repo, ["merge", "--ff-only", branch]);
  if (ff.ok) return { ok: true };
  const res = await git(repo, [...id, "merge", "--no-ff", "-m", message, branch]);
  if (res.ok) return { ok: true };
  await git(repo, ["merge", "--abort"]);
  return { ok: false, error: res.stderr.trim() || res.stdout.trim() || "merge failed" };
}

export async function removeWorktree(repo: string, worktree: string): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", worktree]);
}
