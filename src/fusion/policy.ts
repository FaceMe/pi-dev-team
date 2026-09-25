/**
 * Delegation policy for the Fusion main agent.
 *
 * Asking a frontier model to "delegate by default" in a prompt is not enough:
 * with bash/edit/write at hand it simply does the work itself. The policy makes
 * delegation structural, in three strengths:
 *
 *   advisory — prompt guidance only (the old behaviour).
 *   balanced — mechanical, verbose commands (tests, builds, linters, installs)
 *              are redirected to the sidekick; large direct outputs are
 *              compressed by the cheap model; long runs of direct actions get
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
}

export const DEFAULT_DELEGATION: DelegationConfig = {
  mode: "balanced",
  nudgeAfter: 6,
  compressOutputChars: 8000,
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

export interface PolicyState {
  /** Consecutive direct tool calls since the last delegation (per agent run). */
  directStreak: number;
  /** Delegations that failed in a row: the policy relaxes so the main agent is never stuck. */
  failedDelegations: number;
}

export interface BlockDecision {
  block: boolean;
  reason?: string;
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
): BlockDecision {
  if (mode === "advisory" || !sidekickAvailable) return { block: false };
  // Escape hatch: if delegations keep failing, let the main agent act.
  if (state.failedDelegations >= 2) return { block: false };

  const isShell = toolName === "bash" || toolName === "powershell";
  if (mode === "strict" && EXECUTION_TOOLS.includes(toolName)) {
    return {
      block: true,
      reason:
        `Fusion (strict): the main agent takes minimal direct action. Delegate this ${toolName} work to the sidekick ` +
        "with the `sidekick` tool — give it a self-contained brief with exact paths and acceptance criteria — then verify its result.",
    };
  }
  if (mode === "balanced" && isShell) {
    const command = String(input.command ?? "");
    const kind = classifyCommand(command);
    if (kind === "verify" || kind === "install") {
      return {
        block: true,
        reason:
          `Fusion: ${kind === "verify" ? "tests, builds and linters" : "dependency installs"} are delegated so their verbose output stays out of your context. ` +
          `Run it through the sidekick instead, e.g. ${suggestion(command)}. ` +
          "With background: true you can keep working; the result is delivered to you when it finishes.",
      };
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
