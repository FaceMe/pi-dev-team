/**
 * The Quick models table: the top QUICK_SLOT_COUNT models as a table, opened
 * with /quick or the quick-table shortcut (Ctrl+Q; Alt+M with Windows
 * keybindings). Pressing 1–8 switches straight away, so the slots work in
 * terminals that never deliver Alt+digit to pi (macOS Option typing "¡",
 * Linux terminals that use Alt+1…9 to switch tabs).
 */

import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Model } from "@earendil-works/pi-ai";
import { QUICK_SLOT_COUNT } from "../shared/recents.js";

/** The slice of a quick slot the table shows (QuickSlot in model-picker.ts satisfies it). */
export interface QuickTableSlot {
  model: Model<any>;
  effort: string;
  source: string;
  uses: number;
  lastUsed: number;
}

export interface TableTheme {
  fg(color: string, text: string): string;
}

const plain: TableTheme = { fg: (_color, text) => text };

/**
 * What macOS Option+1…8 types on a US keyboard when the terminal does not send
 * it as Alt/Meta. Index = slot.
 */
export const MAC_OPTION_DIGITS = ["¡", "™", "£", "¢", "∞", "§", "¶", "•"];

/** Slot index for a raw key: Alt+digit (ESC-prefixed or kitty/xterm encodings) or a macOS Option digit. */
export function quickSlotFromKey(data: string, options: { macOption?: boolean } = {}): number | undefined {
  for (let i = 0; i < QUICK_SLOT_COUNT; i++) {
    if (matchesKey(data, Key.alt(String(i + 1) as "1"))) return i;
  }
  if (options.macOption) {
    const index = MAC_OPTION_DIGITS.indexOf(data);
    if (index >= 0) return index;
  }
  return undefined;
}

export function slotKeyLabel(index: number, platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? `⌥${index + 1}` : `Alt+${index + 1}`;
}

export function formatAge(lastUsed: number, now: number = Date.now()): string {
  if (!lastUsed) return "never";
  const minutes = Math.max(0, Math.floor((now - lastUsed) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function formatContext(tokens?: number): string {
  if (!tokens) return "";
  return tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`;
}

interface Column {
  title: string;
  width: number;
  align?: "right";
  /** Lower drops first when the table is too wide. */
  priority: number;
  cell(slot: QuickTableSlot | undefined, index: number): string;
}

export interface QuickTableOptions {
  width: number;
  /** provider/id of the session's model, marked in the table. */
  activeKey?: string;
  /** Highlighted row (keyboard cursor), when interactive. */
  selected?: number;
  now?: number;
  platform?: NodeJS.Platform;
  theme?: TableTheme;
  /** Text for the shortcut that opens the table, shown in the header. */
  openKey?: string;
  /** Show the key hints footer (interactive table). */
  interactive?: boolean;
}

function pad(text: string, width: number, align?: "right"): string {
  const t = truncateToWidth(text, width, "…");
  const fill = " ".repeat(Math.max(0, width - visibleWidth(t)));
  return align === "right" ? fill + t : t + fill;
}

/** The table as lines of at most `width` columns. Pure, for tests and print mode. */
export function renderQuickTable(slots: QuickTableSlot[], options: QuickTableOptions): string[] {
  const theme = options.theme ?? plain;
  const now = options.now ?? Date.now();
  const platform = options.platform ?? process.platform;
  const keyOf = (s?: QuickTableSlot) => (s ? `${s.model.provider}/${s.model.id}` : "");
  const modelWidth = Math.min(32, Math.max(12, ...slots.map((s) => s.model.id.length + 2)));
  const providerWidth = Math.min(18, Math.max(8, ...slots.map((s) => s.model.provider.length)));

  const columns: Column[] = [
    { title: "#", width: 2, align: "right", priority: 9, cell: (_s, i) => String(i + 1) },
    { title: "Key", width: platform === "darwin" ? 3 : 5, priority: 6, cell: (_s, i) => slotKeyLabel(i, platform) },
    {
      title: "Model",
      width: modelWidth,
      priority: 10,
      cell: (s) => (s ? `${keyOf(s) === options.activeKey ? "● " : "  "}${s.model.id}` : "  —"),
    },
    { title: "Provider", width: providerWidth, priority: 7, cell: (s) => s?.model.provider ?? "" },
    { title: "Effort", width: 7, priority: 8, cell: (s) => (s ? s.effort : "") },
    { title: "Uses", width: 4, align: "right", priority: 4, cell: (s) => (s ? String(s.uses) : "") },
    { title: "Last used", width: 9, priority: 5, cell: (s) => (s ? formatAge(s.lastUsed, now) : "") },
    { title: "Context", width: 7, align: "right", priority: 2, cell: (s) => formatContext(s?.model.contextWindow) },
    { title: "Why", width: 15, priority: 3, cell: (s) => (s ? s.source : "") },
  ];

  // Drop the least important columns until the row fits (2-space gaps, 1-space indent).
  const fits = (cols: Column[]) => 1 + cols.reduce((sum, c) => sum + c.width, 0) + 2 * (cols.length - 1) <= options.width;
  let shown = [...columns];
  while (!fits(shown) && shown.length > 2) {
    const weakest = shown.reduce((min, c) => (c.priority < min.priority ? c : min));
    shown = shown.filter((c) => c !== weakest);
  }

  const row = (cells: string[], lead = " ") => truncateToWidth(lead + cells.join("  "), options.width, "");
  const lines: string[] = [];
  const title = theme.fg("accent", "QUICK MODELS");
  const hint = theme.fg("dim", `${options.openKey ? `${options.openKey} · ` : ""}${slotKeyLabel(0, platform)}…${QUICK_SLOT_COUNT}`);
  const gap = Math.max(1, options.width - 1 - visibleWidth("QUICK MODELS") - visibleWidth(hint));
  lines.push(truncateToWidth(` ${title}${" ".repeat(gap)}${hint}`, options.width, ""));
  lines.push(theme.fg("muted", row(shown.map((c) => pad(c.title, c.width, c.align)))));
  for (let i = 0; i < QUICK_SLOT_COUNT; i++) {
    const slot = slots[i];
    const text = row(shown.map((c) => pad(c.cell(slot, i), c.width, c.align)), options.selected === i ? "›" : " ");
    const active = slot && keyOf(slot) === options.activeKey;
    lines.push(!slot ? theme.fg("dim", text) : active || options.selected === i ? theme.fg("accent", text) : text);
  }
  if (slots.length === 0) {
    lines.push(theme.fg("dim", truncateToWidth(" Slots fill up as you switch models, or set roles in /models.", options.width, "…")));
  }
  if (options.interactive) {
    lines.push(theme.fg("dim", truncateToWidth(" [1-8] Switch  [↑/↓] Move  [Enter] Switch  [Esc] Close", options.width, "")));
  }
  return lines;
}

/** Interactive table: 1–8 (or Alt/Option+digit) switch at once; ↑/↓ and Enter also work. */
export class QuickTableComponent implements Component {
  private selected = 0;

  constructor(
    private readonly slots: QuickTableSlot[],
    private readonly done: (index: number | null) => void,
    private readonly options: Omit<QuickTableOptions, "width" | "selected" | "interactive">,
    private readonly requestRender: () => void,
  ) {
    const active = slots.findIndex((s) => `${s.model.provider}/${s.model.id}` === options.activeKey);
    if (active >= 0) this.selected = active;
  }

  render(width: number): string[] {
    return renderQuickTable(this.slots, { ...this.options, width, selected: this.selected, interactive: true });
  }

  handleInput(data: string): void {
    const digit = /^[1-8]$/.test(data) ? Number(data) - 1 : quickSlotFromKey(data, { macOption: true });
    if (digit !== undefined) {
      if (this.slots[digit]) this.done(digit);
      return;
    }
    const last = Math.max(0, this.slots.length - 1);
    if (matchesKey(data, Key.up)) this.selected = this.selected > 0 ? this.selected - 1 : last;
    else if (matchesKey(data, Key.down)) this.selected = this.selected < last ? this.selected + 1 : 0;
    else if (matchesKey(data, Key.enter)) {
      if (this.slots[this.selected]) this.done(this.selected);
      return;
    } else if (matchesKey(data, Key.escape) || data === "q") {
      this.done(null);
      return;
    } else return;
    this.requestRender();
  }

  invalidate(): void {}
}
