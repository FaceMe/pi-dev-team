/** Optional pi tool bridges. Tool names are supplied by the bridge, never guessed. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { detectBrave } from "./browser.js";

export const DESIGN_PROVIDERS = ["paper", "opendesign", "doop"] as const;
export type DesignProvider = typeof DESIGN_PROVIDERS[number];
export interface ToolBridge { enabled?: boolean; tools: string[]; extensions?: string[]; context?: string }
export interface IntegrationSettings {
  design?: Partial<Record<DesignProvider, ToolBridge>>;
  browser?: { enabled: boolean; executablePath?: string; tools?: string[]; extensions?: string[] };
}
const strings = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((v): v is string => typeof v === "string" && !!v.trim()).map(v => v.trim()))] : [];
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
export function integrationSettings(raw: unknown): IntegrationSettings {
  const source = object(raw), result: IntegrationSettings = {};
  for (const provider of DESIGN_PROVIDERS) {
    const bridge = object(object(source.design)[provider]);
    if (Object.keys(bridge).length) {
      result.design ??= {};
      result.design[provider] = { enabled: bridge.enabled !== false, tools: strings(bridge.tools), extensions: strings(bridge.extensions), context: typeof bridge.context === "string" ? bridge.context : undefined };
    }
  }
  const browser = object(source.browser);
  if (Object.keys(browser).length) result.browser = { enabled: browser.enabled === true, executablePath: typeof browser.executablePath === "string" ? browser.executablePath : undefined, tools: strings(browser.tools), extensions: strings(browser.extensions) };
  return result;
}
export const INTEGRATIONS_ENV = "PI_FACTORY_INTEGRATIONS";
export const BRAVE_ENV = "PI_FACTORY_BRAVE_EXECUTABLE";
export function integrationWorkerConfig(role: string, raw: unknown, cwd: string, env: NodeJS.ProcessEnv = process.env): { tools: string[]; extensions: string[]; env: NodeJS.ProcessEnv; prompt: string } {
  const settings = integrationSettings(raw), tools: string[] = [], extensions: string[] = [], notes: string[] = [];
  if (["designer", "frontend"].includes(role)) for (const provider of DESIGN_PROVIDERS) {
    const bridge = settings.design?.[provider];
    if (!bridge || bridge.enabled === false) continue;
    tools.push(...bridge.tools); extensions.push(...(bridge.extensions ?? []));
    notes.push(`${provider}: configured bridge tools ${bridge.tools.join(", ") || "none"}. ${bridge.context ?? ""} Verify connection and document successful tool calls; configuration alone is not connection evidence.`);
  }
  const workerEnv: NodeJS.ProcessEnv = { [INTEGRATIONS_ENV]: JSON.stringify(settings) };
  if (["designer", "frontend", "qa"].includes(role) && settings.browser?.enabled) {
    const executable = detectBrave(settings.browser.executablePath, env);
    tools.push("factory_browser_qa", ...(settings.browser.tools ?? [])); extensions.push(...(settings.browser.extensions ?? []));
    if (executable) workerEnv[BRAVE_ENV] = executable;
    notes.push(`Browser QA: ${executable ? `Brave executable ${executable}` : "Brave unavailable"}. Use factory_browser_qa for real browser interactions and screenshots. Requires project-local playwright or @playwright/test. Missing tooling is untested, never pass. Evidence must include URL, browser, viewport, actions, observed results, console errors and screenshots. External browser bridges must launch Brave using the configured executable.`);
  }
  return { tools: [...new Set(tools)], extensions: [...new Set(extensions)].map(file => path.isAbsolute(file) ? file : path.resolve(cwd, file)), env: workerEnv, prompt: notes.join("\n") };
}
export function integrationDiagnostics(raw: unknown, cwd: string, availableTools: readonly string[] = []): Array<{ ok: boolean | "warn"; label: string; detail: string; fix?: string }> {
  const config = integrationSettings(raw), lines: Array<{ ok: boolean | "warn"; label: string; detail: string; fix?: string }> = [];
  for (const provider of DESIGN_PROVIDERS) {
    const bridge = config.design?.[provider];
    if (!bridge || bridge.enabled === false) continue;
    const missing = bridge.tools.filter(tool => !availableTools.includes(tool));
    const missingExtensions = (bridge.extensions ?? []).filter(file => !fs.existsSync(path.resolve(cwd, file)));
    lines.push({ ok: missing.length || missingExtensions.length || !bridge.tools.length ? "warn" : true, label: `${provider} design bridge`, detail: `configured (connection not probed); ${bridge.tools.length} tools${missing.length ? `; not loaded in host: ${missing.join(", ")}` : ""}${missingExtensions.length ? `; extension missing: ${missingExtensions.join(", ")}` : ""}`, fix: !bridge.tools.length ? "Configure exact tool names from your installed pi MCP bridge." : undefined });
  }
  if (config.browser?.enabled) {
    const brave = detectBrave(config.browser.executablePath);
    lines.push({ ok: brave ? true : "warn", label: "Brave browser QA", detail: brave ? `${brave} (launch not probed)` : "executable not found", fix: brave ? undefined : "Install Brave or configure integrations.browser.executablePath." });
    const require = createRequire(path.join(cwd, "package.json"));
    let runtime: string | undefined;
    for (const name of ["playwright", "@playwright/test"]) {
      try { runtime = require.resolve(name); break; } catch { /* optional dependency */ }
    }
    lines.push({ ok: runtime ? true : "warn", label: "browser automation runtime", detail: runtime ?? "project-local Playwright unavailable; browser acceptance checks will be untested", fix: runtime ? undefined : "Install playwright or @playwright/test in the application project to enable Brave QA." });
  }
  return lines;
}
