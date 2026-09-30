/** Display-only snapshots of the current session's task history. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { truncate } from "../shared/text.js";
import { renderTraceSteps } from "../shared/trace.js";
import type { TaskAgent, TaskHistoryRecord } from "./history.js";

export const HISTORY_VIEW_ENTRY = "fusion-history";
export type HistoryFilter = TaskAgent | "all";

export interface HistoryViewData {
  filter: HistoryFilter;
  tasks: TaskHistoryRecord[];
}

/** Use Pi's transcript scrolling and expansion rather than a second terminal UI. */
export function renderTaskHistory(data: HistoryViewData, expanded: boolean, theme: Theme): Box {
  const tasks = data.tasks ?? [];
  const main = tasks.filter((task) => task.agent === "main").length;
  const sidekick = tasks.length - main;
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  const add = (text: string) => box.addChild(new Text(text, 0, 0));
  add(theme.bold(`task history — current session · ${main} main · ${sidekick} sidekick`));
  add(theme.fg("dim", "Active branch, including tasks from before compaction."));
  if (!tasks.length) {
    add(theme.fg("muted", "No tasks recorded."));
    return box;
  }
  if (!expanded) {
    add(theme.fg("dim", `${keyText("app.tools.expand")} to show full requests and results`));
  }

  for (const task of tasks) {
    const color = task.status === "failed" ? "error" : task.status === "done" ? "success" : "muted";
    const time = Number.isFinite(task.startedAt) ? new Date(task.startedAt).toLocaleTimeString() : "";
    add(`${theme.fg("accent", `${task.agent} ${task.id}`)} ${theme.fg(color, task.status)}` +
      `${time ? ` · ${theme.fg("dim", time)}` : ""}${task.model ? ` · ${theme.fg("dim", task.model)}` : ""}`);
    if (!expanded) {
      add(theme.fg("muted", truncate(task.task, 140)));
      continue;
    }

    add(theme.bold("Request"));
    add(task.task);
    if (task.meta) add(theme.fg("dim", task.meta));
    if (task.endedAt !== undefined) {
      add(theme.fg("dim", `elapsed ${Math.max(0, (task.endedAt - task.startedAt) / 1000).toFixed(1)}s`));
    }
    if (task.context) {
      add(theme.bold("Context"));
      add(task.context);
    }
    if (task.files?.length) {
      add(theme.bold("Files"));
      for (const file of task.files) add(file);
    }
    if (task.acceptance?.length) {
      add(theme.bold("Acceptance criteria"));
      for (const [index, criterion] of task.acceptance.entries()) add(`${index + 1}. ${criterion}`);
    }
    if (task.verify?.length) {
      add(theme.bold("Verification commands"));
      for (const command of task.verify) add(command);
    }
    if (task.result !== undefined) {
      add(theme.bold("Result"));
      add(task.result);
    }
    if (task.error) {
      add(theme.fg("error", "Error"));
      add(theme.fg("error", task.error));
    }
    if (task.activity?.length) {
      add(theme.bold("Tool activity (output previews; full outputs remain in the transcript)"));
      for (const line of task.activity) add(theme.fg("dim", line));
    }
    if (task.trace?.length) {
      add(theme.bold("Recorded delegation trace"));
      for (const line of renderTraceSteps(task.trace, theme)) add(line);
    }
    if (task.previewOnly) {
      add(theme.fg("dim", "Legacy task: only saved previews are available; omitted content cannot be recovered."));
    }
    add("");
  }
  return box;
}
