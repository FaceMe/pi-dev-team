/**
 * `/factory doctor`: everything a first run needs, with the fix for anything
 * missing. `/factory doctor probe` also runs a one-call tool-use check against
 * every distinct team model (costs a fraction of a cent each).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatCost } from "../shared/usage.js";
import { gitAvailable, isRepo } from "./git.js";
import { piInvocation } from "./runner.js";
import { detectDeployTargets } from "./settings.js";
import type { Team } from "./team.js";
import { describeTeam } from "./team.js";
import type { WorkerRunner } from "./types.js";

export interface DoctorLine {
  ok: boolean | "warn";
  label: string;
  detail: string;
  fix?: string;
}

function which(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.platform === "win32" ? "where" : "which", [binary], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export function piVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const inv = piInvocation(["--version"]);
    let out = "";
    const child = spawn(inv.command, inv.args, { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (d) => (out += String(d)));
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim().split("\n")[0] : undefined);
    });
  });
}

export async function runDoctor(args: {
  cwd: string;
  team: Team;
  availableCount: number;
  providers: string[];
  webAccess: boolean;
}): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  const hasGit = await gitAvailable();
  lines.push({ ok: hasGit, label: "git", detail: hasGit ? "installed" : "not found", fix: hasGit ? undefined : "Install git (https://git-scm.com)." });
  if (hasGit) {
    const repo = await isRepo(args.cwd);
    lines.push({ ok: true, label: "project folder", detail: repo ? "git repository" : "not a git repository yet (the factory runs git init)" });
  }
  const version = await piVersion();
  lines.push({
    ok: Boolean(version),
    label: "pi for workers",
    detail: version ? `runs (${version})` : "could not start pi as a subprocess",
    fix: version ? undefined : "Make sure `pi` is on your PATH, or set PI_FACTORY_PI_BIN to the pi executable.",
  });
  lines.push({
    ok: args.availableCount > 0,
    label: "models",
    detail: args.availableCount > 0 ? `${args.availableCount} logged in across ${args.providers.length} provider(s): ${args.providers.join(", ")}` : "none logged in",
    fix: args.availableCount > 0 ? undefined : "Run /login (or configure an API key) for at least one provider.",
  });
  for (const line of describeTeam(args.team)) lines.push({ ok: true, label: "team", detail: line });
  for (const note of args.team.notes) lines.push({ ok: "warn", label: "team", detail: note });
  lines.push({
    ok: args.webAccess ? true : "warn",
    label: "web research",
    detail: args.webAccess ? "pi-web-access loaded (web_search, fetch_content)" : "pi-web-access not loaded",
    fix: args.webAccess ? undefined : "pi install npm:pi-web-access (the setup screen can do this for you), then /reload.",
  });
  const toolchains = ["node", "npm", "pnpm", "python3", "uv", "go", "cargo", "java", "dotnet", "docker"];
  const present: string[] = [];
  for (const tool of toolchains) if (await which(tool)) present.push(tool);
  lines.push({ ok: present.length > 0 ? true : "warn", label: "toolchains", detail: present.length ? present.join(", ") : "none of the common toolchains found" });
  const deploy = detectDeployTargets();
  lines.push({ ok: true, label: "deploy CLIs", detail: deploy.length ? deploy.map((d) => d.cli).join(", ") : "none (deployment options: local or config only)" });
  return lines;
}

/** One cheap tool-use round trip per distinct team model. */
export async function probeModels(team: Team, runner: WorkerRunner, sessionsDir: string): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  const seen = new Set<string>();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-factory-probe-"));
  fs.writeFileSync(path.join(dir, "probe.txt"), "ok\n");
  for (const member of Object.values(team.members)) {
    const key = `${member.provider}/${member.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const result = await runner.run({
      role: "probe",
      member: { ...member, effort: "off" },
      tools: ["ls"],
      systemPrompt: "You are a connectivity probe. Follow the instruction exactly.",
      prompt: "Call the ls tool once on the current directory, then reply with the single word READY.",
      cwd: dir,
      sessionId: `probe-${Date.now()}-${seen.size}`,
      sessionDir: sessionsDir,
      writeScope: [],
      timeoutMs: 120_000,
    });
    const usedTool = result.trace.some((step) => step.kind === "tool" && step.title === "ls");
    const ok = !result.isError && usedTool;
    lines.push({
      ok: ok ? true : result.isError ? false : "warn",
      label: `probe ${key}`,
      detail: result.isError ? `failed: ${result.errorMessage}` : `${usedTool ? "tool use ok" : "answered without calling the tool"} · ${formatCost(result.usage.cost.total)}`,
      fix: ok ? undefined : "Pick another model for the roles that use it (setup screen → Team → pin a role).",
    });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return lines;
}

export function formatDoctor(lines: DoctorLine[]): string[] {
  return lines.map((line) => {
    const mark = line.ok === true ? "✓" : line.ok === "warn" ? "!" : "✗";
    return `${mark} ${line.label}: ${line.detail}${line.fix ? `\n    → ${line.fix}` : ""}`;
  });
}
