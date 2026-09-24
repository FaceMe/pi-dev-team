/**
 * Quick setup: one screen of prefilled answers. The first line starts with the
 * defaults, so a user who agrees presses Enter once. Any line can be opened to
 * change that answer. Works with any UI that supports select/input (TUI, RPC).
 */

import { formatTokens } from "../shared/usage.js";
import type { DeployTarget } from "./settings.js";
import type { Team } from "./team.js";
import { describeTeam } from "./team.js";
import type { Autonomy, FactoryUI, SetupAnswers, TeamPreset } from "./types.js";

export const START = "▶ Start with these answers";

export const AUTONOMY_TEXT: Record<Autonomy, string> = {
  auto: "auto — you approve the spec; everything else runs",
  balanced: "balanced — you approve the spec and one build plan",
  careful: "careful — you approve every phase and each ticket",
};

const PRESET_TEXT: Record<TeamPreset, string> = {
  balanced: "balanced — each role on its natural tier",
  cheap: "cheap — one tier down (judgement roles stay ≥ daily)",
  best: "best — the strongest model everywhere",
};

export interface SetupDeps {
  ui: FactoryUI;
  roles: string[];
  deployTargets: DeployTarget[];
  webAccessInstalled: boolean;
  detectedStack?: string;
  budgetEstimate: { usd: number; tokens: number; priced: boolean; size: string };
  previewTeam: (answers: SetupAnswers) => Team;
  /** Opens the model picker for a role; returns the chosen model or undefined. */
  pickModel?: (role: string) => Promise<{ provider: string; modelId: string; effort?: any } | undefined>;
}

export function budgetText(answers: SetupAnswers, estimate: SetupDeps["budgetEstimate"]): string {
  if (answers.budgetUsd > 0) {
    const isEstimate = answers.budgetUsd === estimate.usd;
    return `$${answers.budgetUsd}${isEstimate ? ` (estimate for a ${estimate.size} project with this team)` : ""} · pauses at 80%`;
  }
  if (answers.budgetTokens > 0) return `${formatTokens(answers.budgetTokens)} tokens (model prices unknown) · pauses at 80%`;
  return "no limit";
}

function stackText(stack: string): string {
  if (stack === "auto") return "let the architect choose";
  return stack;
}

function researchText(answers: SetupAnswers, installed: boolean): string {
  if (answers.research === "off") return "off";
  if (answers.research === "web-access" && installed) return "pi-web-access (web_search, fetch_content)";
  return "install pi-web-access now (pi install npm:pi-web-access)";
}

function deployText(answers: SetupAnswers, targets: DeployTarget[]): string {
  if (answers.deploy === "none") return "run locally only";
  if (answers.deploy === "config") return "generate deploy config (Dockerfile + CI); you deploy";
  const target = targets.find((t) => t.id === answers.deployTarget);
  return `deploy for me to ${target?.label ?? answers.deployTarget ?? "?"} (always asks before deploying)`;
}

export function setupLines(answers: SetupAnswers, deps: SetupDeps): string[] {
  const team = deps.previewTeam(answers);
  const teamSummary = describeTeam(team).join(" · ") || "no models logged in";
  const pins = Object.keys(answers.pins).length;
  return [
    START,
    `Team: ${answers.teamPreset}${pins ? ` + ${pins} pinned` : ""} — ${teamSummary}`,
    `Autonomy: ${AUTONOMY_TEXT[answers.autonomy]}`,
    `Project: ${answers.projectMode === "existing" ? "add to the existing project in this folder" : "new project in this folder"}`,
    `Stack: ${stackText(answers.stack)}`,
    `Web research: ${researchText(answers, deps.webAccessInstalled)}`,
    `Deployment: ${deployText(answers, deps.deployTargets)}`,
    `Budget: ${budgetText(answers, deps.budgetEstimate)}`,
  ];
}

/** Run the quick setup. Returns the confirmed answers, or undefined if the user cancelled. */
export async function runQuickSetup(initial: SetupAnswers, deps: SetupDeps): Promise<SetupAnswers | undefined> {
  const answers: SetupAnswers = { ...initial, pins: { ...initial.pins } };
  const { ui } = deps;

  for (let guard = 0; guard < 100; guard++) {
    const lines = setupLines(answers, deps);
    const choice = await ui.select("Factory setup — Enter starts with these answers", lines);
    if (choice === undefined) return undefined;
    if (choice === START) return answers;
    const key = choice.split(":")[0];

    switch (key) {
      case "Team": {
        const options = [...(Object.keys(PRESET_TEXT) as TeamPreset[]).map((p) => PRESET_TEXT[p])];
        if (deps.pickModel) options.push("pin a role to a specific model…");
        if (Object.keys(answers.pins).length > 0) options.push("clear pinned models");
        const pick = await ui.select("Team", options);
        if (!pick) break;
        if (pick.startsWith("pin a role")) {
          const role = await ui.select("Which role?", deps.roles);
          if (!role || !deps.pickModel) break;
          const model = await deps.pickModel(role);
          if (model) answers.pins[role] = model;
        } else if (pick.startsWith("clear pinned")) {
          answers.pins = {};
        } else {
          answers.teamPreset = pick.split(" ")[0] as TeamPreset;
        }
        break;
      }
      case "Autonomy": {
        const pick = await ui.select("Autonomy", Object.values(AUTONOMY_TEXT));
        if (pick) answers.autonomy = pick.split(" ")[0] as Autonomy;
        break;
      }
      case "Project": {
        const pick = await ui.select("Project", ["new project in this folder", "add to the existing project in this folder"]);
        if (pick) answers.projectMode = pick.startsWith("add") ? "existing" : "new";
        break;
      }
      case "Stack": {
        const options = ["let the architect choose"];
        if (deps.detectedStack) options.push(`keep: ${deps.detectedStack}`);
        options.push("TypeScript / Node", "Python", "Go", "Rust", "Java / Kotlin", "C# / .NET", "other… (type it)");
        const pick = await ui.select("Stack", options);
        if (!pick) break;
        if (pick.startsWith("let the architect")) answers.stack = "auto";
        else if (pick.startsWith("other")) {
          const typed = await ui.input("Stack", "e.g. Elixir + Phoenix, SvelteKit, Django + HTMX");
          if (typed?.trim()) answers.stack = typed.trim();
        } else answers.stack = pick;
        break;
      }
      case "Web research": {
        const options = deps.webAccessInstalled
          ? ["pi-web-access (web_search, fetch_content)", "off"]
          : ["install pi-web-access now (pi install npm:pi-web-access)", "off"];
        const pick = await ui.select("Web research", options);
        if (!pick) break;
        answers.research = pick === "off" ? "off" : deps.webAccessInstalled ? "web-access" : "install-web-access";
        break;
      }
      case "Deployment": {
        const options = ["run locally only", "generate deploy config (Dockerfile + CI); you deploy"];
        for (const target of deps.deployTargets) options.push(`deploy for me to ${target.label} (${target.cli} detected)`);
        options.push("deploy for me to another target… (type it)");
        const pick = await ui.select("Deployment", options);
        if (!pick) break;
        if (pick.startsWith("run locally")) {
          answers.deploy = "none";
          answers.deployTarget = undefined;
        } else if (pick.startsWith("generate")) {
          answers.deploy = "config";
          answers.deployTarget = undefined;
        } else if (pick.includes("another target")) {
          const typed = await ui.input("Deploy target", "e.g. a VPS over ssh, DigitalOcean App Platform");
          if (typed?.trim()) {
            answers.deploy = "deploy";
            answers.deployTarget = typed.trim();
          }
        } else {
          const target = deps.deployTargets.find((t) => pick.includes(t.label));
          if (target) {
            answers.deploy = "deploy";
            answers.deployTarget = target.id;
          }
        }
        break;
      }
      case "Budget": {
        const est = deps.budgetEstimate;
        const options: string[] = [];
        if (est.priced) options.push(`$${est.usd} (estimate)`, `$${est.usd * 2} (double)`);
        else options.push(`${formatTokens(est.tokens)} tokens (estimate)`);
        options.push("no limit", "custom… (type it)");
        const pick = await ui.select("Budget per project", options);
        if (!pick) break;
        if (pick === "no limit") {
          answers.budgetUsd = 0;
          answers.budgetTokens = 0;
        } else if (pick.startsWith("custom")) {
          const typed = await ui.input(est.priced ? "Budget in dollars" : "Budget in millions of tokens", est.priced ? String(est.usd) : "10");
          const value = Number(String(typed ?? "").replace(/[$,\s]/g, ""));
          if (Number.isFinite(value) && value > 0) {
            if (est.priced) answers.budgetUsd = value;
            else answers.budgetTokens = Math.round(value * 1_000_000);
          }
        } else if (pick.includes("tokens")) {
          answers.budgetUsd = 0;
          answers.budgetTokens = est.tokens;
        } else {
          answers.budgetUsd = Number(pick.replace(/^\$/, "").split(" ")[0]);
          answers.budgetTokens = 0;
        }
        break;
      }
      default:
        break;
    }
  }
  return answers;
}
