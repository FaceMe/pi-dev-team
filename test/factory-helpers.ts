/** Scripted worker runner + UI for factory pipeline tests. */

import * as fs from "node:fs";
import * as path from "node:path";
import { emptyUsage } from "../src/shared/usage.js";
import type { FactoryUI, WorkerRequest, WorkerResult, WorkerRunner } from "../src/factory/types.js";

export type Script = (request: WorkerRequest, call: number) => { text: string; files?: Record<string, string | null | undefined>; cost?: number; error?: string };

export class ScriptedRunner implements WorkerRunner {
  calls: WorkerRequest[] = [];
  private counts = new Map<string, number>();

  constructor(private readonly scripts: Record<string, Script>) {}

  async run(request: WorkerRequest): Promise<WorkerResult> {
    this.calls.push(request);
    const n = (this.counts.get(request.role) ?? 0) + 1;
    this.counts.set(request.role, n);
    const script = this.scripts[request.role];
    const out = script ? script(request, n) : { text: "ok" };
    for (const [rel, content] of Object.entries(out.files ?? {})) {
      const file = path.join(request.cwd, rel);
      if (content === undefined) continue;
      if (content === null) fs.rmSync(file, { force: true });
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      }
    }
    const usage = emptyUsage();
    usage.totalTokens = 1000;
    usage.cost.total = out.cost ?? 0.01;
    return {
      text: out.text,
      usage,
      turns: 1,
      isError: Boolean(out.error),
      errorMessage: out.error,
      model: `${request.member.provider}/${request.member.modelId}`,
      trace: [],
      exitCode: out.error ? 1 : 0,
      stderr: "",
    };
  }

  count(role: string): number {
    return this.counts.get(role) ?? 0;
  }
}

export function scriptedUi(choices: { select?: (title: string, options: string[]) => string | undefined; input?: (title: string) => string | undefined } = {}) {
  const selects: Array<{ title: string; options: string[] }> = [];
  const logs: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const notes: string[] = [];
  const ui: FactoryUI = {
    notify: (message) => notes.push(message),
    select: async (title, options) => {
      selects.push({ title, options });
      return choices.select ? choices.select(title, options) : options[0];
    },
    input: async (title) => (choices.input ? choices.input(title) : undefined),
    confirm: async () => true,
    status: () => undefined,
    widget: () => undefined,
    log: (kind, data) => logs.push({ kind, data }),
  };
  return { ui, selects, logs, notes };
}

export const json = (value: unknown) => "```json\n" + JSON.stringify(value, null, 2) + "\n```";
