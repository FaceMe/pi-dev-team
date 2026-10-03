import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showSpecViewer } from "../src/factory/spec-view.js";
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getMarkdownTheme: () => Object.fromEntries(["heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder", "hr", "listBullet", "bold", "italic", "underline", "strikethrough"].map(key => [key, (text: string) => text])),
}));
describe("scrolling specification viewer", () => {
  it("scrolls the full document, pages, goes to the end, and clamps after resize", async () => {
    let component: any;
    const done = vi.fn();
    const tui = { terminal: { rows: 12 }, requestRender: vi.fn() };
    const theme = { bold: (text: string) => text, fg: (_color: string, text: string) => text };
    const ctx = { hasUI: true, mode: "tui", ui: { custom: async (factory: any) => { component = factory(tui, theme, {}, done); } } } as unknown as ExtensionContext;
    const content = Array.from({ length: 150 }, (_, index) => `Paragraph ${index + 1} with sufficiently long content to wrap at a narrow terminal width.`).join("\n\n");
    await showSpecViewer(ctx, "Review", content);
    expect(component.render(70).join("\n")).toContain("Paragraph 1 ");
    component.handleInput("\x1b[6~");
    expect(component.render(70).join("\n")).not.toContain("Paragraph 1 ");
    component.handleInput("\x1b[F");
    expect(component.render(70).join("\n")).toContain("Paragraph 150 ");
    tui.terminal.rows = 30;
    component.invalidate();
    const resized = component.render(35);
    expect(resized.length).toBeLessThanOrEqual(28);
    component.handleInput("\x1b[H");
    expect(component.render(70).join("\n")).toContain("Paragraph 1 ");
    component.handleInput("\x1b");
    expect(done).toHaveBeenCalledOnce();
    expect(tui.requestRender).toHaveBeenCalled();
  });
  it.each(["rpc", "print"])("avoids custom terminal UI in %s mode", async mode => {
    const custom = vi.fn();
    await showSpecViewer({ hasUI: true, mode, ui: { custom } } as unknown as ExtensionContext, "Review", "draft");
    expect(custom).not.toHaveBeenCalled();
  });
  it("closes an active viewer when the factory is paused", async () => {
    const controller = new AbortController();
    const done = vi.fn();
    const ctx = { hasUI: true, mode: "tui", ui: { custom: async (factory: any) => { factory({ terminal: { rows: 12 } }, {}, {}, done); } } } as unknown as ExtensionContext;
    await showSpecViewer(ctx, "Review", "draft", controller.signal);
    controller.abort();
    expect(done).toHaveBeenCalledOnce();
    const custom = vi.fn();
    await showSpecViewer({ hasUI: true, mode: "tui", ui: { custom } } as unknown as ExtensionContext, "Review", "draft", controller.signal);
    expect(custom).not.toHaveBeenCalled();
  });

});
