/** Read-only Markdown review inside the terminal, without opening an external editor. */
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export async function showSpecViewer(ctx: ExtensionContext, title: string, markdown: string, signal?: AbortSignal): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui" || signal?.aborted) return;
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener("abort", close);
      done();
    };
    signal?.addEventListener("abort", close, { once: true });
    if (signal?.aborted) close();
    const body = new Markdown(markdown, 0, 0, getMarkdownTheme());
    let offset = 0;
    let length = 0;
    const page = () => Math.max(1, tui.terminal.rows - 4);
    return {
      invalidate() { body.invalidate(); },
      render(width: number) {
        const lines = body.render(width);
        length = lines.length;
        offset = Math.min(offset, Math.max(0, length - page()));
        return [truncateToWidth(theme.bold(title), width), ...lines.slice(offset, offset + page()),
          truncateToWidth(theme.fg("dim", `↑↓ scroll · PgUp/PgDn page · Home/End · Esc close · ${offset + 1}–${Math.min(length, offset + page())}/${length}`), width)];
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q") { close(); return; }
        if (matchesKey(data, Key.up)) offset--;
        if (matchesKey(data, Key.down)) offset++;
        if (matchesKey(data, Key.pageUp)) offset -= page();
        if (matchesKey(data, Key.pageDown)) offset += page();
        if (matchesKey(data, Key.home)) offset = 0;
        if (matchesKey(data, Key.end)) offset = length;
        offset = Math.max(0, Math.min(offset, Math.max(0, length - page())));
        tui.requestRender();
      },
    };
  });
}
