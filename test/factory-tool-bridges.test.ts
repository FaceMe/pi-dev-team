/** Verify registration, allowlisting and execution in the real pi agent loop. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PiSubprocessRunner } from "../src/factory/runner.js";
import { startMockOpenAI } from "./mock-openai.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piCli = path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

describe.skipIf(!fs.existsSync(piCli))("real pi tool bridges", () => {
  async function exercise(browser: boolean) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "factory-tool-bridges-"));
    const agentDir = path.join(cwd, "agent");
    fs.mkdirSync(agentDir);
    const extension = path.join(cwd, "design-bridge.ts");
    // The fixture is deliberately a real pi extension, not a mocked runner.
    fs.writeFileSync(extension, `export default function (pi) {
      pi.registerTool({name:"fixture_design_system",label:"Design reference",description:"Read reference tokens",
        parameters:{type:"object",properties:{},required:[]},
        async execute(){return {content:[{type:"text",text:'{"tokens":{"color":"#123456"},"source":"fixture"}'}],details:{source:"fixture"}};}});
      pi.registerTool({name:"fixture_unselected",label:"Excluded",description:"Must remain unavailable",
        parameters:{type:"object",properties:{},required:[]},async execute(){throw new Error("unexpected execution");}});
    }`);
    const html = path.join(cwd, "preview.html");
    fs.writeFileSync(html, `<button id="save">Save</button><p id="status">Ready</p><script>document.querySelector('#save').onclick=()=>document.querySelector('#status').textContent='Saved'</script>`);
    if (browser) fs.symlinkSync(path.join(process.env.PI_FACTORY_BROWSER_SMOKE!, "node_modules"), path.join(cwd, "node_modules"), "dir");
    const server = await startMockOpenAI((_messages, index) => {
      if (index === 0) return { tool: "fixture_design_system", args: {} };
      if (browser && index === 1) return { tool: "factory_browser_qa", args: { url: pathToFileURL(html).href, steps: [{ action: "click", selector: "#save" }, { action: "assertText", selector: "#status", value: "Saved" }] } };
      return { text: "Bridge tools executed." };
    });
    try {
      fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: server.url, api: "openai-completions", apiKey: "mock", models: [{ id: "mock-model", contextWindow: 128000, maxTokens: 4096 }] } } }));
      fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
      const runner = new PiSubprocessRunner({ ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_FACTORY_PI_BIN: piCli, PI_OFFLINE: "1", PI_TELEMETRY: "0" });
      const result = await runner.run({ role: "designer", member: { role: "designer", provider: "mock", modelId: "mock-model", tier: "daily", family: "mock" }, tools: ["read"], integrations: { design: { opendesign: { tools: ["fixture_design_system"], extensions: [extension] } }, ...(browser ? { browser: { enabled: true } } : {}) }, systemPrompt: "Use the configured tools.", prompt: "Read the reference; test the preview when available.", cwd, sessionId: crypto.randomUUID(), sessionDir: path.join(cwd, "sessions"), writeScope: [".factory/qa/browser/**"], timeoutMs: 45_000 });
      expect(result.isError, result.errorMessage ?? result.stderr).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(server.requests[0].tools).toContain("fixture_design_system");
      expect(server.requests[0].tools).not.toContain("fixture_unselected");
      expect(server.requests[0].tools).not.toContain("write");
      const toolReplies = server.requests.at(-1)!.messages.filter(message => message.role === "tool");
      expect(JSON.stringify(toolReplies)).toContain("#123456");
      if (browser) {
        expect(server.requests[0].tools).toContain("factory_browser_qa");
        const dir = path.join(cwd, ".factory/qa/browser");
        const evidence = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(name => name.endsWith(".json"))!), "utf8"));
        expect(evidence.status, JSON.stringify(evidence)).toBe("pass");
        expect(evidence.browser).toBe("Brave");
        expect(evidence.actions.at(-1).observed).toBe("Saved");
        expect(fs.statSync(evidence.screenshots[0]).size).toBeGreaterThan(0);
        const destination = path.join(process.env.PI_FACTORY_BROWSER_SMOKE!, "pi-worker-evidence");
        fs.mkdirSync(destination, { recursive: true });
        fs.copyFileSync(evidence.screenshots[0], path.join(destination, "screenshot.png"));
        fs.writeFileSync(path.join(destination, "evidence.json"), JSON.stringify({ ...evidence, screenshots: [path.join(destination, "screenshot.png")] }, null, 2));
      }
    } finally { await server.close(); fs.rmSync(cwd, { recursive: true, force: true }); }
  }
  it("exposes and executes selected extension tools through --tools", () => exercise(false), 60_000);
  it.skipIf(!process.env.PI_FACTORY_BROWSER_SMOKE)("executes Brave QA through a real worker and persists evidence", () => exercise(true), 60_000);
});
