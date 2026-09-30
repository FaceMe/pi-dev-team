/**
 * Fusion startup/toggle UI regressions: Fusion must start OFF every session
 * (even when fusion.json holds a stale enabled:true from an earlier session),
 * show no stats on any UI surface while disabled, and the wizard state toggle
 * must behave exactly like /fusion on|off.
 */

import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fusionExtension from "../src/fusion/extension.js";
import { fusionEnabledInSession } from "../src/picker/model-picker.js";
import { defaultFusionConfig, fusionConfigPath, saveFusionConfig } from "../src/shared/config.js";
import { fakeRegistry, fakeUi, makeModel, recordingPi, tempDir, useTempAgentDir } from "./helpers.js";

let agent: ReturnType<typeof useTempAgentDir>;
beforeEach(() => {
  agent = useTempAgentDir();
});
afterEach(() => agent.restore());

const price = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 });
const daily = makeModel({ id: "daily", provider: "a", cost: price(1, 4) });
const frontier = makeModel({ id: "frontier", provider: "c", reasoning: true, cost: price(5, 25) });
const all = [daily, frontier];

function boot(savedEnabled: boolean) {
  saveFusionConfig({
    ...defaultFusionConfig(),
    enabled: savedEnabled,
    main: { provider: "c", modelId: "frontier" },
    sidekick: { provider: "a", modelId: "daily" },
    sidekickTools: ["read", "grep", "find", "ls", "bash"],
  });
  const rec = recordingPi();
  rec.activeTools = ["read", "bash"];
  fusionExtension(rec.api);
  const { ui, notes } = fakeUi();
  const statuses: Array<string | undefined> = [];
  const widgets: Array<unknown> = [];
  const uiAny = ui as any;
  uiAny.setStatus = (_key: string, value?: string) => statuses.push(value);
  uiAny.setWidget = (_key: string, content: unknown) => widgets.push(content);
  const ctx: any = {
    hasUI: true,
    mode: "tui",
    ui,
    cwd: tempDir(),
    model: daily,
    modelRegistry: fakeRegistry(all),
    sessionManager: { getBranch: () => [] },
  };
  // Mirror pi: setModel switches the session's live model (ctx.model), so
  // /fusion off can hand the main slot back to the pre-fusion model.
  const originalSetModel = rec.api.setModel;
  rec.api.setModel = async (model: any) => {
    const ok = await originalSetModel(model);
    ctx.model = model;
    return ok;
  };
  return { rec, ctx, statuses, widgets, notes };
}

async function start(rec: any, ctx: any) {
  for (const handler of rec.handlers.get("session_start") ?? []) await handler({}, ctx);
}

const last = (list: Array<any>) => list.at(-1);

describe("fusion default-off startup", () => {
  it("starts off with an empty config and leaves the session model and tools alone", async () => {
    const { rec, ctx, statuses, widgets } = boot(false);
    await start(rec, ctx);
    expect(rec.setModelCalls).toHaveLength(0);
    expect(rec.activeTools).toEqual(["read", "bash"]);
    expect(last(statuses)).toBeUndefined();
    expect(last(widgets)).toBeUndefined();
  });

  it("a stale enabled:true still starts off, preserving the saved slots and tools", async () => {
    const { rec, ctx, statuses, widgets } = boot(true);
    await start(rec, ctx);
    expect(rec.setModelCalls).toHaveLength(0);
    expect(rec.activeTools).toEqual(["read", "bash"]);
    expect(last(statuses)).toBeUndefined();
    expect(last(widgets)).toBeUndefined();
    const saved = JSON.parse(fs.readFileSync(fusionConfigPath(), "utf8"));
    expect(saved.enabled).toBe(true); // untouched on disk; the session simply ignores it
    expect(saved.main).toEqual({ provider: "c", modelId: "frontier" });
    expect(saved.sidekick).toEqual({ provider: "a", modelId: "daily" });
    expect(saved.sidekickTools).toContain("bash");
  });

  it("refreshes after turn_end and widget edits keep the stats UI absent while disabled", async () => {
    const { rec, ctx, statuses, widgets } = boot(true);
    await start(rec, ctx);
    for (const handler of rec.handlers.get("turn_end") ?? []) {
      await handler(
        {
          message: {
            role: "assistant",
            usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
          },
        },
        ctx,
      );
    }
    await rec.commands.get("fusion").handler("widget full", ctx);
    await new Promise((r) => setTimeout(r, 350)); // let the throttled usage refresh land
    expect(statuses.every((s) => s === undefined)).toBe(true);
    expect(widgets.every((w) => w === undefined)).toBe(true);
  });
});

describe("fusion on/off surfaces", () => {
  it("/fusion on shows footer status and widget; /fusion off clears both and restores the model", async () => {
    const { rec, ctx, statuses, widgets } = boot(true);
    await start(rec, ctx);
    await rec.commands.get("fusion").handler("on", ctx);
    expect(rec.activeTools).toEqual(expect.arrayContaining(["sidekick", "sidekick_wait"]));
    expect(last(statuses)).toMatch(/⚛ fusion/);
    expect(typeof last(widgets)).toBe("function");
    await rec.commands.get("fusion").handler("off", ctx);
    expect(last(statuses)).toBeUndefined();
    expect(last(widgets)).toBeUndefined();
    expect(rec.activeTools).toEqual(["read", "bash"]);
    expect(rec.setModelCalls.map((m: any) => m.id)).toEqual(["frontier", "daily"]);
  });

  it("the model picker reads live state instead of a saved enabled:true", async () => {
    const { rec, ctx } = boot(true);
    await start(rec, ctx);
    expect(fusionEnabledInSession(rec.api)).toBe(false);
    await rec.commands.get("fusion").handler("on", ctx);
    expect(fusionEnabledInSession(rec.api)).toBe(true);
    await rec.commands.get("fusion").handler("off", ctx);
    expect(fusionEnabledInSession(rec.api)).toBe(false);
    expect(fusionEnabledInSession(recordingPi().api)).toBe(false);
  });

  it("widget off hides the widget but keeps the footer status while enabled", async () => {
    const { rec, ctx, statuses, widgets } = boot(true);
    await start(rec, ctx);
    await rec.commands.get("fusion").handler("on", ctx);
    await rec.commands.get("fusion").handler("widget off", ctx);
    expect(last(statuses)).toMatch(/⚛ fusion/);
    expect(last(widgets)).toBeUndefined();
  });

  it("shutdown restores strict-mode tools before a default-off reload", async () => {
    const { rec, ctx } = boot(false);
    rec.activeTools = ["read", "bash", "edit", "write"];
    await start(rec, ctx);
    await rec.commands.get("fusion").handler("mode strict", ctx);
    await rec.commands.get("fusion").handler("on", ctx);
    expect(rec.activeTools).not.toContain("edit");
    for (const handler of rec.handlers.get("session_shutdown") ?? []) await handler({});
    expect(rec.activeTools).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));
    expect(rec.activeTools).not.toContain("sidekick");
    expect(fusionEnabledInSession(rec.api)).toBe(false);
  });

  it("session_shutdown clears the Fusion UI", async () => {
    const { rec, ctx, statuses, widgets } = boot(true);
    await start(rec, ctx);
    await rec.commands.get("fusion").handler("on", ctx);
    for (const handler of rec.handlers.get("session_shutdown") ?? []) await handler({});
    expect(last(statuses)).toBeUndefined();
    expect(last(widgets)).toBeUndefined();
  });
});

describe("fusion toggles", () => {
  it("a factory worker whose role asked for its own sidekick stays opted in", async () => {
    process.env.PI_FACTORY_WORKER = "1";
    process.env.PI_FACTORY_SIDEKICK = "1";
    try {
      for (const savedEnabled of [true, false]) {
        const { rec, ctx, statuses } = boot(savedEnabled);
        await start(rec, ctx);
        expect(rec.activeTools).toEqual(expect.arrayContaining(["sidekick"]));
        expect(last(statuses)).toMatch(/⚛ fusion/);
        for (const handler of rec.handlers.get("session_shutdown") ?? []) await handler({});
      }
    } finally {
      delete process.env.PI_FACTORY_WORKER;
      delete process.env.PI_FACTORY_SIDEKICK;
    }
  });

  it("the wizard state toggle mirrors /fusion on|off: tools, model sync and UI", async () => {
    const { rec, ctx, statuses, widgets } = boot(false);
    await start(rec, ctx);
    const picks = ["state: enabled", "state: disabled", "done"];
    ctx.ui.select = async () => picks.shift() ?? "done";
    await rec.commands.get("fusion").handler("", ctx);
    expect(rec.setModelCalls.map((m: any) => m.id)).toEqual(["frontier", "daily"]);
    expect(statuses.some((s) => typeof s === "string" && s.includes("⚛"))).toBe(true);
    expect(last(statuses)).toBeUndefined();
    expect(last(widgets)).toBeUndefined();
    expect(rec.activeTools).toEqual(["read", "bash"]);
  });
});
