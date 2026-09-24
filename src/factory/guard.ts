/**
 * Safety checks shared by the worker-side guard (tool_call hook inside each
 * worker process) and the harness (post-ticket diff check).
 */

import * as path from "node:path";

/** Convert a glob (`**`, `*`, `?`, trailing `/`) to an anchored RegExp over POSIX paths. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (g.endsWith("/")) g += "**";
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // "**/" matches zero or more directories; "**" at the end matches everything.
        if (g[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/** Normalise a tool path relative to cwd; returns undefined when it escapes cwd. */
export function relativeToCwd(cwd: string, target: string): string | undefined {
  const absolute = path.resolve(cwd, target);
  const rel = path.relative(cwd, absolute).split(path.sep).join("/");
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel;
}

export function inWriteScope(cwd: string, target: string, scope: string[]): boolean {
  const rel = relativeToCwd(cwd, target);
  if (!rel) return false;
  // Never let a worker touch git internals or factory state.
  if (rel === ".git" || rel.startsWith(".git/") || rel.startsWith(".factory/state") ) return false;
  return scope.some((glob) => globToRegExp(glob).test(rel));
}

const DESTRUCTIVE: Array<[RegExp, string]> = [
  [/\bgit\s+(push|commit|reset\s+--hard|rebase|checkout\s+-f|clean\s+-[a-z]*f|config|remote|tag|worktree|branch\s+-[dD])\b/, "git history and remotes are managed by the factory"],
  [/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME|\.\.)(\s|$|\/)/, "recursive delete outside the project"],
  [/\bsudo\b/, "sudo is not allowed"],
  [/\b(npm|pnpm|yarn|cargo|twine|gem)\s+publish\b/, "publishing packages is not allowed"],
  [/\bpoetry\s+publish\b/, "publishing packages is not allowed"],
  [/\b(fly|flyctl)\s+deploy\b|\bvercel\b.*--prod|\bnetlify\s+deploy\b|\bwrangler\s+(deploy|publish)\b|\brailway\s+up\b|\bkubectl\s+(apply|delete)\b|\bterraform\s+(apply|destroy)\b|\baws\s+\S+\s+(create|delete|put|update)|\bgcloud\s+.*\bdeploy\b|\baz\s+.*\bcreate\b|\bdocker\s+push\b|\bheroku\s+/, "deployment commands need the user's approval"],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bomb"],
  [/\bcurl\b[^|]*\|\s*(sh|bash)\b|\bwget\b[^|]*\|\s*(sh|bash)\b/, "piping remote scripts into a shell"],
];

/** Reason a bash command is blocked, or undefined when it is allowed. */
export function blockedCommand(command: string, options: { allowDeploy?: boolean } = {}): string | undefined {
  for (const [pattern, reason] of DESTRUCTIVE) {
    if (options.allowDeploy && reason.startsWith("deployment")) continue;
    if (pattern.test(command)) return reason;
  }
  return undefined;
}

/** Files changed outside the allowed scope (for the harness-side diff check). */
export function outOfScope(files: string[], scope: string[]): string[] {
  if (scope.length === 0) return files;
  const patterns = scope.map(globToRegExp);
  return files.filter((file) => !patterns.some((p) => p.test(file)));
}
