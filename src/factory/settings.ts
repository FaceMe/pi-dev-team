/**
 * Quick-setup answers: user-level defaults (remembered across projects), the
 * project's answers, and smart prefilled defaults detected from the machine
 * and the folder (existing code, stack, deploy CLIs, web access, prices).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { factoryConfigPath } from "../shared/config.js";
import { readJsonFile, writeJsonFile } from "../shared/json-store.js";
import { pricePerToken } from "../shared/models.js";
import type { Model } from "@earendil-works/pi-ai";
import type { Team } from "./team.js";
import type { DeployMode, ProjectMode, ResearchMode, SetupAnswers } from "./types.js";

/** Answers remembered for every project (the rest are per project). */
export const USER_LEVEL_KEYS = ["teamPreset", "pins", "autonomy", "research"] as const;

export function loadUserDefaults(): Partial<SetupAnswers> {
  return readJsonFile<Partial<SetupAnswers>>(factoryConfigPath()) ?? {};
}

export function saveUserDefaults(answers: SetupAnswers): void {
  const current = loadUserDefaults();
  const next: Record<string, unknown> = { ...current };
  for (const key of USER_LEVEL_KEYS) next[key] = answers[key];
  writeJsonFile(factoryConfigPath(), next);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const IGNORED_ENTRIES = new Set([".git", ".factory", ".DS_Store", ".gitignore", "README.md", "LICENSE", ".pi", ".vscode", ".idea"]);

/** "existing" when the folder has real project files, "new" when it is empty-ish. */
export function detectProjectMode(dir: string): ProjectMode {
  try {
    const entries = fs.readdirSync(dir).filter((name) => !IGNORED_ENTRIES.has(name));
    return entries.length > 0 ? "existing" : "new";
  } catch {
    return "new";
  }
}

const STACK_MARKERS: Array<[string, string]> = [
  ["package.json", "TypeScript/JavaScript (Node)"],
  ["pyproject.toml", "Python"],
  ["requirements.txt", "Python"],
  ["go.mod", "Go"],
  ["Cargo.toml", "Rust"],
  ["pom.xml", "Java (Maven)"],
  ["build.gradle", "Java/Kotlin (Gradle)"],
  ["build.gradle.kts", "Kotlin (Gradle)"],
  ["Gemfile", "Ruby"],
  ["composer.json", "PHP"],
  ["mix.exs", "Elixir"],
  ["pubspec.yaml", "Dart/Flutter"],
  ["Package.swift", "Swift"],
  ["deno.json", "Deno"],
];

export function detectStack(dir: string): string | undefined {
  for (const [file, stack] of STACK_MARKERS) {
    if (fs.existsSync(path.join(dir, file))) {
      if (file === "package.json" && !fs.existsSync(path.join(dir, "tsconfig.json"))) return "JavaScript (Node)";
      return stack;
    }
  }
  if (fs.existsSync(path.join(dir, "Dockerfile"))) return "Containerised (Dockerfile)";
  try {
    if (fs.readdirSync(dir).some((f) => f.endsWith(".csproj") || f.endsWith(".sln"))) return "C#/.NET";
  } catch {
    /* ignore */
  }
  return undefined;
}

function onPath(binary: string): boolean {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    execFileSync(cmd, [binary], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export interface DeployTarget {
  id: string;
  label: string;
  cli: string;
}

export const DEPLOY_TARGETS: DeployTarget[] = [
  { id: "fly", label: "Fly.io", cli: "flyctl" },
  { id: "vercel", label: "Vercel", cli: "vercel" },
  { id: "netlify", label: "Netlify", cli: "netlify" },
  { id: "cloudflare", label: "Cloudflare (wrangler)", cli: "wrangler" },
  { id: "railway", label: "Railway", cli: "railway" },
  { id: "render", label: "Render", cli: "render" },
  { id: "heroku", label: "Heroku", cli: "heroku" },
  { id: "aws", label: "AWS", cli: "aws" },
  { id: "gcp", label: "Google Cloud", cli: "gcloud" },
  { id: "azure", label: "Azure", cli: "az" },
  { id: "kubernetes", label: "Kubernetes (kubectl)", cli: "kubectl" },
];

/** Deploy CLIs installed on this machine (their own login is reused; no credentials are stored). */
export function detectDeployTargets(check: (bin: string) => boolean = onPath): DeployTarget[] {
  return DEPLOY_TARGETS.filter((target) => check(target.cli));
}

/** Tool names that mean the pi-web-access extension is loaded. */
export const WEB_ACCESS_TOOLS = ["web_search", "fetch_content"];

export function detectWebAccess(toolNames: string[]): boolean {
  return WEB_ACCESS_TOOLS.every((name) => toolNames.includes(name)) || toolNames.includes("web_search");
}

// ---------------------------------------------------------------------------
// Budget estimate
// ---------------------------------------------------------------------------

/** Rough tokens per role for a small project (input-heavy, cached context). */
const ROLE_TOKENS: Record<string, number> = {
  analyst: 250_000,
  researcher: 250_000,
  architect: 300_000,
  planner: 200_000,
  backend: 2_000_000,
  frontend: 1_500_000,
  devops: 600_000,
  reviewer: 600_000,
  docs: 300_000,
};

export type ProjectSize = "small" | "medium" | "large";

export function estimateSize(idea: string): ProjectSize {
  const words = idea.trim().split(/\s+/).filter(Boolean).length;
  const features = (idea.match(/\b(and|with|plus|also|,)\b/gi) ?? []).length;
  if (words > 150 || features > 10) return "large";
  if (words > 40 || features > 4) return "medium";
  return "small";
}

const SIZE_FACTOR: Record<ProjectSize, number> = { small: 1, medium: 2.5, large: 6 };

export interface BudgetEstimate {
  usd: number;
  tokens: number;
  priced: boolean;
  size: ProjectSize;
}

export function estimateBudget(team: Team, idea: string, find: (provider: string, id: string) => Model<any> | undefined): BudgetEstimate {
  const size = estimateSize(idea);
  let usd = 0;
  let tokens = 0;
  let priced = false;
  for (const [role, member] of Object.entries(team.members)) {
    const roleTokens = (ROLE_TOKENS[role] ?? 300_000) * SIZE_FACTOR[size];
    tokens += roleTokens;
    const model = find(member.provider, member.modelId);
    if (model) {
      const perToken = pricePerToken(model);
      if (perToken > 0) priced = true;
      usd += roleTokens * perToken;
    }
  }
  // Round up to a friendly number with ~50% headroom for retries.
  const withHeadroom = usd * 1.5;
  const rounded = withHeadroom <= 0 ? 0 : withHeadroom < 5 ? Math.ceil(withHeadroom) : Math.ceil(withHeadroom / 5) * 5;
  return { usd: rounded, tokens: Math.ceil((tokens * 1.5) / 1_000_000) * 1_000_000, priced, size };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export interface SetupContext {
  cwd: string;
  toolNames: string[];
  budget: BudgetEstimate;
  deployTargets: DeployTarget[];
}

/** Prefilled answers: remembered user defaults, the project's last answers, then detection. */
export function defaultAnswers(ctx: SetupContext, user: Partial<SetupAnswers>, project: Partial<SetupAnswers> | null): SetupAnswers {
  const detectedMode = detectProjectMode(ctx.cwd);
  const detectedStack = detectedMode === "existing" ? detectStack(ctx.cwd) : undefined;
  const webAccess = detectWebAccess(ctx.toolNames);
  const research: ResearchMode = webAccess
    ? "web-access"
    : user.research === "off"
      ? "off"
      : "install-web-access";
  return {
    teamPreset: user.teamPreset ?? "balanced",
    pins: { ...(user.pins ?? {}) },
    autonomy: user.autonomy ?? "balanced",
    projectMode: project?.projectMode ?? detectedMode,
    stack: project?.stack ?? (detectedStack ? `keep: ${detectedStack}` : "auto"),
    research: project?.research ?? research,
    deploy: (project?.deploy as DeployMode) ?? "none",
    deployTarget: project?.deployTarget,
    budgetUsd: project?.budgetUsd ?? ctx.budget.usd,
    budgetTokens: project?.budgetTokens ?? (ctx.budget.priced ? 0 : ctx.budget.tokens),
  };
}
