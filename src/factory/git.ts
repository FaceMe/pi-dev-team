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

/**
 * Files that differ between `base` and the working tree (tracked, untracked and
 * deleted), as repo-relative POSIX paths. With a ticket's base commit this is
 * exactly the ticket's own change, even after integration was merged into it.
 */
export async function changedSince(cwd: string, base: string): Promise<string[]> {
  await git(cwd, ["add", "-A", "--intent-to-add"]);
  const res = await git(cwd, ["diff", "--name-only", "--no-renames", base]);
  return res.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Put files back to their content at `base` (deleting the ones `base` does not have). */
export async function revertToBase(cwd: string, base: string, files: string[]): Promise<void> {
  for (const file of files) {
    const inBase = await git(cwd, ["cat-file", "-e", `${base}:${file}`]);
    if (inBase.ok) {
      await git(cwd, ["checkout", base, "--", file]);
    } else {
      await git(cwd, ["rm", "--cached", "--quiet", "--ignore-unmatch", "--", file]);
      fs.rmSync(path.join(cwd, file), { force: true, recursive: true });
    }
  }
}

/** Diff of the working tree against HEAD (or `base`), including untracked files, bounded in size. */
export async function workingDiff(cwd: string, maxChars = 60_000, base = "HEAD"): Promise<string> {
  await git(cwd, ["add", "-A", "--intent-to-add"]);
  const res = await git(cwd, ["diff", base, "--stat", "--patch", "--no-color"]);
  const text = res.stdout;
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (diff truncated at ${maxChars} chars)` : text;
}

export async function commitAll(cwd: string, message: string): Promise<{ commit?: string; error?: string; empty?: boolean }> {
  await git(cwd, ["add", "-A"]);
  const staged = await git(cwd, ["diff", "--cached", "--quiet"]);
  // A merge in progress is always concluded, even when its resolution equals HEAD.
  const merging = (await git(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).ok;
  if (staged.ok && !merging) return { empty: true };
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
  // A worktree folder git no longer knows about (crash, manual delete) is removed by hand.
  if (fs.existsSync(worktree)) fs.rmSync(worktree, { recursive: true, force: true });
  await git(repo, ["worktree", "prune"]);
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await git(repo, ["branch", "-D", branch]);
}

/** Paths with unresolved merge conflicts. */
export async function conflictedFiles(cwd: string): Promise<string[]> {
  const res = await git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  return res.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * Merge `branch` into the checked-out branch of `cwd` with a merge commit.
 * On conflict: with `keepConflicts` the conflict markers stay in the tree (for a
 * worker to resolve); otherwise the merge is aborted. Either way the
 * conflicted paths are returned.
 */
export async function mergeBranch(
  cwd: string,
  branch: string,
  message: string,
  options: { keepConflicts?: boolean } = {},
): Promise<{ ok: boolean; conflicts: string[]; error?: string }> {
  const id = await identityArgs(cwd);
  const res = await git(cwd, [...id, "merge", "--no-ff", "-m", message, branch]);
  if (res.ok) return { ok: true, conflicts: [] };
  const conflicts = await conflictedFiles(cwd);
  if (!options.keepConflicts || conflicts.length === 0) await git(cwd, ["merge", "--abort"]);
  return { ok: false, conflicts, error: res.stderr.trim() || res.stdout.trim() || "merge failed" };
}

/** Move the checked-out branch back to `commit`, dropping later commits and local changes. */
export async function resetTo(cwd: string, commit: string): Promise<void> {
  await git(cwd, ["reset", "--hard", commit]);
  await git(cwd, ["clean", "-fd"]);
}

/** Diff between two commits (no working tree), bounded in size. */
export async function commitDiff(cwd: string, from: string, to: string, maxChars = 400_000): Promise<string> {
  const res = await git(cwd, ["diff", "--no-color", "--patch", `${from}..${to}`]);
  const text = res.stdout;
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** Files changed between two commits. */
export async function filesBetween(cwd: string, from: string, to: string): Promise<string[]> {
  const res = await git(cwd, ["diff", "--name-only", "--no-renames", `${from}..${to}`]);
  return res.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}
