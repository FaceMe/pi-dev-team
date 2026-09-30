/**
 * Fusion task-history regressions: main tasks from the raw branch (real pi
 * message shapes, statuses across compaction/errors/recovery, no caps),
 * sidekick delegation archives (queued/running/terminal, failures,
 * cancellations, unexpected rejects), immutable snapshots, restore + id
 * continuation, reset preservation, and legacy merge/dedupe with the real
 * extension structures.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { FusionEngine } from "../src/fusion/engine.js";
import {
  TASK_HISTORY_ENTRY,
  collectLegacyDelegations,
  collectMainTasks,
  collectTaskHistory,
  parseTaskHistoryRecord,
  userRequestText,
} from "../src/fusion/history.js";
import type { TaskHistoryRecord } from "../src/fusion/history.js";
import { defaultFusionConfig } from "../src/shared/config.js";
import { fakeRegistry, recordingPi, tempDir, useTempAgentDir } from "./helpers.js";

let agent: ReturnType<typeof useTempAgentDir>;
beforeEach(() => {
  agent = useTempAgentDir();
});
afterEach(() => {
  agent.restore();
  vi.restoreAllMocks();
});

const snapshots = (rec: any): TaskHistoryRecord[] =>
  rec.entries.filter((e: any) => e.type === TASK_HISTORY_ENTRY).map((e: any) => parseTaskHistoryRecord(e.data)!);

/** A realistic pi AssistantMessage: provider/model plus stopReason. */
const assistant = (text: string, extra: Record<string, any> = {}) => ({
  role: "assistant",
  provider: "a",
  model: "big",
  content: [{ type: "text", text }],
  stopReason: "stop",
  ...extra,
});
const user = (text: string, id: string, timestamp = 0) => ({
  type: "message",
  id,
  timestamp,
  message: { role: "user", content: text },
});

function makeEngine(responses: any[], config: Record<string, any> = {}) {
  const core = createFauxCore({ provider: "faux", models: [{ id: "cheap", contextWindow: 64_000 }] });
  core.setResponses(responses);
  const model = core.models[0];
  const rec = recordingPi();
  const engine = new FusionEngine(
    rec.api,
    fakeRegistry([model], [model], { streamSimple: core.streamSimple }),
    tempDir(),
    {
      ...defaultFusionConfig(),
      sidekick: { provider: model.provider, modelId: model.id },
      delegation: { ...defaultFusionConfig().delegation, resultCapChars: 200 },
      ...config,
    },
  );
  return { core, rec, engine };
}

describe("main task collector", () => {
  it("collects main tasks before and after a real compaction entry, with real assistant shapes", () => {
    const branch = [
      { ...user("fix the parser", "e1", 1000) },
      { type: "message", id: "e2", timestamp: 2000, message: assistant("parser fixed") },
      // Real compaction entry: not a message, never a task, never a boundary.
      { type: "compaction", id: "e3", timestamp: 2500, summary: "earlier work", firstKeptEntryId: "e2", tokensBefore: 1000 },
      { type: "message", id: "e4", timestamp: 3000, message: { role: "user", content: [{ type: "text", text: "now the tests" }] } },
      { type: "message", id: "e5", timestamp: 4000, message: assistant("tests pass") },
    ];
    const tasks = collectMainTasks(branch);
    expect(tasks.map((t) => t.id)).toEqual(["Me1", "Me4"]);
    expect(tasks[0]).toMatchObject({ agent: "main", status: "done", task: "fix the parser", result: "parser fixed", model: "a/big" });
    expect(tasks[0].endedAt).toBe(2000);
    expect(tasks[1]).toMatchObject({ status: "done", result: "tests pass" });
  });

  it("handles string, array and image-only prompts; custom viewer entries are never tasks", () => {
    expect(userRequestText([{ type: "tool_result", content: "x" }])).toBe("");
    const branch = [
      { type: "message", id: "a", message: { role: "user", content: "plain string" } },
      { type: "message", id: "b", message: { role: "user", content: [{ type: "text", text: "array text" }] } },
      { type: "message", id: "c", message: { role: "user", content: [{ type: "image", source: {} }] } },
      { type: "custom", customType: TASK_HISTORY_ENTRY, id: "h", data: {} },
      { type: "custom_message", customType: "fusion-result", id: "r", content: "x", details: { id: "D1" } },
      { type: "custom", customType: "fusion-stats", id: "s", data: {} },
      { type: "custom", customType: "fusion-trace", id: "t", data: {} },
    ];
    const tasks = collectMainTasks(branch);
    expect(tasks.map((t) => t.task)).toEqual(["plain string", "array text", "[image-only request]"]);
    expect(tasks.every((t) => t.agent === "main")).toBe(true);
  });

  it("keeps every task beyond a short tail, with uncapped request and result text", () => {
    const branch: any[] = [];
    for (let i = 0; i < 30; i++) {
      branch.push(user(`task ${i}: ${"x".repeat(500)}`, `u${i}`));
      branch.push({ type: "message", id: `a${i}`, message: assistant(`done ${i}: ${"y".repeat(500)}`) });
    }
    const tasks = collectMainTasks(branch);
    expect(tasks).toHaveLength(30);
    expect(tasks[29].task.length).toBeGreaterThan(500);
    expect(tasks[29].result).toContain("done 29");
  });

  it("classifies the trailing span: done, cancelled, failed and running", () => {
    const branch = [
      user("one", "u1"),
      { type: "message", id: "a1", message: assistant("ok") },
      user("two", "u2"),
      { type: "message", id: "a2", message: assistant("boom", { stopReason: "error", errorMessage: "provider 500" }) },
      user("three", "u3"),
      { type: "message", id: "a3", message: assistant("halt", { stopReason: "aborted", errorMessage: "user aborted" }) },
      user("four", "u4"),
    ];
    const tasks = collectMainTasks(branch);
    expect(tasks.map((t) => t.status)).toEqual(["done", "failed", "cancelled", "running"]);
    expect(tasks[1].error).toContain("500");
    expect(tasks[2].status).toBe("cancelled");
    expect(tasks[2].error).toContain("aborted");
    expect(tasks[3].endedAt).toBeUndefined(); // running items have no end
  });

  it("keeps recovery responses in the same task after an error", () => {
    const branch = [
      user("fix it", "u1"),
      { type: "message", id: "a1", message: assistant("partial attempt", { stopReason: "error", errorMessage: "rate limited" }) },
      { type: "message", id: "a2", message: assistant("recovered fully") },
    ];
    const tasks = collectMainTasks(branch);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("done");
    expect(tasks[0].result).toContain("partial attempt");
    expect(tasks[0].result).toContain("recovered fully");
    expect(tasks[0].error).toBeUndefined();
  });

  it("interrupts a request superseded by the next user message mid-task", () => {
    const branch = [
      user("first", "u1"),
      { type: "message", id: "a1", message: assistant("done") },
      user("second", "u2"),
      {
        type: "message",
        id: "a2",
        message: {
          role: "assistant",
          provider: "a",
          model: "big",
          content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } }],
          stopReason: "toolUse",
        },
      },
      { type: "message", id: "t1r", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "3 passing" }] } },
      user("third", "u3"),
      { type: "message", id: "a3", message: assistant("third done") },
    ];
    const tasks = collectMainTasks(branch);
    expect(tasks.map((t) => t.status)).toEqual(["done", "interrupted", "done"]);
    expect(tasks[1].endedAt).toBeDefined();
    expect(tasks[1].activity?.join(" ")).toContain("bash");
  });
});

describe("sidekick delegation archive", () => {
  it("archives a foreground success: queued first, uncapped result kept, capped tool output preserved", async () => {
    const longResult = "RESULT ".repeat(100); // 700 chars, above the 200-char cap
    const { rec, engine } = makeEngine([fauxAssistantMessage([fauxText(longResult)])]);
    const outcome = await engine.delegate({ task: "T".repeat(600), context: "ctx", files: ["a.ts"] });
    expect(outcome.text.length).toBeLessThan(longResult.trim().length);
    expect(outcome.text).toContain("result cut");
    expect(outcome.fullText).toBe(longResult.trim()); // extractFinalText trims trailing whitespace
    const record = snapshots(rec).at(-1)!;
    expect(snapshots(rec).map((r) => r.status)).toEqual(["queued", "running", "done"]);
    expect(record).toMatchObject({ id: "D1", agent: "sidekick", status: "done", context: "ctx", files: ["a.ts"] });
    expect(record.task).toHaveLength(600);
    expect(record.result).toBe(longResult.trim());
    expect(record.model).toContain("cheap");
    expect(Array.isArray(record.trace)).toBe(true);
    expect(record.endedAt).toBeDefined();
  });

  it("archives a FAILED harness verdict as failed, with evidence and the full result", async () => {
    const { rec, engine } = makeEngine([fauxAssistantMessage([fauxText("short report")])]);
    const outcome = await engine.delegate({ task: "check it", verify: ["echo broken >&2; exit 1"] });
    expect(outcome.verdict).toBe("failed");
    const records = snapshots(rec);
    expect(records.at(-1)!.status).toBe("failed");
    expect(records.at(-1)!.evidence).toMatchObject({ checksRun: 1, checksFailed: 1, verdict: "failed" });
    expect(records.at(-1)!.result).toContain("verdict: FAILED");
    expect(records.at(-1)!.result).toContain("short report");
  });

  it("archives a background delegation once: queued -> running -> done, same id", async () => {
    const { rec, engine } = makeEngine([fauxAssistantMessage([fauxText("bg done")])]);
    const task = engine.startBackground({ task: "run in background" });
    expect(task.id).toBe("D1");
    await task.promise;
    expect(task.status).toBe("done");
    const records = snapshots(rec);
    expect(records.map((r) => r.id)).toEqual(["D1", "D1", "D1"]);
    expect(records.map((r) => r.status)).toEqual(["queued", "running", "done"]);
    expect(records.at(-1)!.background).toBe(true);
    expect(records.at(-1)!.result).toBe("bg done");
  });

  it("marks a background task failed when the harness verdict FAILED, and releases leases", async () => {
    const { rec, engine } = makeEngine([fauxAssistantMessage([fauxText("claims success")])], { sidekickTools: ["read", "edit"] });
    const task = engine.startBackground({ task: "check", files: ["src/a.ts"], verify: ["echo broken >&2; exit 1"] });
    await task.promise;
    expect(task.status).toBe("failed"); // verdict honoured, not "done"
    expect(task.leases.size).toBe(0);
    expect(snapshots(rec).at(-1)).toMatchObject({ id: task.id, status: "failed" });
  });

  it("records an unavailable sidekick model as a failed delegation", async () => {
    const rec = recordingPi();
    const engine = new FusionEngine(rec.api, fakeRegistry([]), tempDir(), { ...defaultFusionConfig(), sidekick: undefined });
    const outcome = await engine.delegate({ task: "no one home" });
    expect(outcome.isError).toBe(true);
    const records = snapshots(rec);
    expect(records.map((r) => r.status)).toEqual(["queued", "running", "failed"]);
    expect(records.at(-1)!.error).toContain("unavailable");
  });

  it("cancels a RUNNING delegation and never overwrites the cancellation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { rec, engine } = makeEngine([(async () => {
      await gate;
      return fauxAssistantMessage([fauxText("late")]);
    }) as any]);
    const task = engine.startBackground({ task: "gated work" });
    // Wait until the stream actually entered the running state.
    for (let i = 0; i < 200 && !snapshots(rec).some((r) => r.id === task.id && r.status === "running"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(engine.cancel([task.id])).toEqual([task.id]);
    expect(task.status).toBe("cancelled");
    release();
    await task.promise;
    expect(task.status).toBe("cancelled");
    const records = snapshots(rec).filter((r) => r.id === task.id);
    expect(records.slice(0, 2).map((r) => r.status)).toEqual(["queued", "running"]);
    // Cancelled stays cancelled; same-status enriches (error/result) are allowed.
    expect(records.slice(2).every((r) => r.status === "cancelled")).toBe(true);
    expect(records.at(-1)!.status).toBe("cancelled");
  });

  it("catches unexpected background rejects: task and record failed, leases released", async () => {
    const { rec, engine } = makeEngine([], { sidekickTools: ["read", "edit"] });
    (engine as any).runDelegation = async () => {
      throw new Error("boom");
    };
    const task = engine.startBackground({ task: "explode", files: ["a.ts"] });
    const outcome = await task.promise;
    expect(outcome.isError).toBe(true);
    expect(task.status).toBe("failed");
    expect(task.leases.size).toBe(0);
    expect(snapshots(rec).at(-1)).toMatchObject({ id: task.id, status: "failed", error: "boom" });
  });

  it("allocates one id per foreground request up front and keeps earlier snapshots immutable", async () => {
    const { rec, engine } = makeEngine([
      fauxAssistantMessage([fauxText("first")]),
      fauxAssistantMessage([fauxText("second")]),
    ]);
    const first = engine.delegate({ task: "one" });
    const second = engine.delegate({ task: "two" });
    // Both queued records exist before either run starts...
    expect(snapshots(rec).map((r) => `${r.id}:${r.status}`)).toEqual(["D1:queued", "D2:queued"]);
    await Promise.all([first, second]);
    // ...and the stored snapshot was never mutated by later lifecycle writes.
    const stored = rec.entries.find((e: any) => e.type === TASK_HISTORY_ENTRY)!.data as any;
    expect(stored.status).toBe("queued");
    const byId = (id: string) => snapshots(rec).filter((r) => r.id === id).map((r) => r.status);
    expect(byId("D1")).toEqual(["queued", "running", "done"]);
    expect(byId("D2")).toEqual(["queued", "running", "done"]);
  });

  it("resetSidekick and resetSessionStats preserve the history", async () => {
    const { engine } = makeEngine([fauxAssistantMessage([fauxText("remembered")])]);
    await engine.delegate({ task: "remember me" });
    engine.resetSidekick();
    engine.resetSessionStats();
    expect(engine.taskRecords.map((r) => r.task)).toContain("remember me");
    expect(engine.taskRecords[0].status).toBe("done");
    expect(engine.stats.delegations).toBe(0);
  });

  it("restores branch records, marks unfinished work interrupted and continues ids above the session", async () => {
    const { rec, engine } = makeEngine([fauxAssistantMessage([fauxText("fresh")])]);
    const archived = { schema: 1, id: "D2", agent: "sidekick", task: "earlier work", status: "running", startedAt: 1234 };
    const branchEntry = { type: "custom", customType: TASK_HISTORY_ENTRY, id: "e1", data: archived };
    const abandoned = { type: "custom", customType: TASK_HISTORY_ENTRY, id: "e2", data: { ...archived, id: "D9" } };
    engine.restoreTaskHistory({
      sessionManager: { getEntries: () => [branchEntry, abandoned], getBranch: () => [branchEntry] },
    });
    expect(engine.taskRecords.map((r) => r.id)).toEqual(["D2"]); // abandoned content not restored
    expect(engine.taskRecords[0].status).toBe("interrupted");
    await engine.delegate({ task: "fresh work" });
    const ids = snapshots(rec).map((r) => r.id);
    expect(ids).toContain("D10"); // counter above every id in the session file
    expect(engine.taskRecords.map((r) => r.id)).toEqual(["D2", "D10"]);
  });

  it("falls back to getEntries when getBranch is unavailable and reserves legacy delivery ids", async () => {
    const { rec, engine } = makeEngine([fauxAssistantMessage([fauxText("next")])]);
    engine.restoreTaskHistory({
      sessionManager: {
        getEntries: () => [
          { type: "custom_message", customType: "fusion-result", id: "m1", content: "done", details: { id: "D7", task: "t", isError: false } },
          { type: "message", id: "l1", message: { role: "toolResult", toolCallId: "z", content: [{ type: "text", text: "Started background delegation D8." }] } },
        ],
      },
    });
    expect(engine.taskRecords).toEqual([]); // nothing to restore, but ids reserved
    await engine.delegate({ task: "next work" });
    expect(new Set(snapshots(rec).map((r) => r.id))).toEqual(new Set(["D9"]));
    expect(snapshots(rec).at(-1)).toMatchObject({ id: "D9", status: "done" });
  });

  it("restores the latest snapshot per id from the branch alone", async () => {
    const { engine } = makeEngine([fauxAssistantMessage([fauxText("after restore")])]);
    const older = { schema: 1, id: "D4", agent: "sidekick", task: "older", status: "running", startedAt: 1 };
    const newer = { schema: 1, id: "D4", agent: "sidekick", task: "newer", status: "done", startedAt: 2 };
    engine.restoreTaskHistory({
      sessionManager: {
        getBranch: () => [
          { type: "custom", customType: TASK_HISTORY_ENTRY, id: "h1", data: older },
          { type: "custom", customType: TASK_HISTORY_ENTRY, id: "h2", data: newer },
        ],
      },
    });
    expect(engine.taskRecords).toHaveLength(1);
    expect(engine.taskRecords[0]).toMatchObject({ id: "D4", task: "newer", status: "done" });
    const outcome = await engine.delegate({ task: "after restore" });
    expect(outcome.isError).toBe(false);
    expect(engine.taskRecords.map((record) => record.id)).toEqual(["D4", "D5"]);
  });
});

describe("history merge and validation", () => {
  it("validates snapshots strictly", () => {
    expect(parseTaskHistoryRecord(null)).toBeUndefined();
    expect(parseTaskHistoryRecord({ schema: 2, id: "D1", agent: "sidekick", task: "x", status: "done", startedAt: 1 })).toBeUndefined();
    expect(parseTaskHistoryRecord({ schema: 1, id: "D1", agent: "wizard", task: "x", status: "done", startedAt: 1 })).toBeUndefined();
    expect(parseTaskHistoryRecord({ schema: 1, id: "D1", agent: "sidekick", task: "x", status: "done" })).toBeUndefined();
    expect(parseTaskHistoryRecord({ schema: 1, id: "D1", agent: "sidekick", task: "x", status: "done", startedAt: 1 })).toBeDefined();
  });

  it("merges real pi legacy structures without duplicates and honours FAILED verdicts", () => {
    const branch = [
      user("run them", "e1", 100),
      // Foreground delegation with a FAILED verdict despite isError: false.
      { type: "message", id: "e2", timestamp: 200, message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "sidekick", arguments: { task: "foreground brief", verify: ["npm test"] } }], stopReason: "toolUse" } },
      { type: "message", id: "e3", timestamp: 300, message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "[fusion] verdict: FAILED (checks 0/1 passed)" }], isError: false, details: { verdict: "failed", model: "a/cheap", meta: "1 turn", trace: [{ at: 1, kind: "turn" }] } } },
      // Background launch: one D-id record, not a done L-record.
      { type: "message", id: "e4", timestamp: 400, message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "sidekick", arguments: { task: "bg brief" } }], stopReason: "toolUse" } },
      { type: "message", id: "e5", timestamp: 500, message: { role: "toolResult", toolCallId: "c2", content: [{ type: "text", text: "Started background delegation D2 (queued behind 0). Do not repeat this task." }], isError: false, details: { background: true, id: "D2", meta: "background" } } },
      // sidekick_wait collecting two ids.
      { type: "message", id: "e6", timestamp: 600, message: { role: "assistant", content: [{ type: "toolCall", id: "c3", name: "sidekick_wait", arguments: {} }], stopReason: "toolUse" } },
      { type: "message", id: "e7", timestamp: 700, message: { role: "toolResult", toolCallId: "c3", content: [{ type: "text", text: "D2: done\nD3: done" }], isError: false, details: { ids: ["D2", "D3"] } } },
      // Deliveries as real custom_message entries; the second updates D3.
      { type: "custom_message", customType: "fusion-result", id: "m1", timestamp: 800, content: "[fusion] Background delegation D2 finished (meta). Task: bg brief\n\nbg output", details: { id: "D2", task: "bg brief", meta: "meta", isError: false } },
      { type: "custom_message", customType: "fusion-result", id: "m2", timestamp: 900, content: "[fusion] Background delegation D3 FAILED: boom (meta). Task: third\n\nboom output", details: { id: "D3", task: "third", isError: true } },
      // Duplicate delivery (dedup) and a review reminder (ignored).
      { type: "custom_message", customType: "fusion-result", id: "m3", timestamp: 950, content: "[fusion] Background delegation D2 finished again", details: { id: "D2", task: "bg brief", isError: false } },
      { type: "custom_message", customType: "fusion-result", id: "m4", timestamp: 960, content: "Review before you finish: src/out.ts", details: { id: "review", isError: false } },
    ];
    expect(collectLegacyDelegations(branch).map((r) => r.id).sort()).toEqual(["D2", "D3", "L-c1"]);
    const sidekick = collectTaskHistory(branch, []).filter((r) => r.agent === "sidekick");
    expect(sidekick).toHaveLength(3);
    const foreground = sidekick.find((r) => r.id === "L-c1")!;
    expect(foreground.status).toBe("failed"); // FAILED verdict, isError: false
    expect(foreground.evidence).toMatchObject({ verdict: "failed" });
    expect(foreground.model).toBe("a/cheap");
    expect(foreground.verify).toEqual(["npm test"]);
    expect(foreground.previewOnly).toBe(false);
    const background = sidekick.find((r) => r.id === "D2")!;
    expect(background.status).toBe("done");
    expect(background.background).toBe(true);
    expect(background.result).toContain("bg output");
    const third = sidekick.find((r) => r.id === "D3")!;
    expect(third.status).toBe("failed");
    expect(third.error).toContain("boom");
    expect(sidekick.some((r) => r.task.includes("Review"))).toBe(false);
    // The main user request is still collected exactly once.
    expect(collectTaskHistory(branch, []).filter((r) => r.agent === "main").map((r) => r.id)).toEqual(["Me1"]);
  });

  it("supports the older custom-entry delivery shape", () => {
    const branch = [
      { type: "custom", customType: "fusion-result", id: "c1", data: { customType: "fusion-result", content: "[fusion] Background delegation D9 finished. Task: old\n\nold output", details: { id: "D9", task: "old", isError: false } } },
    ];
    const records = collectTaskHistory(branch, []).filter((r) => r.agent === "sidekick");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: "D9", status: "done" });
    expect(records[0].result).toContain("old output");
  });

  it("prefers archived snapshots over legacy sidekick toolCalls with the same toolCallId", () => {
    const branch = [
      user("do it", "e1"),
      { type: "message", id: "e2", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "sidekick", arguments: { task: "legacy brief" } }], stopReason: "toolUse" } },
      { type: "message", id: "e3", message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "legacy result" }] } },
      {
        type: "custom",
        customType: TASK_HISTORY_ENTRY,
        id: "h1",
        data: { schema: 1, id: "D3", agent: "sidekick", task: "archived brief", status: "done", startedAt: 500, toolCallId: "call-1", result: "archived result" },
      },
    ];
    expect(collectLegacyDelegations(branch).map((r) => r.id)).toEqual(["L-call-1"]);
    const merged = collectTaskHistory(branch);
    const sidekick = merged.filter((r) => r.agent === "sidekick");
    expect(sidekick.map((r) => r.id)).toEqual(["D3"]);
    expect(sidekick[0].result).toBe("archived result");
    expect(merged.find((r) => r.agent === "main")?.id).toBe("Me1");
  });
});

describe("history edge cases", () => {
  it("preserves paragraphs and does not treat tool-call commentary as a finished answer", () => {
    const text = "  request paragraph\n\nsecond paragraph\n";
    const response = "first paragraph\n\nsecond paragraph\n";
    const branch = [
      user(text, "u1"),
      { type: "message", message: assistant("working", { stopReason: "toolUse", content: [{ type: "text", text: "working" }, { type: "toolCall", id: "x", name: "read", arguments: { path: "a.ts" } }] }) },
    ];
    expect(collectMainTasks(branch)[0].status).toBe("running");
    branch.push(user("next", "u2") as any);
    branch.push({ type: "message", message: assistant(response) } as any);
    const tasks = collectMainTasks(branch);
    expect(tasks[0]).toMatchObject({ status: "interrupted", task: text });
    expect(tasks[1]).toMatchObject({ status: "done", result: response });
  });

  it("separates legacy wait results and their failure statuses by delegation id", () => {
    const branch = [
      { type: "message", message: { role: "assistant", content: [
        { type: "toolCall", id: "a", name: "sidekick", arguments: { task: "one", background: true } },
        { type: "toolCall", id: "b", name: "sidekick", arguments: { task: "two", background: true } },
        { type: "toolCall", id: "w", name: "sidekick_wait", arguments: {} },
      ] } },
      { type: "message", message: { role: "toolResult", toolName: "sidekick", toolCallId: "a", content: "Started background delegation D1", details: { background: true, id: "D1" } } },
      { type: "message", message: { role: "toolResult", toolName: "sidekick", toolCallId: "b", content: "Started background delegation D2", details: { background: true, id: "D2" } } },
      { type: "message", message: { role: "toolResult", toolName: "sidekick_wait", toolCallId: "w", content: "D1 (cheap · 1 turn):\nONLY_FIRST_RESULT\n\nD2 FAILED: ONLY_SECOND_ERROR (cheap)", details: { ids: ["D1", "D2"] } } },
    ];
    const tasks = collectLegacyDelegations(branch);
    expect(tasks.map((task) => task.id)).toEqual(["D1", "D2"]);
    expect(tasks[0].status).toBe("done");
    expect(tasks[0].result).toContain("ONLY_FIRST_RESULT");
    expect(tasks[0].result).not.toContain("ONLY_SECOND_ERROR");
    expect(tasks[1].status).toBe("failed");
    expect(tasks[1].result).toContain("ONLY_SECOND_ERROR");
    expect(tasks[1].result).not.toContain("ONLY_FIRST_RESULT");
  });

  it("does not turn a completed task into failure when result delivery throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { engine } = makeEngine([fauxAssistantMessage([fauxText("done")])]);
    const onDone = vi.fn(() => { throw new Error("delivery failed"); });
    const task = engine.startBackground({ task: "finish successfully" }, onDone);
    const outcome = await task.promise;
    expect(outcome.isError).toBe(false);
    expect(task.status).toBe("done");
    expect(engine.taskRecords[0].status).toBe("done");
    expect(onDone).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalled();
  });

  it("never appends late results into a replacement session after disposal", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { engine, rec } = makeEngine([(async () => {
      entered();
      await gate;
      return fauxAssistantMessage([fauxText("late completion")]);
    }) as any]);
    const task = engine.startBackground({ task: "old session task" });
    await started;
    engine.cancel();
    engine.dispose();
    const count = snapshots(rec).length;
    release();
    await task.promise;
    expect(snapshots(rec)).toHaveLength(count);
    expect(task.status).toBe("cancelled");
    expect(engine.onUsage).toBeUndefined();
  });

  it("keeps running cancellation terminal even when the harness rejects afterward", async () => {
    const { engine, rec } = makeEngine([]);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    (engine as any).runDelegation = async () => { entered(); await gate; throw new Error("late harness error"); };
    const task = engine.startBackground({ task: "cancel me" });
    await started;
    engine.cancel([task.id]);
    release();
    await task.promise;
    expect(task.status).toBe("cancelled");
    expect(engine.taskRecords[0].status).toBe("cancelled");
    expect(snapshots(rec).slice(2).every((record) => record.status === "cancelled")).toBe(true);
  });
});
