import { describe, it, expect, vi, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectBrave, executeBrowserQa } from "../src/factory/browser.js";
import { integrationSettings, integrationWorkerConfig } from "../src/factory/integrations.js";
import { buildWorkerArgs } from "../src/factory/runner.js";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "factory-integrations-test-"));
const executable = path.join(cwd, "brave");
fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));
const config = { design: { paper: { tools: ["bridge_paper"], extensions: ["bridge.ts"] }, doop: { tools: ["bridge_doop"] } }, browser: { enabled: true, executablePath: executable } };

describe("optional integrations", () => {
  it("normalizes multiple providers without guessing tool names", () => {
    expect(integrationSettings(config).design?.paper?.tools).toEqual(["bridge_paper"]);
    expect(integrationSettings({ design: { paper: { tools: [42, " a ", "a"] } } }).design?.paper?.tools).toEqual(["a"]);
    expect(integrationSettings(undefined)).toEqual({});
  });
  it("adds bridge tools/extensions only to the relevant worker", () => {
    expect(integrationWorkerConfig("designer", config, cwd).tools).toEqual(["bridge_paper", "bridge_doop", "factory_browser_qa"]);
    expect(integrationWorkerConfig("backend", config, cwd).tools).toEqual([]);
    expect(integrationWorkerConfig("qa", config, cwd).tools).toEqual(["factory_browser_qa"]);
    const args = buildWorkerArgs({ role: "designer", integrations: config, member: { role: "designer", provider: "x", modelId: "y", tier: "daily", family: "x" }, tools: ["read"], systemPrompt: "", prompt: "", cwd, sessionId: "s", sessionDir: cwd, writeScope: [] }, "prompt.md");
    expect(args).toContain(path.join(cwd, "bridge.ts"));
    expect(args).toContain("read,bridge_paper,bridge_doop,factory_browser_qa");
    expect(args.some(arg => arg.endsWith("browser-extension.ts"))).toBe(true);
  });
  it("respects an invalid explicit executable instead of silently replacing it", () => {
    expect(detectBrave(executable)).toBe(executable);
    expect(detectBrave("/no/such/brave")).toBeUndefined();
  });
});

function fakeBrowser(status = 200, text = "Saved") {
  const close = vi.fn(async () => {});
  const page = { setDefaultTimeout: vi.fn(), on: vi.fn(), goto: vi.fn(async () => ({ status: () => status })), waitForFunction: vi.fn(async () => {}), locator: () => ({ click: vi.fn(async () => {}), innerText: vi.fn(async () => text) }), screenshot: vi.fn(async ({ path: file }: { path: string }) => fs.writeFileSync(file, "png")) };
  const launch = vi.fn(async () => ({ newPage: async () => page, close }));
  return { close, launch, page, load: async () => ({ chromium: { launch } }) };
}
describe("Brave evidence", () => {
  it("launches selected executable and persists actual actions/screenshots", async () => {
    const fake = fakeBrowser();
    const evidence = await executeBrowserQa({ cwd, url: "http://localhost:3000", executablePath: executable, artifactDir: path.join(cwd, "evidence"), steps: [{ action: "assertText", selector: "#status", value: "Saved" }] }, fake.load);
    expect(fake.launch).toHaveBeenCalledWith({ executablePath: executable, headless: true });
    expect(evidence.status).toBe("pass");
    expect(evidence.actions[0].result).toBe("pass");
    expect(fs.existsSync(evidence.screenshots[0])).toBe(true);
    expect(fs.existsSync(evidence.evidencePath!)).toBe(true);
    expect(fake.close).toHaveBeenCalled();
  });
  it("marks missing dependencies untested and HTTP failures fail", async () => {
    const missing = await executeBrowserQa({ cwd, url: "http://localhost:3000", executablePath: executable }, async () => { throw new Error("missing playwright"); });
    expect(missing.status).toBe("untested");
    const fake = fakeBrowser(500);
    expect((await executeBrowserQa({ cwd, url: "http://localhost:3000", executablePath: executable }, fake.load)).status).toBe("fail");
    expect(fake.close).toHaveBeenCalled();
  });
  it("does not count navigation alone as acceptance coverage", async () => {
    const fake = fakeBrowser();
    expect((await executeBrowserQa({ cwd, url: "http://localhost:3000", executablePath: executable }, fake.load)).status).toBe("untested");
  });
  it("requires a nonempty assertion for acceptance", async () => {
    const fake = fakeBrowser();
    expect((await executeBrowserQa({ cwd, url: "http://localhost:3000", executablePath: executable, steps: [{ action: "click", selector: "#save" }] }, fake.load)).status).toBe("untested");
    expect((await executeBrowserQa({ cwd, url: "http://localhost:3000", executablePath: executable, steps: [{ action: "assertText", selector: "#status", value: "" }] }, fake.load)).status).toBe("fail");
  });
  it("fails on browser console errors and HTTP resource errors", async () => {
    const fake = fakeBrowser();
    fake.page.goto.mockImplementation(async () => {
      const handlers = fake.page.on.mock.calls;
      handlers.find(call => call[0] === "console")?.[1]({ type: () => "error", text: () => "broken script" });
      handlers.find(call => call[0] === "response")?.[1]({ status: () => 404, url: () => "http://localhost/missing.js" });
      return { status: () => 200 };
    });
    const evidence = await executeBrowserQa({ cwd, url: "http://localhost:3000", executablePath: executable, steps: [{ action: "assertText", selector: "#status", value: "Saved" }] }, fake.load);
    expect(evidence.status).toBe("fail");
    expect(evidence.consoleErrors).toEqual(["broken script", "HTTP 404 http://localhost/missing.js"]);
  });
  it("reports assertion failures with observed text", async () => {
    const fake = fakeBrowser(200, "Error");
    const evidence = await executeBrowserQa({ cwd, url: "http://localhost:3000", executablePath: executable, steps: [{ action: "assertText", selector: "#status", value: "Saved" }] }, fake.load);
    expect(evidence.status).toBe("fail");
    expect(evidence.actions[0].observed).toContain("Error");
  });
});

it.skipIf(!process.env.PI_FACTORY_BROWSER_SMOKE)("real Brave smoke", async () => {
  const html = path.join(cwd, "smoke.html");
  fs.writeFileSync(html, `<button id="save">Save</button><p id="status">Ready</p><script>document.querySelector('#save').onclick=()=>document.querySelector('#status').textContent='Saved'</script>`);
  const evidence = await executeBrowserQa({ cwd: process.env.PI_FACTORY_BROWSER_SMOKE!, url: new URL(`file://${html}`).href, artifactDir: path.join(process.env.PI_FACTORY_BROWSER_SMOKE!, "evidence"), steps: [{ action: "click", selector: "#save" }, { action: "assertText", selector: "#status", value: "Saved" }] });
  expect(evidence.status, JSON.stringify(evidence)).toBe("pass");
  expect(evidence.screenshots).toHaveLength(1);
});
