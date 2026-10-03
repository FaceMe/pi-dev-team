import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveRolesState } from "../src/shared/config.js";
import {
  decayedScore,
  loadModelUsage,
  rankQuickModels,
  recordModelEffort,
  recordModelUse,
  USAGE_HALF_LIFE_MS,
} from "../src/shared/recents.js";
import modelPicker, { resolveQuickSlots, SplitModelPickerComponent } from "../src/picker/model-picker.js";
import { quickSlotFromKey, renderQuickTable } from "../src/picker/quick-table.js";
import { fakeRegistry, fakeUi, makeModel, recordingPi, useTempAgentDir } from "./helpers.js";

let agent: ReturnType<typeof useTempAgentDir>;
beforeEach(() => {
  agent = useTempAgentDir();
});
afterEach(() => agent.restore());

const DAY = 24 * 60 * 60 * 1000;
const all = () => true;

describe("model usage store", () => {
  it("ranks by frecency: frequent beats a single recent use, old use fades", () => {
    const now = 100 * DAY;
    for (let i = 0; i < 5; i++) recordModelUse("p", "daily-driver", "high", now - 2 * DAY + i);
    recordModelUse("p", "once-today", undefined, now);
    recordModelUse("p", "ancient", undefined, now - 60 * DAY);

    const ranked = rankQuickModels(all, { now }).map((r) => r.modelId);
    expect(ranked).toEqual(["daily-driver", "once-today", "ancient"]);

    const entry = loadModelUsage().models["p/daily-driver"];
    expect(entry.count).toBe(5);
    expect(entry.effort).toBe("high");
    expect(decayedScore(entry, entry.lastUsed + USAGE_HALF_LIFE_MS)).toBeCloseTo(entry.score / 2);
  });

  it("keeps the last effort, and effort changes do not count as uses", () => {
    recordModelUse("p", "m", "low");
    recordModelEffort("p", "m", "xhigh");
    recordModelUse("p", "m");
    const entry = loadModelUsage().models["p/m"];
    expect(entry.effort).toBe("xhigh");
    expect(entry.count).toBe(2);
  });

  it("caps at 8, skips missing models and pads with roles without duplicates", () => {
    for (let i = 0; i < 6; i++) recordModelUse("p", `m${i}`);
    recordModelUse("p", "gone");
    saveRolesState({
      roles: {
        daily: { provider: "p", modelId: "m0", effort: "medium" },
        frontier: { provider: "p", modelId: "big", effort: "high" },
        small: { provider: "p", modelId: "tiny" },
      },
    });
    const ranked = rankQuickModels((ref) => ref.modelId !== "gone");
    expect(ranked).toHaveLength(8);
    expect(ranked.map((r) => r.modelId)).not.toContain("gone");
    expect(ranked.filter((r) => r.modelId === "m0")).toHaveLength(1);
    expect(ranked.slice(6).map((r) => r.modelId)).toEqual(["big", "tiny"]);
  });
});

describe("quick table", () => {
  const big = makeModel({ id: "claude-big", provider: "anthropic", reasoning: true, contextWindow: 1_000_000 });
  const small = makeModel({ id: "flash", provider: "google", contextWindow: 128_000 });
  const slots = [
    { model: big, effort: "high", source: "used", uses: 14, lastUsed: 1_000_000 - 2 * 3600_000 },
    { model: small, effort: "off", source: "small role", uses: 0, lastUsed: 0 },
  ];

  it("shows all 8 rows with key, model, provider, effort, uses, recency and why", () => {
    const lines = renderQuickTable(slots, { width: 120, activeKey: "anthropic/claude-big", now: 1_000_000, platform: "linux", openKey: "Ctrl+Q" });
    expect(lines[0]).toMatch(/QUICK MODELS\s+Ctrl\+Q · Alt\+1…8$/);
    expect(lines[2]).toMatch(/^ +1  Alt\+1  ● claude-big\s+anthropic\s+high\s+14  2h ago\s+1M  used/);
    expect(lines[3]).toMatch(/2  Alt\+2    flash\s+google\s+off\s+0  never\s+128k  small role/);
    expect(lines.slice(2, 10)).toHaveLength(8);
    expect(lines[9]).toMatch(/8  Alt\+8    —/);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(120);
  });

  it("drops less important columns at narrow widths but keeps the model", () => {
    const lines = renderQuickTable(slots, { width: 44, platform: "darwin" });
    expect(lines[1]).toMatch(/Model/);
    expect(lines[1]).not.toMatch(/Why|Context/);
    expect(lines[2]).toContain("claude-big");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(44);
  });

  it("maps Alt+digit encodings and (optionally) macOS Option characters to slots", () => {
    expect(quickSlotFromKey("\x1b3")).toBe(2);
    expect(quickSlotFromKey("\x1b[51;3u")).toBe(2);
    expect(quickSlotFromKey("£")).toBeUndefined();
    expect(quickSlotFromKey("£", { macOption: true })).toBe(2);
    expect(quickSlotFromKey("•", { macOption: true })).toBe(7);
  });
});

describe("quick slots in pi", () => {
  const reasoning = makeModel({ id: "thinker", provider: "a", reasoning: true });
  const plain = makeModel({ id: "plain", provider: "b" });
  const models = [reasoning, plain];

  function setup() {
    const rec = recordingPi();
    let level = "medium";
    rec.api.getThinkingLevel = () => level;
    rec.api.setThinkingLevel = (l: string) => {
      level = l;
      rec.thinkingLevels.push(l);
    };
    modelPicker(rec.api);
    const { ui, notes, selects } = fakeUi();
    const ctx: any = { model: plain, modelRegistry: fakeRegistry(models), ui, hasUI: true, mode: "tui" };
    return { rec, ctx, notes, selects };
  }

  const fire = (rec: any, event: string, payload: any, ctx: any) =>
    rec.handlers.get(event)?.forEach((h: any) => h(payload, ctx));

  it("records explicit switches but not restores or cycling", () => {
    const { rec, ctx } = setup();
    fire(rec, "model_select", { model: reasoning, source: "set" }, ctx);
    fire(rec, "model_select", { model: plain, source: "restore" }, ctx);
    fire(rec, "model_select", { model: plain, source: "cycle" }, ctx);
    fire(rec, "thinking_level_select", { level: "high" }, { ...ctx, model: reasoning });
    expect(Object.keys(loadModelUsage().models)).toEqual(["a/thinker"]);
    expect(loadModelUsage().models["a/thinker"].effort).toBe("high");
  });

  it("/quick <n> switches model and restores its last effort", async () => {
    recordModelUse("a", "thinker", "high");
    const { rec, ctx } = setup();
    await rec.commands.get("quick").handler("1", ctx);
    expect(rec.setModelCalls).toEqual([reasoning]);
    expect(rec.thinkingLevels).toEqual(["high"]);
  });

  it("/quick without args opens the table; a digit switches straight away", async () => {
    recordModelUse("a", "thinker", "high");
    recordModelUse("b", "plain");
    recordModelUse("b", "plain");
    const { rec, ctx } = setup();
    let rendered: string[] = [];
    ctx.ui.custom = (factory: any) =>
      new Promise((resolve) => {
        const table = factory({ requestRender: () => undefined }, { fg: (_c: string, t: string) => t }, {}, resolve);
        rendered = table.render(120);
        table.handleInput("2");
      });
    await rec.commands.get("quick").handler("", ctx);
    const text = rendered.join("\n");
    expect(text).toMatch(/QUICK MODELS/);
    expect(text).toMatch(/#\s+Key\s+Model\s+Provider\s+Effort\s+Uses\s+Last used/);
    expect(text).toMatch(/1\s+\S+\s+● plain\s+b\s+off\s+2\s+just now/);
    expect(text).toMatch(/2\s+\S+\s+thinker\s+a\s+high\s+1/);
    expect(rec.setModelCalls).toEqual([reasoning]);
    expect(rec.thinkingLevels).toEqual(["high"]);
  });

  it("registers a shortcut that opens the table in any terminal", () => {
    const { rec } = setup();
    const expected = process.platform === "win32" ? "alt+m" : "ctrl+q";
    if (!process.env.WSL_DISTRO_NAME) expect(rec.shortcuts.has(expected)).toBe(true);
    expect([...rec.shortcuts.keys()]).toEqual(expect.arrayContaining(["alt+1", "alt+8"]));
  });

  it("macOS: Option+digit characters switch slots only while the editor is empty", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      recordModelUse("a", "thinker", "low");
      const { rec, ctx } = setup();
      let listener: ((data: string) => any) | undefined;
      let editor = "";
      ctx.ui.onTerminalInput = (handler: any) => ((listener = handler), () => undefined);
      ctx.ui.getEditorText = () => editor;
      for (const h of rec.handlers.get("session_start") ?? []) h({}, ctx);
      expect(listener).toBeDefined();

      editor = "costs 3";
      expect(listener!("£")).toBeUndefined(); // typing a pound sign in a message
      editor = "";
      expect(listener!("x")).toBeUndefined();
      expect(listener!("¡")).toEqual({ consume: true });
      await new Promise((r) => setTimeout(r, 0));
      expect(rec.setModelCalls).toEqual([reasoning]);
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });

  it("warns on an empty slot", async () => {
    const { rec, ctx, notes } = setup();
    await rec.commands.get("quick").handler("3", ctx);
    expect(rec.setModelCalls).toEqual([]);
    expect(notes[0].message).toMatch(/Quick slot 3 is empty/);
  });

  it("Alt+N in the picker selects the quick slot and shows the ribbon", async () => {
    recordModelUse("a", "thinker", "low");
    const { rec, ctx } = setup();
    expect(resolveQuickSlots(ctx).map((s) => s.model.id)).toEqual(["thinker"]);

    let result: any = null;
    const theme = { fg: (_c: string, t: string) => t };
    const tui = { requestRender: () => undefined };
    const picker = new SplitModelPickerComponent(tui, theme, (r) => (result = r), ctx, rec.api, { target: "session" });
    expect(picker.render(160).join("\n")).toContain("⌥1 thinker (low)");

    picker.handleInput("\x1b1");
    await new Promise((r) => setTimeout(r, 0));
    expect(rec.setModelCalls).toEqual([reasoning]);
    expect(result?.model).toBe(reasoning);
    expect(result?.effort).toBe("low");
  });
});
