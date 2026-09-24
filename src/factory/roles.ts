/**
 * Role registry. Built-in roles ship as Markdown files in ./roles; users can
 * override or add roles in <agentDir>/factory/roles/*.md, and trusted projects
 * in .factory/roles/*.md. Later sources replace earlier ones by name.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../shared/config.js";
import { EFFORT_ORDER } from "../shared/models.js";
import type { EffortLevel } from "../shared/models.js";
import { TIERS } from "../shared/tiers.js";
import type { Tier } from "../shared/tiers.js";
import type { RoleDef } from "./types.js";

export const BUILTIN_ROLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "roles");
export const userRolesDir = (): string => path.join(agentDir(), "factory", "roles");

function list(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return raw.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function tier(value: unknown, fallback: Tier): Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value) ? (value as Tier) : fallback;
}

/** Parse one role file. Returns undefined (never throws) for a malformed file. */
export function parseRole(content: string, source: RoleDef["source"], fallbackName: string): RoleDef | undefined {
  try {
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
    const name = typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : fallbackName;
    const roleTier = tier(frontmatter.tier, "daily");
    const effort =
      typeof frontmatter.effort === "string" && (EFFORT_ORDER as readonly string[]).includes(frontmatter.effort)
        ? (frontmatter.effort as EffortLevel)
        : undefined;
    const escalation = list(frontmatter.escalation).filter((t): t is Tier => (TIERS as readonly string[]).includes(t));
    return {
      name,
      description: typeof frontmatter.description === "string" ? frontmatter.description : name,
      tier: roleTier,
      model: typeof frontmatter.model === "string" && frontmatter.model.includes("/") ? frontmatter.model : undefined,
      effort,
      escalation: escalation.length > 0 ? escalation : [roleTier],
      tools: list(frontmatter.tools),
      judgement: frontmatter.judgement === true,
      sidekick: frontmatter.sidekick === true,
      reviewDiversity: frontmatter.reviewDiversity === true,
      systemPrompt: body.trim(),
      source,
    };
  } catch {
    return undefined;
  }
}

function loadDir(dir: string, source: RoleDef["source"], into: Map<string, RoleDef>): void {
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((file) => file.endsWith(".md"));
  } catch {
    return;
  }
  for (const file of files.sort()) {
    try {
      const role = parseRole(fs.readFileSync(path.join(dir, file), "utf8"), source, path.basename(file, ".md"));
      if (role) into.set(role.name, role);
    } catch {
      /* one bad file must not take down the others */
    }
  }
}

export function loadRoles(options: { projectDir?: string; trustProject?: boolean } = {}): Map<string, RoleDef> {
  const roles = new Map<string, RoleDef>();
  loadDir(BUILTIN_ROLES_DIR, "builtin", roles);
  loadDir(userRolesDir(), "user", roles);
  if (options.projectDir && options.trustProject) loadDir(path.join(options.projectDir, ".factory", "roles"), "project", roles);
  return roles;
}

/** Roles that write product code and can own tickets. */
export const BUILDER_ROLES = ["backend", "frontend", "devops", "docs"];
