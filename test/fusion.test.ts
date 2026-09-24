import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { defaultFusionConfig, saveFusionConfig } from "../src/shared/config.js";
import {
  buildTranscript,
  FusionEngine,
  heuristicClassify,
  parseClassifierJson,
  trimTranscript,
} from "../src/fusion/engine.js";
import fusionExtension, { fusionAllowedInProcess } from "../src/fusion/extension.js";
import { fakeRegistry, fakeUi, makeModel, recordingPi, tempDir, useTempAgentDir } from "./helpers.js";

let agent: ReturnType<typeof useTempAgentDir>;
beforeEach(() => {
  agent = useTempAgentDir();
});
afterEach(() => agent.restore());

const price = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 });
const small = makeModel({ id: "small", provider: "a", cost: price(0.1, 0.4) });
const daily = makeModel({ id: "daily", provider: "b", cost: price(1, 4) });
const frontier = makeModel({ id: "frontier", provider: "c", reasoning: true, cost: price(5, 25) });
const all = [small, daily, frontier];

function engineWith(liveModel = frontier) {
  const rec = recordingPi();
  const config = {
    ...defaultFusionConfig(),
    main: { provider: "c", modelId: "frontier" },
    sidekick: { provider: "a", modelId: "small" },
  };
  const engine = new FusionEngine(rec.api, fakeRegistry(all), tempDir(), config);
  const ctx: any = { model: liveModel };
  engine.setContext(ctx);
  return { engine, rec, ctx };
}

describe("routing (B1)", () => {
  it("measures the main slot from the live session model, so it can move back up", async () => {
    const { engine, rec, ctx } = engineWith(frontier);

    const down = await engine.applyRouting({ difficulty: 1, main: "downgrade", sidekick: "keep", reason: "easy" }, "compact");
    expect(down[0]).toMatchObject({ from: "c/frontier", to: "b/daily", applied: true });
    ctx.model = rec.setModelCalls.at(-1);

    const downAgain = await engine.applyRouting({ difficulty: 1, main: "downgrade", sidekick: "keep", reason: "easy" }, "compact");
    expect(downAgain[0]).toMatchObject({ from: "b/daily", to: "a/small" });
    ctx.model = rec.setModelCalls.at(-1);

    const up = await engine.applyRouting({ difficulty: 5, main: "upgrade", sidekick: "keep", reason: "hard" }, "compact");
    expect(up[0]).toMatchObject({ from: "a/small", to: "b/daily", applied: true });
  });

  it("records only routing-driven sidekick changes in the session (B4)", async () => {
    const { engine, rec } = engineWith();
    engine.setSidekickModel(daily, "low");
    expect(rec.entries.filter((e) => e.type === "fusion-sidekick")).toHaveLength(0);
    await engine.applyRouting({ difficulty: 5, main: "keep", sidekick: "upgrade", reason: "struggling" }, "escalation");
    expect(rec.entries.filter((e) => e.type === "fusion-sidekick")).toHaveLength(1);
  });

  it("only suggests when auto-apply is off", async () => {
    const { engine, rec } = engineWith();
    engine.config.routing.autoApply = false;
    const records = await engine.applyRouting({ difficulty: 1, main: "downgrade", sidekick: "keep", reason: "x" }, "manual");
    expect(records[0].applied).toBe(false);
    expect(rec.setModelCalls).toHaveLength(0);
  });

  it("falls back to logged-in tiers when no slots are configured", () => {
    const rec = recordingPi();
    const engine = new FusionEngine(rec.api, fakeRegistry(all), tempDir(), defaultFusionConfig());
    expect(engine.resolveMainModel()?.id).toBe("frontier");
    expect(engine.resolveSidekickModel()?.id).toBe("small");
  });
});

describe("classifier helpers", () => {
  it("parses JSON replies and clamps difficulty", () => {
    const decision = parseClassifierJson({ content: [{ type: "text", text: 'ok {"difficulty":9,"main":"upgrade","sidekick":"nope"}' }] });
    expect(decision).toMatchObject({ difficulty: 5, main: "upgrade", sidekick: "keep" });
    expect(parseClassifierJson({ content: "no json" })).toBeNull();
  });

  it("scores hard and easy signals", () => {
    expect(heuristicClassify("investigate the race condition root cause", 0).main).toBe("upgrade");
    expect(heuristicClassify("fix a typo and rename", 0).main).toBe("downgrade");
    expect(heuristicClassify("", 2).sidekick).toBe("upgrade");
  });

  it("B5: includes user messages whose content is an array of parts", () => {
    const ctx: any = {
      sessionManager: {
        getBranch: () => [
          { type: "message", message: { role: "user", content: [{ type: "text", text: "refactor the parser" }, { type: "image" }] } },
          { type: "message", message: { role: "user", content: "plain string" } },
        ],
      },
    };
    const transcript = buildTranscript(ctx);
    expect(transcript).toContain("USER: refactor the parser");
    expect(transcript).toContain("USER: plain string");
  });

  it("trims the sidekick transcript on a user boundary with a note", () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` }));
    const trimmed = trimTranscript(messages, 8)!;
    expect(trimmed[0].role).toBe("user");
    expect(String(trimmed[0].content)).toMatch(/dropped/);
    expect(trimmed.length).toBeLessThan(messages.length);
    expect(trimTranscript(messages.slice(0, 4), 8)).toBeNull();
  });
});

describe("sidekick turn cap", () => {
  it("stops a delegation after limits.maxTurns turns", async () => {
    const core = createFauxCore({ provider: "faux", models: [{ id: "faux-small", contextWindow: 64_000 }] });
    const model = core.models[0];
    core.setResponses(
      Array.from({ length: 10 }, (_, i) => fauxAssistantMessage([fauxToolCall("ls", { path: "." }, { id: `call-${i}` })], { stopReason: "toolUse" })),
    );
    const registry = fakeRegistry([model], [model], { streamSimple: core.streamSimple });
    const rec = recordingPi();
    const config = {
      ...defaultFusionConfig(),
      sidekick: { provider: model.provider, modelId: model.id },
      sidekickTools: ["ls"],
      limits: { maxTurns: 3, maxMessages: 40 },
    };
    const engine = new FusionEngine(rec.api, registry, tempDir(), config);
    const outcome = await engine.delegate({ task: "list files forever" });
    expect(outcome.turns).toBe(3);
    expect(outcome.hitTurnCap).toBe(true);
    expect(core.state.callCount).toBe(3);
  });

  it("returns the sidekick's final text", async () => {
    const core = createFauxCore({ provider: "faux", models: [{ id: "faux-small", contextWindow: 64_000 }] });
    const model = core.models[0];
    core.setResponses([fauxAssistantMessage([fauxText("all done")])]);
    const rec = recordingPi();
    const config = { ...defaultFusionConfig(), sidekick: { provider: model.provider, modelId: model.id }, sidekickTools: [] };
    const engine = new FusionEngine(rec.api, fakeRegistry([model], [model], { streamSimple: core.streamSimple }), tempDir(), config);
    const outcome = await engine.delegate({ task: "say done" });
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toBe("all done");
    expect(engine.lastTrace?.meta).toContain("faux-small");
  });
});

describe("extension wiring", () => {
  function boot(enabled: boolean) {
    saveFusionConfig({
      ...defaultFusionConfig(),
      enabled,
      main: { provider: "c", modelId: "frontier" },
      sidekick: { provider: "a", modelId: "small" },
      routing: { ...defaultFusionConfig().routing, mode: "heuristic" },
    });
    const rec = recordingPi();
    // Mirror pi: setModel emits model_select with source "set".
    const originalSetModel = rec.api.setModel;
    rec.api.setModel = async (model: any) => {
      const ok = await originalSetModel(model);
      for (const handler of rec.handlers.get("model_select") ?? []) handler({ model, source: "set" });
      return ok;
    };
    fusionExtension(rec.api);
    const { ui, notes } = fakeUi();
    const ctx: any = {
      hasUI: true,
      mode: "tui",
      ui,
      cwd: tempDir(),
      model: daily,
      modelRegistry: fakeRegistry(all),
      sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "fix a typo and rename a variable" } }] },
    };
    return { rec, ctx, notes };
  }

  async function start(rec: any, ctx: any) {
    for (const handler of rec.handlers.get("session_start") ?? []) await handler({}, ctx);
  }

  it("B3: /fusion main only remembers the slot while fusion is off", async () => {
    const { rec, ctx } = boot(false);
    await start(rec, ctx);
    await rec.commands.get("fusion").handler("main a/small", ctx);
    expect(rec.setModelCalls).toHaveLength(0);
  });

  it("B3: fusion's own main-slot switches do not disable compaction routing", async () => {
    const { rec, ctx } = boot(true);
    await start(rec, ctx);
    await rec.commands.get("fusion").handler("main c/frontier", ctx);
    expect(rec.setModelCalls.at(-1)?.id).toBe("frontier");
    ctx.model = frontier;

    const before = rec.entries.filter((e) => e.type === "fusion-route").length;
    for (const handler of rec.handlers.get("session_compact") ?? []) await handler({}, ctx);
    // An easy transcript routes main down from frontier — proving the earlier
    // fusion-initiated switch was not treated as a user pick.
    const routes = rec.entries.filter((e) => e.type === "fusion-route").slice(before);
    expect(routes.some((e: any) => e.data.slot === "main" && e.data.to === "b/daily")).toBe(true);
  });

  it("stays off inside factory worker processes unless a sidekick is requested", () => {
    expect(fusionAllowedInProcess({})).toBe(true);
    expect(fusionAllowedInProcess({ PI_FACTORY_WORKER: "1" })).toBe(false);
    expect(fusionAllowedInProcess({ PI_FACTORY_WORKER: "1", PI_FACTORY_SIDEKICK: "1" })).toBe(true);
  });
});
