import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { Type } from "typebox";
import { executeBrowserQa } from "./browser.js";

/** Loaded explicitly by the runner only for configured browser workers. */
export default function browserExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "factory_browser_qa", label: "Brave QA",
    description: "Launch Brave through project-local Playwright, navigate, interact, assert text and capture screenshot plus console evidence. Unavailable browser or Playwright returns untested. Start the application's local server with bash first. Use CSS selectors. Include assertText with non-empty expected text to verify a result. Evidence is saved in .factory/qa/browser when write scope permits, otherwise in a temporary directory.",
    parameters: Type.Object({
      url: Type.String(), width: Type.Optional(Type.Integer({ minimum: 320, maximum: 3840 })), height: Type.Optional(Type.Integer({ minimum: 240, maximum: 2160 })),
      steps: Type.Optional(Type.Array(Type.Object({ action: Type.Union([Type.Literal("click"), Type.Literal("fill"), Type.Literal("press"), Type.Literal("assertText")]), selector: Type.String(), value: Type.Optional(Type.String()) }))),
    }),
    async execute(_id, params, signal, _update, ctx) {
      let scope: string[] = [];
      try { scope = JSON.parse(process.env.PI_FACTORY_WRITE_SCOPE ?? "[]"); } catch { /* read-only */ }
      const writable = scope.some(pattern => ["**", ".factory/**", ".factory/qa/**", ".factory/qa/browser/**"].includes(pattern));
      const evidence = await executeBrowserQa({ ...params, cwd: ctx.cwd, executablePath: process.env.PI_FACTORY_BRAVE_EXECUTABLE, signal, artifactDir: writable ? path.join(ctx.cwd, ".factory/qa/browser") : undefined });
      return { content: [{ type: "text", text: JSON.stringify(evidence, null, 2) }], details: evidence };
    },
  });
}
