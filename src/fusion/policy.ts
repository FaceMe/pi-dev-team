/**
 * Delegation policy for the Fusion main agent.
 *
 * Asking a frontier model to "delegate by default" in a prompt is not enough:
 * with bash/edit/write at hand it simply does the work itself. The policy makes
 * delegation structural, in three strengths:
 *
 *   advisory — prompt guidance only (the old behaviour).
 *   balanced — tests, builds, linters and installs run directly the first
 *              time; once one has proved slow or verbose it is redirected to
 *              the sidekick (in the background). Large direct outputs are
 *              condensed by the cheap model; long runs of direct actions get
 *              a nudge. The main agent still reads and edits directly.
 *   strict   — "minimal direct action": the main agent keeps read-only tools
 *              plus the sidekick; all execution and editing is delegated.
 */

export type DelegationMode = "advisory" | "balanced" | "strict";

export interface DelegationConfig {
  mode: DelegationMode;
  /** Nudge after this many consecutive direct tool calls without a delegation (0 = never). */
  nudgeAfter: number;
  /** Compress direct bash outputs longer than this many characters through the sidekick model (0 = never). */
  compressOutputChars: number;
  /** A test/build/install command that took at least this long is redirected next time (balanced). */
  slowCommandMs: number;
  /** Default timeout (seconds) added to test/build/install commands that don't set one (0 = none). */
  commandTimeoutSec: number;
  /** Longest sidekick result returned to the main agent; the rest goes to a file (0 = no cap). */
  resultCapChars: number;
  /** Attach the files the main agent has read and `git status` to every brief. */
  briefContext: boolean;
}

export const DEFAULT_DELEGATION: DelegationConfig = {
  mode: "balanced",
  nudgeAfter: 6,
  compressOutputChars: 8000,
  slowCommandMs: 60_000,
  commandTimeoutSec: 600,
  resultCapChars: 4000,
  briefContext: true,
};

/** Tools the main agent loses in strict mode (the sidekick gets them instead). */
export const EXECUTION_TOOLS = ["bash", "powershell", "edit", "write"];

export type CommandKind = "verify" | "install" | "recon" | "other";

const VERIFY = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|tests|build|lint|typecheck|type-check|check|e2e|ci|coverage|bench)\b/,
  /\b(npx|pnpx|bunx)\s+(vitest|jest|mocha|ava|tsc|eslint|biome|prettier\s+--check|playwright|cypress|next\s+build|vite\s+build|turbo)\b/,
  /\b(vitest|jest|mocha|pytest|tox|nox|rspec|phpunit|ctest|playwright|cypress)\b/,
  /\bpython3?\s+-m\s+(pytest|unittest|mypy|ruff|flake8|pylint)\b/,
  /\b(mypy|ruff\s+check|flake8|pylint|eslint|tsc)\b/,
  /\b(cargo|go)\s+(test|build|check|clippy|vet|bench)\b/,
  /\b(mvn|mvnw|\.\/mvnw)\s+\S*\s*(test|verify|package|install|compile)\b/,
  /\b(gradle|gradlew|\.\/gradlew)\s+\S*\s*(test|build|check|assemble)\b/,
  /\bdotnet\s+(test|build)\b/,
  /\b(make|just|task)\s+(test|tests|build|lint|check|ci|all)\b/,
  /\bdocker\s+(build|compose\s+build)\b/,
  /\bswift\s+(test|build)\b/,
  /\bmix\s+test\b|\bbundle\s+exec\s+(rspec|rake)\b|\brake\s+test\b/,
];

const INSTALL = [
  /\b(npm|pnpm|yarn|bun)\s+(install|i|ci|add)\b/,
  /\bpip3?\s+install\b|\buv\s+(sync|pip\s+install|add)\b|\bpoetry\s+(install|add)\b/,
  /\bcargo\s+(fetch|add)\b|\bgo\s+(mod\s+download|get)\b|\bbundle\s+install\b|\bcomposer\s+install\b/,
];

const RECON = [
  /\b(grep|rg|ag|ack)\b.*\s-(r|R|[a-zA-Z]*r[a-zA-Z]*)\b/,
  /\brg\b/,
  /\bfind\s+\S+.*-(name|type|path)\b/,
  /\btree\b|\bls\s+-[a-zA-Z]*R/,
  /\bgit\s+(log|grep|blame)\b/,
  /\bwc\s+-l\b.*\*/,
];

export function classifyCommand(command: string): CommandKind {
  const cmd = command.trim();
  if (!cmd) return "other";
  if (VERIFY.some((re) => re.test(cmd))) return "verify";
  if (INSTALL.some((re) => re.test(cmd))) return "install";
  if (RECON.some((re) => re.test(cmd))) return "recon";
  return "other";
}

/**
 * Commands that never exit on their own (dev servers, watchers, followers).
 * They would hang whichever agent runs them until its timeout.
 */
const NEVER_EXITS: RegExp[] = [
  /(^|\s)--watch(All)?(\s|$|=(?!false\b|0\b))/,
  /\b(tsc|webpack|rollup|esbuild|vitest|jest|nodemon|tailwindcss)\b.*\s-w(\s|$)/,
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch|preview)\b/,
  /\b(next|nuxt|astro|remix|vite|gatsby)\s+dev\b|\bvite(\s*$|\s+--(host|port))|\bwebpack\s+(serve|-dev-server)\b|\bwebpack-dev-server\b/,
  /\bnodemon\b|\bng\s+serve\b|\bhugo\s+server\b|\bjekyll\s+serve\b/,
  /\bpython3?\s+-m\s+http\.server\b|\bflask\s+run\b|\buvicorn\b(?!.*--help)|\bmanage\.py\s+runserver\b|\brails\s+(s|server)\b/,
  /\bdocker(-|\s+)compose\s+up\b(?!.*\s-d\b)(?!.*--detach)/,
  /\btail\s+-[a-zA-Z]*f\b|\bwatch\s+-n\b/,
];

/** Reason a command would never exit, or undefined. Backgrounded commands (`… &`) are fine. */
export function neverExits(command: string): string | undefined {
  const cmd = command.trim();
  if (!cmd || /&\s*$/.test(cmd) || /\bnohup\b/.test(cmd) || /\btimeout\s+\d/.test(cmd)) return undefined;
  if (NEVER_EXITS.some((re) => re.test(cmd))) {
    return (
      "this command does not exit on its own (a dev server, watcher or follower), so it would hang until the tool times out. " +
      "Use a one-shot variant (e.g. `vitest run`, `tsc --noEmit`, a build), or start it in the background with output to a log " +
      "(`cmd > /tmp/server.log 2>&1 &`) and poll the log."
    );
  }
  return undefined;
}

/** Normalised key for remembering a command's runtime and output size. */
export function commandKey(command: string): string {
  return command.trim().replace(/\s+/g, " ").slice(0, 200);
}

export interface CommandRecord {
  durationMs: number;
  outputChars: number;
  runs: number;
}

export interface PolicyState {
  /** Consecutive direct tool calls since the last delegation (per agent run). */
  directStreak: number;
  /** Delegations that failed in a row: the policy relaxes so the main agent is never stuck. */
  failedDelegations: number;
  /** What each test/build/install command cost last time it ran directly, by commandKey. */
  history?: Map<string, CommandRecord>;
}

export interface BlockDecision {
  block: boolean;
  reason?: string;
}

/** Remember a direct command's runtime and output size (keeps the last run). */
export function recordCommand(state: PolicyState, command: string, durationMs: number, outputChars: number): void {
  state.history ??= new Map();
  const key = commandKey(command);
  const prev = state.history.get(key);
  state.history.set(key, { durationMs, outputChars, runs: (prev?.runs ?? 0) + 1 });
  if (state.history.size > 200) state.history.delete(state.history.keys().next().value as string);
}

function suggestion(command: string): string {
  return `sidekick({ task: "Run \`${command.replace(/`/g, "'")}\` from the repository root and report the outcome: pass/fail counts, each failure with file:line and the key error lines verbatim.", expect: "evidence", background: true })`;
}

/** Decide whether a direct tool call by the main agent should be redirected to the sidekick. */
export function decideDirectCall(
  mode: DelegationMode,
  toolName: string,
  input: Record<string, unknown>,
  state: PolicyState,
  sidekickAvailable: boolean,
  config: Pick<DelegationConfig, "slowCommandMs" | "compressOutputChars"> = DEFAULT_DELEGATION,
): BlockDecision {
  const isShell = toolName === "bash" || toolName === "powershell";
  const command = isShell ? String(input.command ?? "") : "";
  // Commands that never exit are refused in every mode: they hang the agent.
  if (isShell) {
    const hang = neverExits(command);
    if (hang) return { block: true, reason: `Fusion: ${hang}` };
  }
  if (mode === "advisory" || !sidekickAvailable) return { block: false };
  // Escape hatch: if delegations keep failing, let the main agent act.
  if (state.failedDelegations >= 2) return { block: false };

  if (mode === "strict" && EXECUTION_TOOLS.includes(toolName)) {
    return {
      block: true,
      reason:
        `Fusion (strict): the main agent takes minimal direct action. Delegate this ${toolName} work to the sidekick ` +
        "with the `sidekick` tool — give it a self-contained brief with exact paths and acceptance criteria — then verify its result.",
    };
  }
  if (mode === "balanced" && isShell) {
    const kind = classifyCommand(command);
    if (kind === "verify" || kind === "install") {
      // Adaptive: a quick, quiet command is cheaper to run directly than to
      // delegate (a delegation costs an extra main turn plus sidekick turns).
      // Redirect only commands that proved slow or verbose when run directly.
      const record = state.history?.get(commandKey(command));
      const slow = record && config.slowCommandMs > 0 && record.durationMs >= config.slowCommandMs;
      const verbose = record && config.compressOutputChars > 0 && record.outputChars > config.compressOutputChars;
      if (slow || verbose) {
        const why = slow ? `took ${Math.round(record!.durationMs / 1000)}s` : `printed ${record!.outputChars.toLocaleString()} chars`;
        return {
          block: true,
          reason:
            `Fusion: last time \`${commandKey(command)}\` ${why} in your context. Run it through the sidekick instead, e.g. ${suggestion(command)}. ` +
            "With background: true you keep working; the result is delivered to you when it finishes.",
        };
      }
    }
  }
  return { block: false };
}

export function nudgeText(streak: number): string {
  return (
    `[fusion] ${streak} direct tool calls in a row without delegating. You own the plan and the review; ` +
    "hand well-scoped recon, mechanical edits and verification to the sidekick (background: true lets you keep working)."
  );
}

export function compressionPrompt(command: string, output: string): string {
  return [
    "Summarise this command output for the engineer who ran it. They will act on your summary without reading the raw output.",
    "Include: whether it succeeded, counts (tests passed/failed, errors, warnings), every failure or error with file:line and the key message lines verbatim, and anything surprising.",
    "Do not speculate about fixes. Maximum 30 lines.",
    "",
    `Command: ${command}`,
    "Output:",
    output,
  ].join("\n");
}
