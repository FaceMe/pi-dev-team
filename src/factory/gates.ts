/**
 * Deterministic gates: the profile's commands, run by the harness. Only their
 * exit codes decide whether work is done — never an agent's claim.
 */

import { spawn } from "node:child_process";
import { tail } from "../shared/text.js";
import type { GateResult, GateSpec, Profile } from "./types.js";

export function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ code: number; output: string; durationMs: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? "cmd.exe" : "bash";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
    const child = spawn(shell, args, {
      cwd,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-200_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      output += `\n[factory] gate timed out after ${Math.round(timeoutMs / 1000)}s`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, output: `${output}\n${error.message}`, durationMs: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output, durationMs: Date.now() - started });
    });
  });
}

export interface GateRunOptions {
  /** Skip the install gate (dependencies unchanged). */
  skipInstall?: boolean;
  timeoutMs?: number;
  /** Stop at the first failing gate. */
  failFast?: boolean;
}

export async function runGates(profile: Profile, cwd: string, options: GateRunOptions = {}): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const gate of profile.gates) {
    if (options.skipInstall && gate.name === "install") continue;
    const res = await runCommand(gate.command, cwd, options.timeoutMs ?? 15 * 60_000);
    results.push({ gate: gate.name, command: gate.command, ok: res.code === 0, exitCode: res.code, durationMs: res.durationMs, output: tail(res.output, 6000) });
    if (res.code !== 0 && options.failFast !== false) break;
  }
  return results;
}

export function gatesPassed(results: GateResult[], profile: Profile, skipInstall = false): boolean {
  const expected = profile.gates.filter((g) => !(skipInstall && g.name === "install")).length;
  return results.length === expected && results.every((r) => r.ok);
}

export function describeGateFailure(results: GateResult[]): string {
  const failed = results.find((r) => !r.ok);
  if (!failed) return "all gates passed";
  return `Gate "${failed.gate}" failed (exit ${failed.exitCode}): \`${failed.command}\`\n\n${failed.output}`;
}

export function summarizeGates(results: GateResult[]): string {
  return results.map((r) => `${r.ok ? "✓" : "✗"} ${r.gate} (${(r.durationMs / 1000).toFixed(1)}s)`).join("  ");
}

/** Validate and normalise the architect's profile. */
export function normalizeProfile(raw: any): { profile?: Profile; error?: string } {
  if (!raw || typeof raw !== "object") return { error: "profile is not an object" };
  const gatesRaw = raw.gates;
  const gates: GateSpec[] = [];
  const order = ["install", "build", "typecheck", "lint", "test"];
  if (Array.isArray(gatesRaw)) {
    for (const g of gatesRaw) {
      if (g && typeof g.name === "string" && typeof g.command === "string" && g.command.trim()) {
        gates.push({ name: g.name.trim(), command: g.command.trim() });
      }
    }
  } else if (gatesRaw && typeof gatesRaw === "object") {
    const names = Object.keys(gatesRaw).sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    for (const name of names) {
      const command = gatesRaw[name];
      if (typeof command === "string" && command.trim()) gates.push({ name, command: command.trim() });
    }
  }
  if (!gates.some((g) => g.name === "test")) return { error: 'profile needs a "test" gate' };
  const manifests = Array.isArray(raw.manifests) ? raw.manifests.filter((m: unknown) => typeof m === "string") : [];
  return {
    profile: {
      stack: typeof raw.stack === "string" ? raw.stack : "unspecified",
      gates,
      manifests: manifests.length > 0 ? manifests : ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json"],
    },
  };
}
