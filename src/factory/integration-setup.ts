/** Project-level tool configuration. No server address or tool name is invented. */
import { DESIGN_PROVIDERS, integrationSettings } from "./integrations.js";
import type { IntegrationSettings, ToolBridge } from "./integrations.js";
import { detectBrave } from "./browser.js";
import type { FactoryUI } from "./types.js";

const SAVE = "Save integrations";
const BACK = "← Back";
const split = (value: string): string[] => [...new Set(value.split(/[,\n]/).map(item => item.trim()).filter(Boolean))];

export async function runIntegrationSetup(initial: unknown, ui: FactoryUI, availableTools: string[]): Promise<IntegrationSettings | undefined> {
  const config = integrationSettings(initial);
  let index = 0;
  for (;;) {
    const choices = [SAVE, ...DESIGN_PROVIDERS.map(provider => {
      const bridge = config.design?.[provider];
      return `${provider}: ${bridge && bridge.enabled !== false ? `${bridge.tools.length} configured tools` : "off"}`;
    }), `Brave browser QA: ${config.browser?.enabled ? "on" : "off"}`];
    const choice = await ui.select("Design and browser integrations", choices, { initialIndex: index });
    if (!choice) return undefined;
    if (choice === SAVE) return config;
    index = Math.max(0, choices.indexOf(choice));
    const provider = DESIGN_PROVIDERS.find(name => choice.startsWith(`${name}:`));
    if (provider) {
      const bridge: ToolBridge = { ...(config.design?.[provider] ?? { enabled: false, tools: [] }) };
      let row = 0;
      for (;;) {
        const options = [BACK, `Enabled: ${bridge.enabled !== false ? "yes" : "no"}`, `Tools: ${bridge.tools.join(", ") || "none"}`, `Bridge extension paths: ${bridge.extensions?.join(", ") || "auto-loaded by pi"}`, `Context: ${bridge.context || "none"}`];
        const selected = await ui.select(`${provider} MCP bridge`, options, { initialIndex: row });
        if (!selected || selected === BACK) break;
        row = Math.max(0, options.indexOf(selected));
        if (selected.startsWith("Enabled:")) bridge.enabled = bridge.enabled === false;
        else if (selected.startsWith("Tools:")) {
          const source = await ui.select("Tool names", ["Select a loaded tool", "Enter tool names", BACK]);
          if (source === "Select a loaded tool") {
            if (!availableTools.length) ui.notify("No extension tools are loaded. Configure a pi MCP bridge, then reload pi.", "info");
            else {
              const tool = await ui.select("Select tool to add or remove", [...availableTools.map(name => `${bridge.tools.includes(name) ? "✓ " : "  "}${name}`), BACK]);
              if (tool && tool !== BACK) {
                const name = tool.slice(2);
                bridge.tools = bridge.tools.includes(name) ? bridge.tools.filter(item => item !== name) : [...bridge.tools, name];
              }
            }
          } else if (source === "Enter tool names") {
            const value = await ui.input("Exact tool names, separated by commas", bridge.tools.join(", "));
            if (value !== undefined) bridge.tools = split(value);
          }
        } else if (selected.startsWith("Bridge extension")) {
          const value = await ui.input("Extension paths, separated by commas (blank uses pi defaults)", bridge.extensions?.join(", "));
          if (value !== undefined) bridge.extensions = split(value);
        } else {
          const value = await ui.input("Design file, project, or handoff context", bridge.context);
          if (value !== undefined) bridge.context = value.trim();
        }
      }
      config.design ??= {};
      config.design[provider] = bridge;
    } else if (choice.startsWith("Brave")) {
      const browser = config.browser ?? { enabled: false };
      let row = 0;
      for (;;) {
        const found = detectBrave(browser.executablePath);
        const options = [BACK, `Enabled: ${browser.enabled ? "yes" : "no"}`, `Executable: ${browser.executablePath || found || "not found"}`, "Use detected executable"];
        const selected = await ui.select("Brave QA — project-local Playwright required", options, { initialIndex: row });
        if (!selected || selected === BACK) break;
        row = Math.max(0, options.indexOf(selected));
        if (selected.startsWith("Enabled:")) browser.enabled = !browser.enabled;
        else if (selected.startsWith("Executable:")) {
          const value = await ui.input("Absolute path to the Brave executable", browser.executablePath ?? found);
          if (value !== undefined) browser.executablePath = value.trim() || undefined;
        } else browser.executablePath = undefined;
      }
      config.browser = browser;
    }
  }
}
