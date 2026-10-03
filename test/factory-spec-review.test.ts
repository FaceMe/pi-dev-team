import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FactoryRun, newState, StopRun } from "../src/factory/pipeline.js";
import type { PipelineDeps } from "../src/factory/pipeline.js";
import { FactoryStore } from "../src/factory/store.js";
import type { SetupAnswers } from "../src/factory/types.js";
import { ScriptedRunner, scriptedUi } from "./factory-helpers.js";
import { tempDir } from "./helpers.js";

const draft = "# Spec\n\nFR-001 Add numbers.\nGiven 1 and 2 When added Then return 3. Source: brief.\n";
function fixture(choices: string[]) {
  const cwd = tempDir("spec-review-");
  const store = new FactoryStore(cwd);
  store.write("spec/spec.md", draft);
  const answers = { autonomy: "auto", budgetUsd: 0, budgetTokens: 0 } as SetupAnswers;
  const state = newState("adder", "review", answers);
  state.phase = "spec";
  state.notes.push("spec:written");
  const { ui, notes } = scriptedUi({ select: () => choices.shift() });
  const viewed: string[] = [];
  ui.viewSpec = async (text) => { viewed.push(text); };
  const deps = { cwd, store, ui, answers, runner: new ScriptedRunner({}), roles: new Map(), team: { members: {}, tiers: {}, notes: [] }, webAccess: false } as unknown as PipelineDeps;
  const run = new FactoryRun(deps, state);
  return { run, store, ui, viewed, notes, review: () => (run as any).spec() as Promise<void> };
}
describe("terminal spec review", () => {
  it("shows full amended content again and saves the approved snapshot", async () => {
    const f = fixture(["Edit draft…", "Approve"]);
    f.ui.editSpec = async () => draft.replace("return 3", "return exactly 3");
    await f.review();
    expect(f.viewed).toEqual([draft, draft.replace("return 3", "return exactly 3")]);
    expect(f.store.read("spec/approved.md")).toBe(f.viewed[1]);
  });
  it("amendment requests redisplay the revised draft and validation", async () => {
    const f = fixture(["Request changes…", "Approve"]);
    f.ui.input = async () => "add export";
    (f.run as any).writeSpec = async (feedback: string) => {
      expect(feedback).toBe("add export");
      f.store.write("spec/spec.md", draft + "\nFR-002 Export. Given a result When exported Then write CSV. Source: brief.\n");
    };
    await f.review();
    expect(f.viewed[1]).toContain("FR-002");
    expect(JSON.parse(f.store.read("spec/validation.json")!)).toHaveProperty("ok");
  });
  it("cancelling editing preserves the original draft", async () => {
    const f = fixture(["Edit draft…", "Approve"]);
    f.ui.editSpec = async () => undefined;
    await f.review();
    expect(f.store.read("spec/spec.md")).toBe(draft);
  });
  it("rejects stale approval and shows the external change", async () => {
    const f = fixture(["Approve", "Approve"]);
    f.ui.select = async () => {
      if (f.viewed.length === 1) f.store.write("spec/spec.md", draft + "\nNFR-001 Under 100 ms.\n");
      return "Approve";
    };
    await f.review();
    expect(f.viewed).toHaveLength(2);
    expect(f.store.read("spec/approved.md")).toBe(f.viewed[1]);
    expect(f.notes.join(" ")).toContain("changed during review");
  });
  it("persists invalid amendments for recovery without approving them", async () => {
    const f = fixture(["Edit draft…", "Approve", "Pause the factory"]);
    f.ui.editSpec = async () => "# Incomplete draft";
    await expect(f.review()).rejects.toBeInstanceOf(StopRun);
    expect(f.store.read("spec/spec.md")).toBe("# Incomplete draft\n");
    expect(f.store.read("spec/approved.md")).toBeUndefined();
    expect(f.notes.join(" ")).toContain("before approval");
  });
  it("does not approve requirements missing When and Then", async () => {
    const f = fixture(["Approve", "Pause the factory"]);
    f.store.write("spec/spec.md", "FR-001 Add numbers. Given 1 and 2. Source: brief.");
    await expect(f.review()).rejects.toBeInstanceOf(StopRun);
    expect(f.store.read("spec/approved.md")).toBeUndefined();
    expect(f.notes.join(" ")).toContain("Given/When/Then");
  });
  it("headless selection pauses and keeps the draft ready for resume", async () => {
    const f = fixture([]);
    await expect(f.review()).rejects.toBeInstanceOf(StopRun);
    expect(f.store.read("spec/spec.md")).toBe(draft);
    expect(f.store.read("spec/approved.md")).toBeUndefined();
  });
  it("removes a stale approved snapshot when resumed with an invalid draft", async () => {
    const f = fixture(["Pause the factory"]);
    f.store.write("spec/approved.md", draft);
    f.store.write("spec/spec.md", "FR-001 Given broken draft.");
    await expect(f.review()).rejects.toBeInstanceOf(StopRun);
    expect(f.store.read("spec/approved.md")).toBeUndefined();
  });

  it("copies design handoff and binary assets without following symlinks", () => {
    const f = fixture([]);
    f.store.write("design/handoff.md", "Build semantic components");
    const assets = f.store.path("design/assets");
    fs.mkdirSync(assets, { recursive: true });
    const pixels = Buffer.from([0, 255, 128, 10, 0]);
    fs.writeFileSync(path.join(assets, "image.png"), pixels);
    fs.symlinkSync(f.store.path("spec/spec.md"), path.join(assets, "escaped.md"));
    const worktree = tempDir("design-copy-");
    (f.run as any).copyDocsInto(worktree);
    expect(fs.readFileSync(path.join(worktree, "docs/design/assets/image.png"))).toEqual(pixels);
    expect(fs.readFileSync(path.join(worktree, "docs/design/handoff.md"), "utf8")).toContain("semantic components");
    expect(fs.existsSync(path.join(worktree, "docs/design/assets/escaped.md"))).toBe(false);
  });

  it("refuses a design destination symlink outside the worktree", () => {
    const f = fixture([]);
    f.store.write("design/handoff.md", "handoff");
    const worktree = tempDir("design-destination-");
    fs.mkdirSync(path.join(worktree, "docs"));
    const outside = tempDir("design-outside-");
    fs.symlinkSync(outside, path.join(worktree, "docs/design"));
    expect(() => (f.run as any).copyDocsInto(worktree)).toThrow("symbolic link");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

});
