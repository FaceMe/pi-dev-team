/** Preserve the selected row when a nested terminal menu returns. */
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SelectList, truncateToWidth } from "@earendil-works/pi-tui";

export async function selectFactoryMenu(
  ctx: ExtensionContext, title: string, options: string[], initialIndex = 0,
): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;
  if (ctx.mode !== "tui" || initialIndex === 0) return ctx.ui.select(title, options);
  return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
    const list = new SelectList(options.map(value => ({ value, label: value })), Math.max(1, Math.min(16, tui.terminal.rows - 5)), getSelectListTheme());
    list.setSelectedIndex(Math.max(0, Math.min(initialIndex, options.length - 1)));
    list.onSelect = item => done(item.value);
    list.onCancel = () => done(undefined);
    return {
      invalidate: () => list.invalidate(),
      render: (width: number) => [truncateToWidth(theme.bold(title), width), ...list.render(width), truncateToWidth(theme.fg("dim", "↑↓ select · Enter open · Esc back"), width)],
      handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
    };
  });
}
