/**
 * Test doubles: models, a model registry, a recording ExtensionAPI, and a temp
 * agent directory (PI_CODING_AGENT_DIR) so config files never touch ~/.pi.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@earendil-works/pi-ai";

export function makeModel(partial: Partial<Model<any>> & { id: string; provider?: string }): Model<any> {
  return {
    name: partial.id,
    api: "faux",
    provider: "test",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_000,
    ...partial,
  } as Model<any>;
}

export function fakeRegistry(models: Model<any>[], available: Model<any>[] = models, extra: Record<string, any> = {}) {
  return {
    getAll: () => models,
    getAvailable: () => available,
    find: (provider: string, modelId: string) => models.find((m) => m.provider === provider && m.id === modelId),
    hasConfiguredAuth: (model: Model<any>) => available.includes(model),
    getProviderDisplayName: (provider: string) => provider,
    ...extra,
  } as any;
}

export interface RecordingPi {
  api: any;
  setModelCalls: Model<any>[];
  thinkingLevels: string[];
  entries: Array<{ type: string; data: unknown }>;
  tools: Map<string, any>;
  commands: Map<string, any>;
  handlers: Map<string, Array<(...args: any[]) => any>>;
  activeTools: string[];
  emitted: Array<{ name: string; data: unknown }>;
}

export function recordingPi(options: { setModelResult?: boolean } = {}): RecordingPi {
  const rec: RecordingPi = {
    api: undefined,
    setModelCalls: [],
    thinkingLevels: [],
    entries: [],
    tools: new Map(),
    commands: new Map(),
    handlers: new Map(),
    activeTools: [],
    emitted: [],
  };
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  rec.api = {
    setModel: async (model: Model<any>) => {
      rec.setModelCalls.push(model);
      return options.setModelResult ?? true;
    },
    setThinkingLevel: (level: string) => rec.thinkingLevels.push(level),
    appendEntry: (type: string, data: unknown) => rec.entries.push({ type, data }),
    registerTool: (tool: any) => rec.tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => rec.commands.set(name, command),
    registerShortcut: () => undefined,
    registerEntryRenderer: () => undefined,
    registerMessageRenderer: () => undefined,
    on: (event: string, handler: (...args: any[]) => any) => {
      const list = rec.handlers.get(event) ?? [];
      list.push(handler);
      rec.handlers.set(event, list);
      return () => undefined;
    },
    getActiveTools: () => [...rec.activeTools],
    setActiveTools: (names: string[]) => {
      rec.activeTools = [...names];
    },
    getAllTools: () => [...rec.tools.values()].map((tool) => ({ name: tool.name, description: tool.description })),
    events: {
      emit: (name: string, data: unknown) => {
        rec.emitted.push({ name, data });
        for (const listener of listeners.get(name) ?? []) listener(data);
      },
      on: (name: string, listener: (data: unknown) => void) => {
        const list = listeners.get(name) ?? [];
        list.push(listener);
        listeners.set(name, list);
        return () => undefined;
      },
    },
  };
  return rec;
}

export function fakeUi(answers: { select?: Array<string | undefined>; input?: Array<string | undefined>; confirm?: boolean[] } = {}) {
  const notes: Array<{ message: string; level?: string }> = [];
  const selects: Array<{ title: string; options: string[] }> = [];
  const selectQueue = [...(answers.select ?? [])];
  const inputQueue = [...(answers.input ?? [])];
  const confirmQueue = [...(answers.confirm ?? [])];
  const ui = {
    notify: (message: string, level?: string) => notes.push({ message, level }),
    select: async (title: string, options: string[]) => {
      selects.push({ title, options });
      return selectQueue.length > 0 ? selectQueue.shift() : options[0];
    },
    input: async () => (inputQueue.length > 0 ? inputQueue.shift() : undefined),
    confirm: async () => (confirmQueue.length > 0 ? confirmQueue.shift()! : true),
    setStatus: () => undefined,
    setWidget: () => undefined,
    custom: async () => undefined,
  };
  return { ui, notes, selects };
}

export function tempDir(prefix = "pi-mp-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Point pi's agent dir at a fresh temp directory for the duration of a test. */
export function useTempAgentDir(): { dir: string; restore: () => void } {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = tempDir("pi-agent-");
  process.env.PI_CODING_AGENT_DIR = dir;
  return {
    dir,
    restore: () => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
