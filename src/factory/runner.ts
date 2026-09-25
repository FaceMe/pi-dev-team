/**
 * Worker runner: each role runs as a real `pi` subprocess in JSON mode.
 *
 * Why a subprocess: the worker loads the user's own pi setup (providers,
 * extensions such as pi-web-access, skills), gets pi's full agent loop with
 * compaction, keeps a persistent session per worker (so repeated calls reuse
 * its context and prompt cache), and a crash never takes down the user's pi.
 *
 * The child is marked with PI_FACTORY_WORKER=1 so this package's extensions
 * switch into worker mode (write-scope guard on, Fusion off unless requested).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addUsage, emptyUsage } from "../shared/usage.js";
import { buildTrace, describeActivity, extractFinalText } from "../shared/trace.js";
import { truncate } from "../shared/text.js";
import type { WorkerRequest, WorkerResult, WorkerRunner } from "./types.js";

export const WORKER_ENV = {
  worker: "PI_FACTORY_WORKER",
  role: "PI_FACTORY_ROLE",
  writeScope: "PI_FACTORY_WRITE_SCOPE",
  sidekick: "PI_FACTORY_SIDEKICK",
  allowDeploy: "PI_FACTORY_ALLOW_DEPLOY",
  piBin: "PI_FACTORY_PI_BIN",
} as const;

/** How to start pi: explicit override, the running pi's own entry script, or `pi` on PATH. */
export function piInvocation(args: string[], env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const override = env[WORKER_ENV.piBin];
  if (override) {
    return override.endsWith(".js") || override.endsWith(".mjs") || override.endsWith(".ts")
      ? { command: process.execPath, args: [override, ...args] }
      : { command: override, args };
  }
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && /pi|cli/i.test(path.basename(script)) && fs.existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }
  const exec = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(exec)) return { command: process.execPath, args };
  return { command: "pi", args };
}

export function buildWorkerArgs(request: WorkerRequest, promptFile: string): string[] {
  const args = [
    "--mode",
    "json",
    "-p",
    "--session-dir",
    request.sessionDir,
    "--session-id",
    request.sessionId,
    "--model",
    `${request.member.provider}/${request.member.modelId}`,
  ];
  if (request.member.effort) args.push("--thinking", request.member.effort);
  args.push(request.tools.length > 0 ? "--tools" : "--no-tools");
  if (request.tools.length > 0) args.push(request.tools.join(","));
  args.push("--append-system-prompt", promptFile, "--", request.prompt);
  return args;
}

/** Split a byte stream on LF only (JSON strings may contain U+2028/2029). */
export class JsonlSplitter {
  private buffer = "";
  push(chunk: string, onRecord: (record: any) => void): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      this.emit(line, onRecord);
      index = this.buffer.indexOf("\n");
    }
  }
  flush(onRecord: (record: any) => void): void {
    const rest = this.buffer;
    this.buffer = "";
    this.emit(rest, onRecord);
  }
  private emit(line: string, onRecord: (record: any) => void): void {
    if (!line.trim()) return;
    try {
      onRecord(JSON.parse(line));
    } catch {
      /* not a JSON record */
    }
  }
}

export class PiSubprocessRunner implements WorkerRunner {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async run(request: WorkerRequest): Promise<WorkerResult> {
    fs.mkdirSync(request.sessionDir, { recursive: true });
    const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-factory-"));
    const promptFile = path.join(promptDir, `${request.role}.md`);
    fs.writeFileSync(promptFile, request.systemPrompt, "utf8");

    const messages: any[] = [];
    const usage = emptyUsage();
    let stderr = "";
    const splitter = new JsonlSplitter();
    const modelKey = `${request.member.provider}/${request.member.modelId}`;

    const onRecord = (event: any): void => {
      if (event?.type === "message_end" && event.message) {
        const message = event.message;
        if (message.role === "assistant" || message.role === "toolResult") messages.push(message);
        if (message.role === "assistant") addUsage(usage, message.usage);
      } else if (event?.type === "tool_execution_start") {
        request.onActivity?.(describeActivity(String(event.toolName ?? "tool"), event.args ?? {}));
      }
    };

    const invocation = piInvocation(buildWorkerArgs(request, promptFile), this.env);
    const exitCode = await new Promise<number>((resolve) => {
      let settled = false;
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        resolve(code);
      };
      const child = spawn(invocation.command, invocation.args, {
        cwd: request.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          // Workers exit between phases and pi's cache warming stops with them;
          // long retention keeps their persistent sessions' caches alive across
          // the gap (where the provider supports it). An explicit setting wins.
          PI_CACHE_RETENTION: "long",
          ...this.env,
          [WORKER_ENV.worker]: "1",
          [WORKER_ENV.role]: request.role,
          [WORKER_ENV.writeScope]: JSON.stringify(request.writeScope),
          [WORKER_ENV.sidekick]: request.sidekick ? "1" : "0",
          [WORKER_ENV.allowDeploy]: request.allowDeploy ? "1" : "0",
        },
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => splitter.push(chunk, onRecord));
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-20_000);
      });
      child.on("error", (error) => {
        stderr += `\n${error.message}`;
        finish(127);
      });
      child.on("close", (code) => {
        splitter.flush(onRecord);
        finish(code ?? 1);
      });

      const kill = () => {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 5000).unref();
      };
      const timer = request.timeoutMs ? setTimeout(() => {
        stderr += `\n[factory] worker timed out after ${Math.round(request.timeoutMs! / 1000)}s`;
        kill();
      }, request.timeoutMs) : undefined;
      timer?.unref();
      child.on("close", () => timer && clearTimeout(timer));
      if (request.signal) {
        if (request.signal.aborted) kill();
        else request.signal.addEventListener("abort", kill, { once: true });
      }
    });

    fs.rmSync(promptDir, { recursive: true, force: true });

    const assistants = messages.filter((m) => m.role === "assistant");
    const last = assistants.at(-1);
    let isError = false;
    let errorMessage: string | undefined;
    if (last && (last.stopReason === "error" || last.stopReason === "aborted")) {
      isError = true;
      errorMessage = last.errorMessage ?? `worker stopped (${last.stopReason})`;
    } else if (exitCode !== 0 && !extractFinalText(messages)) {
      isError = true;
      errorMessage = truncate(stderr.trim() || `pi exited with code ${exitCode}`, 600);
    } else if (assistants.length === 0) {
      isError = true;
      errorMessage = truncate(stderr.trim() || "worker produced no response", 600);
    }

    return {
      text: extractFinalText(messages),
      usage,
      turns: assistants.length,
      isError,
      errorMessage,
      model: last?.model ? `${last.provider ?? request.member.provider}/${last.model}` : modelKey,
      trace: buildTrace(messages),
      exitCode,
      stderr,
    };
  }
}
