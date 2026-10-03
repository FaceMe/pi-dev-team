import * as fs from "node:fs";
import * as path from "node:path";
import { FactoryStore } from "../src/factory/store.js";
import { tempDir } from "./helpers.js";
import { describe, expect, it } from "vitest";
import { browserEvidencePassed, persistBrowserEvidence } from "../src/factory/pipeline.js";
const pass = { status: "pass", browser: "Brave", actions: [{ action: "assertText", selector: "h1", value: "Welcome", result: "pass" }], screenshots: ["shot.png"], consoleErrors: [] };
describe("pipeline browser evidence gate", () => {
  it("accepts recorded passing actions with screenshots", () => expect(browserEvidencePassed(pass)).toBe(true));
  it.each([undefined, {}, { ...pass, actions: [] }, { ...pass, screenshots: [] }, { ...pass, status: "untested" }, { ...pass, actions: [{ result: "fail" }] }, { ...pass, consoleErrors: ["error"] }, { ...pass, browser: "Chrome" }, { ...pass, actions: [{ result: "pass" }] }, { ...pass, actions: [{ action: "assertText", selector: "h1", value: "", result: "pass" }] }])("rejects missing, untested or failed browser checks %j", (evidence) => expect(browserEvidencePassed(evidence)).toBe(false));
});

describe("durable browser evidence", () => {
  function fixture() {
    const cwd = tempDir("browser-evidence-");
    const store = new FactoryStore(cwd);
    const dir = path.join(cwd, "worktree/.factory/qa/browser");
    fs.mkdirSync(dir, { recursive: true });
    const screenshot = path.join(dir, "shot.png");
    fs.writeFileSync(screenshot, "actual screenshot bytes");
    fs.writeFileSync(path.join(dir, "record.json"), JSON.stringify({ ...pass, screenshots: [screenshot] }));
    return { cwd, store, dir, screenshot };
  }
  it("keeps current evidence usable after the temporary browser directory is deleted", () => {
    const f = fixture();
    const evidence = persistBrowserEvidence(f.store, f.dir, 2, Date.now() - 1000) as any[];
    expect(evidence.some(browserEvidencePassed)).toBe(true);
    fs.rmSync(f.dir, { recursive: true });
    expect(fs.readFileSync(evidence[0].screenshots[0], "utf8")).toBe("actual screenshot bytes");
    expect(JSON.parse(f.store.read("qa/browser-round-2/record.json")!).screenshots).toEqual(evidence[0].screenshots);
  });
  it("rejects stale records and stale screenshots in fresh records", () => {
    const f = fixture();
    const old = new Date(0);
    fs.utimesSync(path.join(f.dir, "record.json"), old, old);
    expect(persistBrowserEvidence(f.store, f.dir, 2, Date.now() - 1000)).toEqual([]);
    fs.writeFileSync(path.join(f.dir, "record.json"), JSON.stringify({ ...pass, screenshots: [f.screenshot] }));
    fs.utimesSync(f.screenshot, old, old);
    expect(persistBrowserEvidence(f.store, f.dir, 3, Date.now() - 1000).some(browserEvidencePassed)).toBe(false);
  });
  it("rejects screenshot paths that escape the browser artifact directory", () => {
    const f = fixture();
    const outside = path.join(f.cwd, "outside.png");
    fs.writeFileSync(outside, "outside bytes");
    fs.writeFileSync(path.join(f.dir, "record.json"), JSON.stringify({ ...pass, screenshots: [outside] }));
    expect(persistBrowserEvidence(f.store, f.dir, 2, Date.now() - 1000).some(browserEvidencePassed)).toBe(false);
  });
});

describe("configured browser verification", () => {
  it("runs exploratory QA when its flag is disabled and stores evidence before cleanup", async () => {
    const { execFileSync } = await import("node:child_process");
    const { FactoryRun, newState } = await import("../src/factory/pipeline.js");
    const { scriptedUi, ScriptedRunner } = await import("./factory-helpers.js");
    const cwd = tempDir("browser-verify-");
    execFileSync("git", ["init", "-q"], { cwd });
    const store = new FactoryStore(tempDir("browser-main-"));
    const answers = { autonomy: "auto", budgetUsd: 0, budgetTokens: 0, build: { exploratoryQa: false }, integrations: { browser: { enabled: true } } } as any;
    const state = newState("An add function", "browser-test", answers);
    state.phase = "verify";
    const { ui } = scriptedUi();
    const run = new FactoryRun({ cwd, store, answers, ui, runner: new ScriptedRunner({}), roles: new Map(), team: { members: {}, tiers: {} as any, notes: [] }, webAccess: false }, state) as any;
    run.ensureWorkspace = async () => cwd;
    run.profile = () => ({ stack: "Node", gates: [] });
    run.gates = async () => ({ ok: true, results: [] });
    run.hasWorker = () => true;
    let called = false;
    run.tryWorkJson = async () => {
      called = true;
      const directory = path.join(cwd, ".factory/qa/browser");
      fs.mkdirSync(directory, { recursive: true });
      const shot = path.join(directory, "screenshot.png");
      fs.writeFileSync(shot, "screenshot bytes");
      fs.writeFileSync(path.join(directory, "evidence.json"), JSON.stringify({ ...pass, screenshots: [shot] }));
      return { summary: "Browser checked", checks: [], bugs: [] };
    };
    await run.verify();
    expect(called).toBe(true);
    expect(state.tickets).toEqual([]);
    const evidence = JSON.parse(store.read("qa/browser-round-1/evidence.json")!);
    expect(browserEvidencePassed(evidence)).toBe(true);
    expect(fs.existsSync(evidence.screenshots[0])).toBe(true);
    expect(fs.existsSync(path.join(cwd, ".factory/qa/browser/screenshot.png"))).toBe(false);
  });
});
