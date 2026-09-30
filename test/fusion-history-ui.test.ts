import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import fusionExtension from "../src/fusion/extension.js";
import { HISTORY_VIEW_ENTRY, renderTaskHistory } from "../src/fusion/history-view.js";
import type { HistoryViewData } from "../src/fusion/history-view.js";
import { TASK_HISTORY_ENTRY } from "../src/fusion/history.js";
import { defaultFusionConfig, saveFusionConfig } from "../src/shared/config.js";
import { fakeRegistry, fakeUi, recordingPi, tempDir, useTempAgentDir } from "./helpers.js";

let agent: ReturnType<typeof useTempAgentDir>;
beforeEach(() => { agent = useTempAgentDir(); });
afterEach(() => agent.restore());

const report = "report\n" + "full output line\n".repeat(70) + "ARCHIVED_RESULT_TAIL";
const request = "delegated request\n" + "request detail\n".repeat(50) + "FULL_REQUEST_TAIL";

function boot(session = SessionManager.inMemory(), responses = [report]) {
  const core = createFauxCore({ provider: "faux", models: [{ id: "cheap", contextWindow: 64_000 }] });
  core.setResponses(responses.map((text) => fauxAssistantMessage([fauxText(text)])));
  const model = core.models[0];
  saveFusionConfig({
    ...defaultFusionConfig(),
    enabled: true,
    main: { provider: model.provider, modelId: model.id },
    sidekick: { provider: model.provider, modelId: model.id },
    sidekickTools: [],
    delegation: { ...defaultFusionConfig().delegation, resultCapChars: 200 },
  });
  const rec = recordingPi();
  rec.activeTools = ["read", "bash"];
  const append = rec.api.appendEntry;
  rec.api.appendEntry = (type: string, data: unknown) => {
    append(type, data);
    session.appendCustomEntry(type, data);
  };
  const renderers = new Map<string, any>();
  rec.api.registerEntryRenderer = (type: string, renderer: any) => renderers.set(type, renderer);
  fusionExtension(rec.api);
  const { ui, notes } = fakeUi();
  const widgets: unknown[] = [];
  ui.setWidget = ((_key: string, value: unknown) => widgets.push(value)) as any;
  const ctx: any = {
    mode: "tui", hasUI: true, ui, cwd: tempDir(), model,
    modelRegistry: fakeRegistry([model], [model], { streamSimple: core.streamSimple }),
    sessionManager: session, isIdle: () => true,
  };
  const start = async () => {
    for (const handler of rec.handlers.get("session_start") ?? []) await handler({}, ctx);
  };
  const command = (args: string) => rec.commands.get("fusion").handler(args, ctx);
  const view = () => rec.entries.filter((entry) => entry.type === HISTORY_VIEW_ENTRY).at(-1)?.data as HistoryViewData;
  const assistant = (text: string) => session.appendMessage({
    role: "assistant", content: [{ type: "text", text }], provider: model.provider, model: model.id,
    timestamp: Date.now(), stopReason: "stop",
  } as any);
  const delegate = async (id = "c1", task = request) => {
    session.appendMessage({
      role: "assistant", content: [{ type: "toolCall", id, name: "sidekick", arguments: { task } }],
      provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "toolUse",
    } as any);
    const result = await rec.tools.get("sidekick").execute(id, { task }, undefined, undefined, ctx);
    session.appendMessage({
      role: "toolResult", toolCallId: id, toolName: "sidekick", content: result.content,
      details: result.details, isError: false, timestamp: Date.now(),
    });
    assistant("main finished");
    return result;
  };
  return { rec, ctx, notes, widgets, session, start, command, view, assistant, delegate, renderers };
}

describe("current-session history command", () => {
  it("shows main history while off without enabling Fusion or showing live stats", async () => {
    const f = boot();
    f.session.appendMessage({ role: "user", content: "main request", timestamp: Date.now() });
    f.assistant("main response");
    await f.start();
    await f.command("history");
    expect(f.view().tasks).toHaveLength(1);
    expect(f.view().tasks[0]).toMatchObject({ agent: "main", status: "done", task: "main request", result: "main response" });
    expect(f.rec.activeTools).not.toContain("sidekick");
    expect(f.widgets.every((widget) => widget === undefined)).toBe(true);
    expect(f.rec.setModelCalls).toHaveLength(0);
  });

  it("lists foreground delegations exactly once, filters agents and archives uncapped results outside model context", async () => {
    const f = boot();
    f.session.appendMessage({ role: "user", content: "user task", timestamp: Date.now() });
    await f.start();
    await f.command("on");
    const result = await f.delegate();
    expect(result.content[0].text).not.toContain("ARCHIVED_RESULT_TAIL");
    await f.command("off");
    await f.command("history");
    expect(f.view().tasks.map((task) => task.agent).sort()).toEqual(["main", "sidekick"]);
    const delegated = f.view().tasks.find((task) => task.agent === "sidekick")!;
    expect(delegated.task).toBe(request);
    expect(delegated.result).toBe(report);
    expect(delegated.toolCallId).toBe("c1");
    expect(JSON.stringify(f.session.buildSessionContext().messages)).not.toContain("ARCHIVED_RESULT_TAIL");
    await f.command("history main");
    expect(f.view().tasks.map((task) => task.agent)).toEqual(["main"]);
    await f.command("history sidekick");
    expect(f.view().tasks.map((task) => task.agent)).toEqual(["sidekick"]);
    await f.command("history all");
    expect(f.view().tasks).toHaveLength(2); // previous history views are not tasks
    expect(f.rec.activeTools).not.toContain("sidekick");
  });

  it("keeps recorded history through reset and extension reload without restoring active work", async () => {
    const f = boot();
    f.session.appendMessage({ role: "user", content: "first task", timestamp: Date.now() });
    await f.start();
    await f.command("on");
    await f.delegate();
    await f.command("reset");
    await f.command("history sidekick");
    expect(f.view().tasks[0].id).toBe("D1");
    for (const handler of f.rec.handlers.get("session_shutdown") ?? []) await handler({}, f.ctx);
    const reloaded = boot(f.session, ["next report"]);
    await reloaded.start();
    await reloaded.command("history sidekick");
    expect(reloaded.view().tasks[0]).toMatchObject({ id: "D1", result: report, status: "done" });
    expect(reloaded.rec.activeTools).not.toContain("sidekick");
    await reloaded.command("on");
    await reloaded.delegate("c2", "next delegation");
    await reloaded.command("history sidekick");
    expect(reloaded.view().tasks.map((task) => task.id)).toEqual(["D1", "D2"]);
  });

  it("offers history in the menu and autocomplete, rejects invalid filters and reports empty history", async () => {
    const f = boot();
    await f.start();
    await f.command("history");
    expect(f.notes.at(-1)?.message).toContain("No tasks recorded");
    await f.command("history wrong");
    expect(f.notes.at(-1)?.message).toContain("Usage: /fusion history");
    const completions = f.rec.commands.get("fusion").getArgumentCompletions;
    expect(completions("hist").map((item: any) => item.value)).toContain("history");
    expect(completions("history ").map((item: any) => item.value)).toEqual(["history all", "history main", "history sidekick"]);
    f.session.appendMessage({ role: "user", content: "menu task", timestamp: Date.now() });
    const choices: string[][] = [];
    f.ctx.ui.select = async (_title: string, options: string[]) => {
      choices.push(options);
      return choices.length === 1 ? "session task history" : "done";
    };
    await f.command("");
    expect(choices[0]).toContain("session task history");
    expect(f.view().tasks[0].task).toBe("menu task");
    expect(f.rec.activeTools).not.toContain("sidekick");
  });
});

describe("history transcript rendering", () => {
  const theme: any = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };

  it("lists every task, expands full requests/results and fits narrow terminals", () => {
    const data: HistoryViewData = {
      filter: "all",
      tasks: Array.from({ length: 30 }, (_, index) => ({
        schema: 1, id: `D${index + 1}`, agent: "sidekick", status: "done", startedAt: 1000 + index,
        task: request, result: report,
      })),
    };
    const collapsed = renderTaskHistory(data, false, theme).render(90).join("\n");
    expect(collapsed).toContain("sidekick D1");
    expect(collapsed).toContain("sidekick D30");
    expect(collapsed).not.toContain("FULL_REQUEST_TAIL");
    const expanded = renderTaskHistory(data, true, theme).render(100).join("\n");
    expect(expanded).toContain("FULL_REQUEST_TAIL");
    expect(expanded).toContain("ARCHIVED_RESULT_TAIL");
    for (const width of [40, 80]) {
      expect(renderTaskHistory(data, true, theme).render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("registers only the display renderer, not one for archival state", async () => {
    const f = boot();
    expect(f.renderers.has(HISTORY_VIEW_ENTRY)).toBe(true);
    expect(f.renderers.has(TASK_HISTORY_ENTRY)).toBe(false);
  });
});
