/** Brave automation uses the project's Playwright, without installing software. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

export function detectBrave(explicit?: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | undefined {
  const override = explicit ?? env.PI_FACTORY_BRAVE_EXECUTABLE ?? env.BRAVE_EXECUTABLE_PATH;
  const executable = (file: string) => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };
  if (override) return executable(override) ? override : undefined;
  const candidates = platform === "darwin" ? ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", path.join(os.homedir(), "Applications/Brave Browser.app/Contents/MacOS/Brave Browser")]
    : platform === "win32" ? [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean).map(root => path.join(root!, "BraveSoftware/Brave-Browser/Application/brave.exe"))
    : ["/usr/bin/brave-browser", "/usr/bin/brave-browser-stable", "/snap/bin/brave"];
  for (const candidate of candidates) if (executable(candidate)) return candidate;
  try {
    const found = execFileSync(platform === "win32" ? "where" : "which", ["brave-browser"], { encoding: "utf8", timeout: 3000, env }).trim().split(/\r?\n/)[0];
    return executable(found) ? found : undefined;
  } catch { return undefined; }
}
export interface BrowserStep { action: "click" | "fill" | "press" | "assertText"; selector: string; value?: string }
export interface BrowserEvidence {
  status: "pass" | "fail" | "untested";
  browser: "Brave";
  executablePath?: string;
  url: string;
  viewport: { width: number; height: number };
  actions: Array<BrowserStep & { result: "pass" | "fail"; observed?: string }>;
  screenshots: string[];
  consoleErrors: string[];
  error?: string;
  evidencePath?: string;
}
export async function executeBrowserQa(args: { cwd: string; url: string; steps?: BrowserStep[]; width?: number; height?: number; executablePath?: string; signal?: AbortSignal; artifactDir?: string }, load?: () => Promise<any>): Promise<BrowserEvidence> {
  const evidence: BrowserEvidence = { status: "untested", browser: "Brave", executablePath: detectBrave(args.executablePath), url: args.url, viewport: { width: args.width ?? 1280, height: args.height ?? 800 }, actions: [], screenshots: [], consoleErrors: [] };
  let browser: any;
  try {
    const url = new URL(args.url);
    if (!["http:", "https:", "file:"].includes(url.protocol)) throw new Error("Use an http, https or file URL.");
    if (!evidence.executablePath) throw new Error("Brave executable unavailable; configure integrations.browser.executablePath.");
    const require = createRequire(path.join(args.cwd, "package.json"));
    let playwright: any;
    if (load) playwright = await load();
    else { try { playwright = require("playwright"); } catch { playwright = require("@playwright/test"); } }
    if (args.signal?.aborted) throw new Error("Browser QA aborted");
    browser = await playwright.chromium.launch({ executablePath: evidence.executablePath, headless: true });
    const abort = () => { void browser.close(); };
    args.signal?.addEventListener("abort", abort, { once: true });
    try {
      const page = await browser.newPage({ viewport: evidence.viewport });
      page.setDefaultTimeout(15_000);
      page.on("pageerror", (error: Error) => evidence.consoleErrors.push(error.message));
      page.on("console", (message: any) => { if (message.type() === "error") evidence.consoleErrors.push(message.text()); });
      page.on("response", (response: any) => { if (response.status() >= 400) evidence.consoleErrors.push(`HTTP ${response.status()} ${response.url()}`); });
      const response = await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (response && response.status() >= 400) throw new Error(`Navigation returned HTTP ${response.status()}`);
      evidence.status = args.steps?.some(step => step.action === "assertText" && !!step.value) ? "pass" : "untested";
      for (const step of args.steps ?? []) {
        try {
          const locator = page.locator(step.selector);
          if (step.action === "click") await locator.click();
          else if (step.action === "fill") await locator.fill(step.value ?? "");
          else if (step.action === "press") await locator.press(step.value ?? "Enter");
          else {
            if (!step.value) throw new Error("assertText requires non-empty expected text");
            await page.waitForFunction(({ selector, value }: { selector: string; value: string }) => Array.from(document.querySelectorAll(selector)).some(element => (element.textContent ?? "").includes(value)), { selector: step.selector, value: step.value ?? "" }, { timeout: 15_000 });
            const observed = await locator.innerText();
            if (!observed.includes(step.value ?? "")) throw new Error(`Expected ${JSON.stringify(step.value)}; observed ${JSON.stringify(observed)}`);
          }
          evidence.actions.push({ ...step, result: "pass", ...(step.action === "assertText" ? { observed: await locator.innerText() } : {}) });
        } catch (error) {
          evidence.actions.push({ ...step, result: "fail", observed: String(error) });
          evidence.status = "fail";
          break;
        }
      }
      if (args.artifactDir) fs.mkdirSync(args.artifactDir, { recursive: true });
      const scratch = fs.mkdtempSync(path.join(args.artifactDir ?? os.tmpdir(), "factory-browser-"));
      const screenshot = path.join(scratch, "screenshot.png");
      await page.screenshot({ path: screenshot, fullPage: true });
      evidence.screenshots.push(screenshot);
      if (evidence.consoleErrors.length) evidence.status = "fail";
    } finally { args.signal?.removeEventListener("abort", abort); }
  } catch (error) {
    evidence.error = String(error);
    evidence.status = browser ? "fail" : "untested";
  } finally { if (browser) await browser.close().catch(() => {}); }
  if (args.artifactDir) {
    fs.mkdirSync(args.artifactDir, { recursive: true });
    evidence.evidencePath = path.join(args.artifactDir, `evidence-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(evidence.evidencePath, JSON.stringify(evidence, null, 2));
  }
  return evidence;
}
