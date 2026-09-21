/**
 * Qwen (chat.qwen.ai) Brainstorm + Research Extension for Pi
 *
 * Connects Pi to https://chat.qwen.ai/ through the user's real Chrome session
 * (via the pi-browser-harness daemon's CDP bridge), so Alibaba's risk engine
 * sees genuine browser traffic — raw HTTP API calls from Node are blocked with
 * `RGV587_ERROR::SM` anti-bot denials.
 *
 * Provides:
 * 1. Tool `qwen_brainstorm` — brainstorm with any Qwen chat model (multi-turn,
 *    6 modes, optional web search).
 * 2. Tool `qwen_research` — web-search / deep-research augmented answers with
 *    citations.
 * 3. Commands `/qwen`, `/brainstorm`, `/qwen-research`, `/qwen-auth`.
 *
 * Auth uses the browser session itself: log in to chat.qwen.ai once in the
 * connected Chrome profile (`/qwen-auth` opens and verifies it) and everything
 * else rides the logged-in page.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

// --- Configuration ---

const QWEN_ORIGIN = "https://chat.qwen.ai";
const DEFAULT_MODEL = "qwen3.8-max";
const POLL_MS = 1200;
const SEND_SETTLE_MS = 1500;

type QwenMode = "default" | "search" | "deep_research";
type ThinkingPref = "Auto" | "Thinking" | "Fast";

interface QwenConfig {
	defaultModel?: string;
	defaultThinking?: ThinkingPref;
	timeoutSec?: number;
	researchTimeoutSec?: number;
	deepResearchTimeoutSec?: number;
}

function configPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "qwen.json");
}

function loadConfig(): QwenConfig {
	try {
		return JSON.parse(fs.readFileSync(configPath(), "utf8")) as QwenConfig;
	} catch {
		return {};
	}
}

function saveConfig(update: Partial<QwenConfig>): QwenConfig {
	const next = { ...loadConfig(), ...update };
	const dir = path.dirname(configPath());
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
	return next;
}

function socketCandidates(): string[] {
	const list: string[] = [];
	if (process.env.PI_BROWSER_DAEMON_SOCK) list.push(process.env.PI_BROWSER_DAEMON_SOCK);
	list.push("/tmp/pi-browser-daemon.sock");
	if (process.platform === "win32") list.push("\\\\.\\pipe\\pi-browser-daemon.sock");
	return list;
}

// --- CDP-over-daemon client ---
// The pi-browser-harness daemon multiplexes raw CDP over a newline-delimited
// JSON unix socket: {type:"control",action:"register",clientId} then
// {type:"request",id,method,params,sessionId?} -> {type:"response",id,result|error}.

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

class QwenBrowserClient {
	private socket: net.Socket | null = null;
	private pending = new Map<number, Pending>();
	private nextId = 0;
	private buffer = "";
	private sessionId: string | null = null;
	private connecting: Promise<void> | null = null;
	private queue: Promise<any> = Promise.resolve();

	private findSocketPath(): string | null {
		for (const p of socketCandidates()) {
			try {
				if (fs.existsSync(p)) return p;
			} catch {
				/* ignore */
			}
		}
		return null;
	}

	isAvailable(): boolean {
		return this.findSocketPath() !== null;
	}

	connect(): Promise<void> {
		if (this.socket && this.sessionId) return Promise.resolve();
		if (this.connecting) return this.connecting;
		this.connecting = new Promise<void>((resolve, reject) => {
			const sockPath = this.findSocketPath();
			if (!sockPath) {
				reject(new Error("Browser daemon not running. Open pi's browser harness first: run /browser-setup in pi, then retry."));
				return;
			}
			const socket = net.createConnection(sockPath);
			let registered = false;
			const fail = (err: Error) => {
				if (!registered) reject(err);
			};
			socket.on("error", (e) => fail(new Error(`Browser daemon connection failed: ${e.message}`)));
			socket.on("connect", () => {
				const clientId = `pi-qwen-ext-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
				socket.write(JSON.stringify({ type: "control", action: "register", clientId }) + "\n");
			});
			socket.on("data", (d) => {
				this.buffer += d.toString();
				let idx: number;
				while ((idx = this.buffer.indexOf("\n")) >= 0) {
					const line = this.buffer.slice(0, idx);
					this.buffer = this.buffer.slice(idx + 1);
					if (!line.trim()) continue;
					let msg: any;
					try {
						msg = JSON.parse(line);
					} catch {
						continue;
					}
					if (msg.type === "control" && msg.action === "registered") {
						registered = true;
						this.socket = socket;
						resolve();
					} else if (msg.type === "response" && msg.id && this.pending.has(msg.id)) {
						const p = this.pending.get(msg.id)!;
						this.pending.delete(msg.id);
						clearTimeout(p.timer);
						if (msg.error) p.reject(new Error(`CDP ${msg.error.message ?? JSON.stringify(msg.error)}`));
						else p.resolve(msg.result);
					}
				}
			});
			socket.on("close", () => {
				this.socket = null;
				this.sessionId = null;
				for (const [, p] of this.pending) {
					clearTimeout(p.timer);
					p.reject(new Error("Browser daemon connection closed"));
				}
				this.pending.clear();
			});
		});
		this.connecting.finally(() => {
			this.connecting = null;
		});
		return this.connecting;
	}

	private request(method: string, params: any, sessionId?: string | null, timeoutMs = 12000): Promise<any> {
		// Serialize to keep request/response pairing simple.
		const run = async () => {
			await this.connect();
			const id = ++this.nextId;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
				}, timeoutMs);
				this.pending.set(id, { resolve, reject, timer });
				this.socket!.write(
					JSON.stringify({ type: "request", id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\n",
				);
			});
		};
		const chained = this.queue.then(run, run);
		this.queue = chained.catch(() => {});
		return chained;
	}

	async ensureQwenTab(ctx?: { log?: (msg: string) => void }): Promise<string> {
		await this.connect();
		const targets = await this.request("Target.getTargets");
		const pages: any[] = (targets?.targetInfos ?? []).filter((t: any) => t.type === "page");
		let qwen = pages.find((t) => (t.url || "").includes("chat.qwen.ai"));
		if (!qwen) {
			ctx?.log?.(`Opening ${QWEN_ORIGIN} in a new browser tab…`);
			const created = await this.request("Target.createTarget", { url: QWEN_ORIGIN });
			const targetId = created?.targetId;
			// Wait for the SPA to settle
			const deadline = Date.now() + 20000;
			while (Date.now() < deadline) {
				await sleep(1000);
				try {
					const ready = await this.evaluate(`document.readyState === 'complete' && !!document.querySelector('textarea')`, false);
					if (ready) break;
				} catch {
					/* retry */
				}
			}
			qwen = { targetId };
		}
		const att = await this.request("Target.attachToTarget", { targetId: qwen.targetId, flatten: true });
		this.sessionId = att.sessionId;
		return qwen.targetId;
	}

	async evaluate(expression: string, awaitPromise = false, timeoutMs = 12000): Promise<any> {
		if (!this.sessionId) throw new Error("Not attached to a chat.qwen.ai tab");
		const r = await this.request(
			"Runtime.evaluate",
			{ expression, returnByValue: true, awaitPromise, userGesture: true },
			this.sessionId,
			timeoutMs,
		);
		if (r?.exceptionDetails) {
			const desc = r.exceptionDetails?.exception?.description || r.exceptionDetails?.text || "page error";
			throw new Error(`Page evaluation failed: ${String(desc).slice(0, 300)}`);
		}
		return r?.result?.value;
	}

	/** Real mouse click at viewport coordinates (works for hover-triggered menus). */
	async clickAt(x: number, y: number): Promise<void> {
		if (!this.sessionId) throw new Error("Not attached to a chat.qwen.ai tab");
		const base = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 };
		await this.request("Input.dispatchMouseEvent", { type: "mouseMoved", x: base.x, y: base.y }, this.sessionId);
		await sleep(60);
		await this.request("Input.dispatchMouseEvent", { type: "mousePressed", ...base }, this.sessionId);
		await sleep(40);
		await this.request("Input.dispatchMouseEvent", { type: "mouseReleased", ...base }, this.sessionId);
	}

	detach(): void {
		this.sessionId = null;
		try {
			this.socket?.end();
		} catch {
			/* ignore */
		}
		this.socket = null;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// --- Page-side snippets ---

/** Install the streaming hook: tracks chat completion + captures SSE phases. */
const PAGE_INSTALL_HOOK = `(() => {
  if (window.__piQwen?.hooked) return window.__piQwen.meta();
  const state = window.__piQwen || (window.__piQwen = {});
  state.hooked = true;
  state.reset = (chatId) => { state.stream = { busy: 0, chunks: 0, bytes: 0, thinking: '', thinkingTitle: '', answer: '', responseId: null, sources: [], phases: [], chatId: chatId || null, startedAt: 0, endedAt: 0 }; };
  state.meta = () => ({ hooked: true });
  state.reset();
  const of = window.fetch;
  if (!of.__piQwenPatched) {
    const patched = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.includes('chat/completions')) {
          const s = state.stream;
          s.busy++; s.chunks = 0; s.bytes = 0; s.thinking = ''; s.thinkingTitle = ''; s.answer = ''; s.responseId = null; s.sources = []; s.phases = []; s.startedAt = Date.now(); s.endedAt = 0;
          const m = url.match(/chat_id=([a-f0-9-]+)/); if (m) s.chatId = m[1];
          const p = of.apply(this, arguments);
          p.then((res) => {
            if (!res || !res.body) { s.busy = Math.max(0, s.busy - 1); s.endedAt = Date.now(); return; }
            let clone;
            try { clone = res.clone(); } catch (e) { s.busy = Math.max(0, s.busy - 1); s.endedAt = Date.now(); return; }
            const reader = clone.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            const pump = () => reader.read().then(({ done, value }) => {
              if (done) { s.busy = Math.max(0, s.busy - 1); s.endedAt = Date.now(); return; }
              s.chunks++; s.bytes += value ? value.length : 0;
              buf += dec.decode(value, { stream: true });
              const lines = buf.split('\\n'); buf = lines.pop() || '';
              for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith('data:')) continue;
                const payload = t.slice(5).trim();
                if (payload === '[DONE]') continue;
                try {
                  const ev = JSON.parse(payload);
                  const created = ev.response_created;
                  if (created) {
                    if (created.response_id) s.responseId = created.response_id;
                    if (created.chat_id) s.chatId = created.chat_id;
                  }
                  if (ev.response_id) s.responseId = ev.response_id;
                  const wsi = ev.extra && ev.extra.web_search_info;
                  if (Array.isArray(wsi)) for (const w of wsi) {
                    if (w && (w.url || w.title)) {
                      const item = { title: (w.title || '').slice(0, 140), url: w.url || '' };
                      if (item.url && !s.sources.some((x) => x.url === item.url)) s.sources.push(item);
                    }
                  }
                  const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
                  if (d) {
                    if (d.phase && s.phases[s.phases.length - 1] !== d.phase) s.phases.push(d.phase);
                    // thinking summaries resend the full text each event — replace, not append
                    const sth = d.extra && d.extra.summary_thought && d.extra.summary_thought.content;
                    const sti = d.extra && d.extra.summary_title && d.extra.summary_title.content;
                    if (Array.isArray(sth) && sth.length) s.thinking = sth.join('');
                    if (Array.isArray(sti) && sti.length) s.thinkingTitle = sti.join('');
                    if (typeof d.content === 'string' && d.content) {
                      const ph = d.phase;
                      if (!ph || ph === 'answer') s.answer += d.content;
                    }
                  }
                } catch (e) { /* partial json */ }
              }
              pump();
            }).catch(() => { s.busy = Math.max(0, s.busy - 1); s.endedAt = Date.now(); });
            pump();
          }).catch(() => { s.busy = Math.max(0, s.busy - 1); s.endedAt = Date.now(); });
          return p;
        }
      } catch (e) { /* fallthrough */ }
      return of.apply(this, arguments);
    };
    patched.__piQwenPatched = true;
    window.fetch = patched;
  }
  return state.meta();
})()`;

const PAGE_READ_STREAM = `(() => {
  const s = window.__piQwen?.stream;
  if (!s) return null;
  return { busy: s.busy, chunks: s.chunks, bytes: s.bytes, thinking: s.thinking, thinkingTitle: s.thinkingTitle, answer: s.answer, responseId: s.responseId, sources: s.sources, phases: s.phases, chatId: s.chatId, startedAt: s.startedAt, endedAt: s.endedAt };
})()`;

const PAGE_CHAT_STATE = `(() => {
  const stop = [...document.querySelectorAll('button')].some((b) => {
    const lbl = (b.getAttribute('aria-label') || b.getAttribute('title') || b.innerText || '').trim().toLowerCase();
    return lbl === 'stop' && b.getBoundingClientRect().width > 0;
  });
  const msgs = [...document.querySelectorAll('[id^=chat-response-message-]')];
  return { stop, count: msgs.length, url: location.href };
})()`;

const PAGE_EXTRACT = `(() => {
  const msgs = [...document.querySelectorAll('[id^=chat-response-message-]')];
  const last = msgs[msgs.length - 1];
  if (!last) return null;
  const contents = [...last.querySelectorAll('[class*=response-message-content]')];
  const answerEl = contents.find((el) => /phase-answer/.test(el.className)) || contents[contents.length - 1];
  const anchors = [...last.querySelectorAll('a[href], [class*=citation]')];
  const citations = anchors.map((a) => {
    const cls = typeof a.className === 'string' ? a.className : '';
    const isCitation = /citation|source/i.test(cls) || !!a.closest('[class*=citation]');
    if (!isCitation) return null;
    const link = a.tagName === 'A' ? a : a.querySelector('a[href]') || a.closest('a[href]');
    const url = (link && link.href) || a.getAttribute('data-url') || a.getAttribute('data-href') || '';
    return { title: (a.innerText || '').trim().slice(0, 140), url };
  }).filter(Boolean);
  const unique = [];
  for (const c of citations) if (!unique.some((u) => u.url === c.url)) unique.push(c);
  return {
    answer: answerEl ? answerEl.innerText : null,
    whole: last.innerText,
    citations: unique,
    responseId: (last.id || '').replace('chat-response-message-', ''),
  };
})()`;

const PAGE_NEW_CHAT = `(() => {
  const el = [...document.querySelectorAll('button, a, [role=button]')].find((x) => {
    const label = ((x.innerText || '') + ' ' + (x.getAttribute('aria-label') || '') + ' ' + (x.getAttribute('title') || '')).trim().toLowerCase();
    if (!label.includes('new chat')) return false;
    const r = x.getBoundingClientRect();
    return r.width > 0 && r.width < 400;
  });
  if (!el) return 'missing';
  el.click();
  return 'clicked';
})()`;

const PAGE_THINKING_CHIP = `(() => {
  const chip = [...document.querySelectorAll('button, [role=button]')].find((el) => ['auto', 'thinking', 'fast'].includes((el.innerText || '').trim().toLowerCase()) && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().width < 150);
  return chip ? (chip.innerText || '').trim() : null;
})()`;

const PAGE_THINKING_SELECT = (want: string) => `(() => {
  const chip = [...document.querySelectorAll('button, [role=button]')].find((el) => ['auto', 'thinking', 'fast'].includes((el.innerText || '').trim().toLowerCase()) && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().width < 150);
  if (!chip) return 'no-chip';
  chip.click();
  return 'opened';
})()`;

const PAGE_THINKING_CLICK_ITEM = (want: string) => `(() => {
  const item = [...document.querySelectorAll('[role=menuitem], [role=option], [class*=dropdown-menu-item]')].find((el) => (el.innerText || '').trim().toLowerCase().startsWith('${want.toLowerCase()}') && el.getBoundingClientRect().width > 0);
  if (!item) return 'missing';
  item.click();
  return 'clicked';
})()`;

const PAGE_MODE_OPEN = `(() => {
  const el = document.querySelector('.mode-select-open, .mode-select');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`;

const PAGE_MODE_READ = `(() => {
  const el = document.querySelector('.mode-select-open, .mode-select');
  return el ? (el.innerText || '').trim().slice(0, 40) : null;
})()`;

const PAGE_MODE_CLICK_ITEM = (label: string) => `(() => {
  const it = [...document.querySelectorAll('[role=menuitem], .ant-dropdown-menu-item')].find((el) => (el.innerText || '').trim().startsWith(${JSON.stringify(label)}) && el.getBoundingClientRect().width > 0);
  if (!it) return null;
  const r = it.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`;

const PAGE_MODEL_BUTTON_LABEL = `(() => {
  const btn = document.querySelector('[aria-label="Select Model"], [class*=wms-trigger]') || [...document.querySelectorAll('[role=button], button')].find((b) => (b.innerText || '').includes('Qwen') && b.getBoundingClientRect().top < 120);
  return btn ? (btn.innerText || '').trim() : null;
})()`;

const PAGE_MODEL_OPEN = `(() => {
  const btn = document.querySelector('[aria-label="Select Model"], [class*=wms-trigger]') || [...document.querySelectorAll('[role=button], button')].find((b) => (b.innerText || '').includes('Qwen') && b.getBoundingClientRect().top < 120);
  if (!btn) return null;
  btn.click();
  const r = btn.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`;

const PAGE_MODEL_CLICK = (name: string) => `(() => {
  const target = ${JSON.stringify(name)}.toLowerCase();
  const items = [...document.querySelectorAll('[role=option], [role=menuitem], li, div')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 150 && r.height > 30 && r.height < 140 && (el.innerText || '').trim().toLowerCase().startsWith(target);
  });
  const item = items[items.length - 1];
  if (!item) return 'missing';
  item.click();
  return 'clicked';
})()`;

const PAGE_SEND = `((text) => {
  const ta = document.querySelector('textarea');
  if (!ta) return 'no-composer';
  ta.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, text);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return new Promise((resolve) => setTimeout(() => {
    const btns = [...document.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().width > 0);
    const send = btns.find((b) => {
      const lbl = (b.getAttribute('aria-label') || b.getAttribute('title') || '').toLowerCase();
      return !lbl.includes('voice') && !lbl.includes('stop') && (/send|submit/.test(lbl) || /send-btn|send-button|input-send/.test(typeof b.className === 'string' ? b.className : ''));
    });
    if (send) { send.click(); resolve('sent-button'); return; }
    const kev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
    ta.dispatchEvent(kev);
    resolve(kev.defaultPrevented ? 'enter-blocked' : 'sent-enter');
  }, 150));
})(${JSON.stringify('%%PROMPT%%')})`;

const PAGE_LOGIN_INFO = `(async () => {
  const token = localStorage.getItem('token');
  if (!token) return { loggedIn: false };
  try {
    const res = await fetch('/api/v1/auths/', { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return { loggedIn: false, status: res.status };
    const data = await res.json();
    return { loggedIn: true, email: data?.email || null, name: data?.name || null };
  } catch (e) { return { loggedIn: false, error: String(e).slice(0, 120) }; }
})()`;

const PAGE_LIST_MODELS = `(async () => {
  const token = localStorage.getItem('token');
  const res = await fetch('/api/v2/models/', { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  if (!res.ok) return { error: 'HTTP ' + res.status };
  const json = await res.json();
  const items = json?.data?.data || [];
  return { models: items.map((m) => ({ id: m.id, name: m.name })) };
})()`;

// --- High-level operations ---

function stripThinkingLine(text: string): string {
	return text.replace(/^(Thinking (completed|\.+|skipped)|Searched[^\n]*|Reading[^\n]*|Web search)\s*\n/i, "").trimStart();
}

async function waitFor(expr: () => Promise<any>, check: (v: any) => boolean, timeoutMs: number, intervalMs = 500): Promise<any> {
	const deadline = Date.now() + timeoutMs;
	let last: any;
	while (Date.now() < deadline) {
		last = await expr();
		if (check(last)) return last;
		await sleep(intervalMs);
	}
	return last;
}

let client: QwenBrowserClient | null = null;

function getClient(): QwenBrowserClient {
	if (!client) client = new QwenBrowserClient();
	return client;
}

async function ensureConnected(ctx?: { log?: (msg: string) => void }): Promise<QwenBrowserClient> {
	const c = getClient();
	await c.ensureQwenTab(ctx);
	await c.evaluate(PAGE_INSTALL_HOOK, false);
	return c;
}

async function loginInfo(c: QwenBrowserClient): Promise<{ loggedIn: boolean; email?: string | null; name?: string | null }> {
	return await c.evaluate(PAGE_LOGIN_INFO, true);
}

async function listModels(c: QwenBrowserClient): Promise<Array<{ id: string; name: string }>> {
	const res = await c.evaluate(PAGE_LIST_MODELS, true);
	if (res?.error) throw new Error(`Model list failed: ${res.error}`);
	return res?.models ?? [];
}

async function newChat(c: QwenBrowserClient): Promise<void> {
	const res = await c.evaluate(PAGE_NEW_CHAT, false);
	if (res !== "clicked") throw new Error("Could not find the New Chat button on chat.qwen.ai");
	await sleep(900);
}

async function currentModel(c: QwenBrowserClient): Promise<string | null> {
	return await c.evaluate(PAGE_MODEL_BUTTON_LABEL, false);
}

async function selectModel(c: QwenBrowserClient, modelId: string, log?: (m: string) => void): Promise<void> {
	const models = await listModels(c);
	const found = models.find((m) => m.id.toLowerCase() === modelId.toLowerCase());
	const displayName = found?.name ?? modelId;
	const before = await currentModel(c);
	if (before && before.toLowerCase() === displayName.toLowerCase()) return;
	log?.(`Switching model to ${displayName}…`);
	const opened = await c.evaluate(PAGE_MODEL_OPEN, false);
	if (!opened) throw new Error("Could not find the model selector on chat.qwen.ai");
	// .click() usually opens the wms dropdown; if not, use a real mouse click.
	let itemsVisible = (await c.evaluate(PAGE_MODEL_CLICK(displayName), false)) === "clicked";
	if (!itemsVisible) {
		await c.clickAt(opened.x, opened.y);
		await sleep(400);
		itemsVisible = (await c.evaluate(PAGE_MODEL_CLICK(displayName), false)) === "clicked";
	}
	if (!itemsVisible) throw new Error(`Model "${displayName}" not found in the chat.qwen.ai model picker (account models: ${models.map((m) => m.id).join(", ") || "unknown"})`);
	await waitFor(
		() => currentModel(c),
		(v) => !!v && v.toLowerCase() === displayName.toLowerCase(),
		5000,
		300,
	);
	await sleep(300);
}

async function setThinking(c: QwenBrowserClient, want: ThinkingPref): Promise<void> {
	const now = await c.evaluate(PAGE_THINKING_CHIP, false);
	if (!now || now.toLowerCase() === want.toLowerCase()) return;
	await c.evaluate(PAGE_THINKING_SELECT(want), false);
	await sleep(350);
	const clicked = await c.evaluate(PAGE_THINKING_CLICK_ITEM(want), false);
	if (clicked === "clicked") {
		await waitFor(() => c.evaluate(PAGE_THINKING_CHIP, false), (v) => !!v && v.toLowerCase() === want.toLowerCase(), 4000, 300);
	}
}

async function setMode(c: QwenBrowserClient, mode: QwenMode, log?: (m: string) => void): Promise<void> {
	const label = mode === "search" ? "Web search" : mode === "deep_research" ? "Deep Research" : null;
	const current = await c.evaluate(PAGE_MODE_READ, false);

	const openMenu = async () => {
		const pos = await c.evaluate(PAGE_MODE_OPEN, false);
		if (!pos) throw new Error("Could not find the mode selector on chat.qwen.ai");
		// The mode dropdown is hover-triggered — a real mouse click is required.
		await c.clickAt(pos.x, pos.y);
		await sleep(450);
	};

	const itemPos = async (itemLabel: string): Promise<{ x: number; y: number } | null> => {
		for (let attempt = 0; attempt < 3; attempt++) {
			const pos = await c.evaluate(PAGE_MODE_CLICK_ITEM(itemLabel), false);
			if (pos) return pos;
			await openMenu();
		}
		return null;
	};

	if (label === null) {
		// default mode: an active feature chip (e.g. "Web search") must be turned off
		if (current && !current.toLowerCase().startsWith("select mode")) {
			log?.(`Resetting chat mode (was "${current}")…`);
			const pos = await itemPos(current);
			if (pos) {
				await c.clickAt(pos.x, pos.y);
				await sleep(400);
			}
			const after = await c.evaluate(PAGE_MODE_READ, false);
			if (after && !after.toLowerCase().startsWith("select mode")) {
				log?.("Could not reset mode; starting a fresh chat instead.");
				await newChat(c);
			}
		}
		return;
	}

	if (current && current.toLowerCase().startsWith(label.toLowerCase())) return;
	log?.(`Enabling ${label} mode…`);
	const pos = await itemPos(label);
	if (!pos) throw new Error(`Could not select "${label}" from the chat.qwen.ai mode menu`);
	await c.clickAt(pos.x, pos.y);
	await waitFor(
		() => c.evaluate(PAGE_MODE_READ, false),
		(v) => !!v && v.toLowerCase().startsWith(label.toLowerCase()),
		5000,
		300,
	);
}

interface AskResult {
	answer: string;
	thinking: string;
	sources: Array<{ title: string; url: string }>;
	responseId: string | null;
	chatId: string | null;
	modelLabel: string | null;
	durationMs: number;
}

async function ask(
	c: QwenBrowserClient,
	prompt: string,
	opts: { timeoutMs: number; thinking?: ThinkingPref; onUpdate?: (progress: string) => void; signal?: AbortSignal },
): Promise<AskResult> {
	const started = Date.now();
	const modelLabel = await currentModel(c);
	const before = await c.evaluate(PAGE_CHAT_STATE, false);
	if (before?.stop) {
		throw new Error("chat.qwen.ai is still generating a previous response — wait for it to finish or run /qwen new");
	}

	if (opts.thinking) await setThinking(c, opts.thinking);

	// reset stream capture for this turn
	await c.evaluate(`window.__piQwen.reset(${JSON.stringify(null)})`, false);

	const sendStartedAt = Date.now();
	const sendResult = await c.evaluate(PAGE_SEND.replace('"%%PROMPT%%"', JSON.stringify(prompt)), true, 15000);
	if (sendResult === "no-composer") throw new Error("Chat composer not found on chat.qwen.ai");
	if (sendResult === "enter-blocked") throw new Error("Could not send the prompt (Enter was not accepted). Try again.");
	await sleep(SEND_SETTLE_MS);

	let lastAnswer = "";
	let stablePolls = 0;
	const deadline = sendStartedAt + opts.timeoutMs;

	while (Date.now() < deadline) {
		if (opts.signal?.aborted) throw new Error("Cancelled");
		await sleep(POLL_MS);
		let chat: any;
		let stream: any;
		try {
			chat = await c.evaluate(PAGE_CHAT_STATE, false);
			stream = await c.evaluate(PAGE_READ_STREAM, false);
		} catch {
			continue; // transient page hiccup — retry
		}
		// A new stream must have started after we sent (guards against stale state).
		const newStream = !!stream && stream.startedAt >= sendStartedAt - 500;
		const phase = stream?.phases?.[stream.phases.length - 1] ?? "";
		opts.onUpdate?.(
			`\u23f3 Qwen working… ${stream?.bytes ?? 0} bytes` +
				(stream?.answer ? `, answer ${stream.answer.length} chars` : stream?.thinking ? `, thinking ${stream.thinking.length} chars` : "") +
				(phase ? ` [${phase.replace(/_/g, " ")}]` : ""),
		);

		// The hook gives the authoritative completion signal: its SSE reader
		// finished (endedAt > 0) for a stream that began after our send.
		if (!chat?.stop && newStream && (stream?.busy ?? 0) === 0 && (stream?.endedAt ?? 0) > 0) {
			let text = (stream?.answer ?? "").trim();
			if (!text) {
				// fall back to the DOM answer, requiring stability across polls
				const extract = await c.evaluate(PAGE_EXTRACT, false);
				const domText = extract?.answer ?? (extract?.whole ? stripThinkingLine(extract.whole) : "");
				if (domText && domText === lastAnswer) {
					stablePolls++;
					if (stablePolls < 2) continue;
					text = domText;
				} else {
					stablePolls = 0;
					lastAnswer = domText;
					continue;
				}
			}
			if (!text) continue; // stream done but no answer captured yet — keep polling
			const sources = [...(stream?.sources ?? [])];
			const extract2 = await c.evaluate(PAGE_EXTRACT, false);
			for (const cit of extract2?.citations ?? []) {
				if (!sources.some((s) => s.url === cit.url)) sources.push(cit);
			}
			return {
				answer: text,
				thinking: stream?.thinking ?? "",
				sources,
				responseId: stream?.responseId ?? extract2?.responseId ?? null,
				chatId: stream?.chatId ?? null,
				modelLabel,
				durationMs: Date.now() - started,
			};
		}
	}
	throw new Error(
		`chat.qwen.ai did not finish within ${Math.round(opts.timeoutMs / 1000)}s. The response may still be streaming in the browser tab — check it there, or raise the timeout via /qwen config.`,
	);
}

// --- Brainstorm prompt engineering ---

type BrainstormMode = "general" | "divergent" | "critical" | "comparative" | "deep" | "synthesis";

const MODE_INSTRUCTIONS: Record<BrainstormMode, string> = {
	divergent:
		"MODE: DIVERGENT EXPLORATION\n- Generate 5-7 distinctly different architectural paradigms or ideas, from proven industry standards to unconventional, cutting-edge angles.\n- For each option, define its core philosophy, primary strengths, trade-offs, and unexpected advantages.",
	critical:
		"MODE: ADVERSARIAL STRESS-TEST & CRITIQUE\n- Act as a principal systems architect stress-testing this design/idea.\n- Identify hidden failure modes, race conditions, scaling bottlenecks, and security risks.\n- Propose concrete mitigations for every flaw found.",
	comparative:
		"MODE: OBJECTIVE TRADE-OFF MATRIX\n- Compare the top 3 viable approaches side-by-side across Latency/Performance, Operational Complexity, Cognitive Overhead, Scalability, and Implementation Velocity.\n- Provide a decision matrix showing which choice wins under which constraints.",
	deep:
		"MODE: DEEP TECHNICAL BREAKDOWN\n- Provide an in-depth, production-ready technical architecture with component boundaries, data contracts, state lifecycle, error recovery, and implementation milestones.",
	synthesis:
		"MODE: PRAGMATIC SYNTHESIS & EXECUTION PLAN\n- Distill the solution into: 1. Core decision, 2. Minimum viable implementation, 3. Critical guardrails, 4. Immediate next steps.",
	general:
		"MODE: COMPREHENSIVE BRAINSTORM\n- Explore non-obvious perspectives, innovative angles, and technical alternatives.\n- Cover: 1. Core opportunities, 2. Competing approaches, 3. Key trade-offs & risks, 4. Concrete recommendations.",
};

function wrapBrainstormPrompt(topic: string, mode: BrainstormMode): string {
	return (
		`[BRAINSTORMING REQUEST]\n\nTOPIC / PROBLEM STATEMENT:\n${topic}\n\nBRAINSTORMING DIRECTIVE:\n${MODE_INSTRUCTIONS[mode] ?? MODE_INSTRUCTIONS.general}\n\n` +
		`Use your full reasoning capacity before producing the final synthesis.`
	);
}

function formatResult(result: AskResult, header: string): string {
	const parts: string[] = [`## ${header}`, "", result.answer];
	if (result.sources.length > 0) {
		parts.push("", "### Sources", "");
		result.sources.slice(0, 12).forEach((s, i) => {
			parts.push(`${i + 1}. ${s.title || s.url}${s.url ? ` — ${s.url}` : ""}`);
		});
	}
	if (result.thinking && result.thinking.length > 0) {
		parts.push("", `<details><summary>Thinking process (${result.thinking.length} chars)</summary>\n\n${result.thinking.slice(0, 4000)}\n\n</details>`);
	}
	return parts.join("\n");
}

function describeError(err: unknown): string {
	const msg = err instanceof Error ? err.message : String(err);
	if (/daemon not running|browser-setup/i.test(msg)) {
		return "The pi browser harness is not connected. Run /browser-setup first (it connects pi to your Chrome), make sure Chrome is open, then retry.";
	}
	if (/ERR_NAME_NOT_RESOLVED|net::ERR|Timeout.*tab/i.test(msg)) {
		return `Could not reach chat.qwen.ai: ${msg}`;
	}
	return msg;
}

// --- Extension ---

export default function qwenExtension(pi: ExtensionAPI) {
	const configured = () => loadConfig();

	const runAsk = async (
		opts: {
			prompt: string;
			mode: QwenMode;
			thinking: ThinkingPref;
			model?: string;
			newChat?: boolean;
			header: string;
			timeoutMs: number;
			onUpdate?: (p: string) => void;
			signal?: AbortSignal;
		},
	): Promise<AskResult> => {
		const cfg = configured();
		const c = await ensureConnected({ log: opts.onUpdate });
		const info = await loginInfo(c);
		if (!info.loggedIn) {
			throw new Error(
				"You are not logged in to chat.qwen.ai in the connected Chrome profile. Open the chat.qwen.ai tab that was just checked, log in, then retry. (/qwen-auth re-checks automatically.)",
			);
		}
		if (opts.newChat) await newChat(c);
		const modelId = opts.model || cfg.defaultModel || DEFAULT_MODEL;
		await selectModel(c, modelId, opts.onUpdate);
		await setMode(c, opts.mode, opts.onUpdate);
		return await ask(c, opts.prompt, {
			timeoutMs: opts.timeoutMs,
			thinking: opts.thinking ?? cfg.defaultThinking ?? "Auto",
			onUpdate: opts.onUpdate,
			signal: opts.signal,
		});
	};

	// --- Tool: qwen_brainstorm ---
	pi.registerTool({
		name: "qwen_brainstorm",
		label: "Qwen Brainstorm",
		description:
			"Brainstorm ideas, architecture, trade-offs, and stress-tests with Qwen models (qwen3.8-max and others) on chat.qwen.ai via the user's logged-in Chrome session. Multi-turn within a session; supports an optional web search.",
		promptSnippet:
			"qwen_brainstorm: Brainstorm with Qwen 3.8 MAX and other models on chat.qwen.ai for architecture, trade-offs, and critical exploration.",
		promptGuidelines: [
			"Use qwen_brainstorm when designing complex systems, evaluating architectural trade-offs, stress-testing ideas, or when the user asks to brainstorm with Qwen.",
			"qwen_brainstorm modes: 'general', 'divergent' (broad creative options), 'critical' (stress-test and failure modes), 'comparative' (trade-off matrix), 'deep' (in-depth architecture), 'synthesis' (pragmatic action plan).",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "The topic, technical question, architecture, or idea to brainstorm with Qwen." }),
			mode: Type.Optional(
				Type.String({
					description: "Brainstorming mode: 'general' (default), 'divergent', 'critical', 'comparative', 'deep', or 'synthesis'.",
				}),
			),
			thinking: Type.Optional(Type.Boolean({ description: "Deep reasoning before the answer (default true; 'Auto' chip is used when unset)." })),
			model: Type.Optional(
				Type.String({
					description: `Qwen model id, e.g. '${DEFAULT_MODEL}', 'qwen3.7-plus', 'qwen3.8-omni-flash', 'qwen3.6-plus' (default: configured default, usually ${DEFAULT_MODEL}).`,
				}),
			),
			search: Type.Optional(Type.Boolean({ description: "Enable chat.qwen.ai web search for the request (default false)." })),
			new_chat: Type.Optional(Type.Boolean({ description: "Start a fresh chat thread instead of continuing the previous one (default false)." })),
		}),
		async execute(toolCallId, params, signal, onUpdate) {
			try {
				const cfg = configured();
				const mode = (params.mode as BrainstormMode) || "general";
				const thinking: ThinkingPref = params.thinking === false ? "Fast" : params.thinking === true ? "Thinking" : cfg.defaultThinking ?? "Auto";
				const qwenMode: QwenMode = params.search ? "search" : "default";
				const timeoutMs = (cfg.timeoutSec ?? 240) * 1000;

				const result = await runAsk({
					prompt: wrapBrainstormPrompt(params.prompt, mode),
					mode: qwenMode,
					thinking,
					model: params.model,
					newChat: params.new_chat === true,
					header: `Qwen Brainstorm (${mode.toUpperCase()}${params.search ? " + web search" : ""})`,
					timeoutMs,
					onUpdate: (p) =>
						onUpdate?.({
							content: [{ type: "text", text: p }],
							details: { status: "streaming" },
						}),
					signal,
				});

				return {
					content: [{ type: "text", text: formatResult(result, `Qwen Brainstorm — ${mode.toUpperCase()} mode`) }],
					details: {
						model: params.model || cfg.defaultModel || DEFAULT_MODEL,
						chatId: result.chatId,
						responseId: result.responseId,
						sources: result.sources.length,
						durationMs: result.durationMs,
					},
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `Qwen brainstorm failed: ${describeError(err)}` }],
					details: { error: describeError(err) },
				};
			}
		},
	});

	// --- Tool: qwen_research ---
	pi.registerTool({
		name: "qwen_research",
		label: "Qwen Research",
		description:
			"Web-search-augmented research with Qwen on chat.qwen.ai (uses the site's Web search or Deep Research mode) via the user's logged-in Chrome session. Returns an answer with sources. Use for current events, version lookups, and multi-source summaries.",
		promptSnippet:
			"qwen_research: Search/research the web via chat.qwen.ai (Qwen models, real browser session) and get cited answers.",
		promptGuidelines: [
			"Use qwen_research for basic search/research tasks that benefit from fresh web results, such as current library versions, news, or comparisons across sources.",
			"qwen_research deep:true runs Qwen Deep Research, which takes several minutes but produces a thorough cited report.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "The research question or search query." }),
			deep: Type.Optional(Type.Boolean({ description: "Use Deep Research mode (several minutes, thorough cited report). Default: quick web search." })),
			model: Type.Optional(Type.String({ description: `Qwen model id (default: configured default, usually ${DEFAULT_MODEL}).` })),
			new_chat: Type.Optional(Type.Boolean({ description: "Start a fresh chat thread (default false; keeps context for follow-ups)." })),
		}),
		async execute(toolCallId, params, signal, onUpdate) {
			try {
				const cfg = configured();
				const mode: QwenMode = params.deep ? "deep_research" : "search";
				const timeoutMs = (params.deep ? cfg.deepResearchTimeoutSec ?? 900 : cfg.researchTimeoutSec ?? 420) * 1000;

				const result = await runAsk({
					prompt: params.query,
					mode,
					thinking: cfg.defaultThinking ?? "Auto",
					model: params.model,
					newChat: params.new_chat === true,
					header: params.deep ? "Qwen Deep Research" : "Qwen Web Search",
					timeoutMs,
					onUpdate: (p) =>
						onUpdate?.({
							content: [{ type: "text", text: p }],
							details: { status: "streaming" },
						}),
					signal,
				});

				return {
					content: [{ type: "text", text: formatResult(result, params.deep ? "Qwen Deep Research" : "Qwen Web Search") }],
					details: {
						model: params.model || cfg.defaultModel || DEFAULT_MODEL,
						mode,
						chatId: result.chatId,
						sources: result.sources.length,
						durationMs: result.durationMs,
					},
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `Qwen research failed: ${describeError(err)}` }],
					details: { error: describeError(err) },
				};
			}
		},
	});

	// --- Commands ---

	async function qwenAsk(args: string, ctx: ExtensionContext): Promise<void> {
		const topic = (args || "").trim();
		const c0 = getClient();
		if (!c0.isAvailable()) {
			ctx.ui.notify("Browser daemon not running. Run /browser-setup first.", "warning");
			return;
		}
		if (!topic) {
			const input = await ctx.ui.input("Brainstorm with Qwen", "Enter the topic, architecture, or idea:");
			if (!input?.trim()) return;
			await qwenAsk(input.trim(), ctx);
			return;
		}
		const cfg = configured();
		ctx.ui.setStatus("qwen", "🧠 Qwen brainstorming…");
		try {
			const result = await runAsk({
				prompt: wrapBrainstormPrompt(topic, "general"),
				mode: "default",
				thinking: cfg.defaultThinking ?? "Auto",
				header: "Qwen Brainstorm (general)",
				timeoutMs: (cfg.timeoutSec ?? 240) * 1000,
				onUpdate: (p) => ctx.ui.setStatus("qwen", p),
			});
			const inject = await ctx.ui.confirm("Brainstorm finished", `Done in ${Math.round(result.durationMs / 1000)}s. Inject into the conversation?`);
			if (inject) await pi.sendUserMessage(formatResult(result, "Qwen Brainstorm"));
			else ctx.ui.notify("Brainstorm saved in the chat.qwen.ai tab. /brainstorm again for more.", "info");
		} catch (e) {
			ctx.ui.notify(describeError(e), "error");
		} finally {
			ctx.ui.setStatus("qwen", undefined);
		}
	}

	const statusLine = async (ctx: ExtensionContext): Promise<string> => {
		const c = getClient();
		const lines: string[] = [];
		lines.push(`Target: ${QWEN_ORIGIN} (via Chrome browser session)`);
		lines.push(`Browser daemon: ${c.isAvailable() ? "✓ found" : "✗ not running (run /browser-setup)"}`);
		if (!c.isAvailable()) return lines.join("\n");
		try {
			await c.ensureQwenTab();
			await c.evaluate(PAGE_INSTALL_HOOK, false);
			const info = await loginInfo(c);
			lines.push(`Login: ${info.loggedIn ? `✓ ${info.email || info.name || "logged in"}` : "✗ not logged in (log in in the Chrome tab, or /qwen-auth)"}`);
			const models = await listModels(c);
			lines.push(`Models (${models.length}): ${models.map((m) => m.id).join(", ")}`);
			lines.push(`Default model: ${configured().defaultModel ?? DEFAULT_MODEL}`);
			const cfg = configured();
			lines.push(`Timeouts: ask ${cfg.timeoutSec ?? 240}s, search ${cfg.researchTimeoutSec ?? 420}s, deep ${cfg.deepResearchTimeoutSec ?? 900}s`);
		} catch (e) {
			lines.push(`Connection: ${describeError(e)}`);
		}
		return lines.join("\n");
	};

	pi.registerCommand("qwen", {
		description: "Qwen on chat.qwen.ai: status, model, ask, research, cleanup",
		getArgumentCompletions: (prefix) => {
			const subs = ["status", "new", "model", "ask", "research", "cleanup", "thinking"];
			const filtered = subs.filter((s) => s.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			const c0 = getClient();
			if (!c0.isAvailable()) {
				ctx.ui.notify("Browser daemon not running. Run /browser-setup first, then /qwen again.", "warning");
				return;
			}
			const [sub, ...rest] = trimmed.split(/\s+/);
			const restText = trimmed.slice(sub?.length ?? 0).trim();

			if (sub === "status") {
				ctx.ui.notify(await statusLine(ctx), "info");
				return;
			}
			if (sub === "new") {
				try {
					const c = await ensureConnected();
					await newChat(c);
					ctx.ui.notify("Started a fresh chat thread on chat.qwen.ai.", "info");
				} catch (e) {
					ctx.ui.notify(describeError(e), "error");
				}
				return;
			}
			if (sub === "model") {
				try {
					const c = await ensureConnected();
					const models = await listModels(c);
					if (restText) {
						await selectModel(c, restText, (m) => ctx.ui.notify(m, "info"));
						ctx.ui.notify(`Model set to: ${await currentModel(c)}`, "info");
						return;
					}
					const choice = await ctx.ui.select(
						"Qwen model",
						models.map((m) => `${m.id} — ${m.name}`),
					);
					if (!choice) return;
					const id = choice.split(" — ")[0].trim();
					await selectModel(c, id);
					saveConfig({ defaultModel: id });
					ctx.ui.notify(`Default model saved: ${id}`, "info");
				} catch (e) {
					ctx.ui.notify(describeError(e), "error");
				}
				return;
			}
			if (sub === "thinking") {
				const valid: ThinkingPref[] = ["Auto", "Thinking", "Fast"];
				const want = valid.find((v) => v.toLowerCase() === restText.toLowerCase());
				if (!want) {
					ctx.ui.notify(`Usage: /qwen thinking <auto|thinking|fast> (current default: ${configured().defaultThinking ?? "Auto"})`, "info");
					return;
				}
				saveConfig({ defaultThinking: want });
				ctx.ui.notify(`Default thinking mode saved: ${want}`, "info");
				return;
			}
			if (sub === "ask") {
				await qwenAsk(restText, ctx);
				return;
			}
			if (sub === "research" || !sub) {
				let topic = restText;
				let deep = false;
				if (sub === "research") deep = true;
				if (!topic) {
					const input = await ctx.ui.input(
						deep ? "Research with Qwen (web search)" : "Brainstorm with Qwen",
						deep ? "Enter your research question:" : "Enter the topic or question:",
					);
					if (!input?.trim()) return;
					topic = input.trim();
					if (!sub) {
						const choice = await ctx.ui.select("What should Qwen do?", [
							"brainstorm — idea/architecture exploration",
							"research — web search with sources",
							"deep research — thorough cited report (slow)",
						]);
						if (!choice) return;
						if (choice.startsWith("research")) deep = false;
						else if (choice.startsWith("deep")) deep = true;
					}
					if (!deep) {
						await qwenAsk(topic, ctx);
						return;
					}
				}
				const cfg = configured();
				const timeoutMs = (deep ? cfg.deepResearchTimeoutSec ?? 900 : cfg.researchTimeoutSec ?? 420) * 1000;
				ctx.ui.setStatus("qwen", deep ? "🔬 Qwen Deep Research running…" : "🔎 Qwen is working…");
				try {
					const result = await runAsk({
						prompt: topic,
						mode: deep ? "deep_research" : "search",
						thinking: cfg.defaultThinking ?? "Auto",
						header: deep ? "Qwen Deep Research" : "Qwen Web Search",
						timeoutMs,
						onUpdate: (p) => ctx.ui.setStatus("qwen", p),
					});
					const text = formatResult(result, deep ? "Qwen Research" : "Qwen Web Search");
					const inject = await ctx.ui.confirm("Qwen finished", `Done in ${Math.round(result.durationMs / 1000)}s. Inject the result into the conversation?`);
					if (inject) await pi.sendUserMessage(text);
					else ctx.ui.notify(text.length > 1500 ? text.slice(0, 1500) + "\n…" : text, "info");
				} catch (e) {
					ctx.ui.notify(describeError(e), "error");
				} finally {
					ctx.ui.setStatus("qwen", undefined);
				}
				return;
			}
			if (sub === "cleanup") {
				try {
					const c = await ensureConnected();
					const deleted = await cleanupTestChats(c);
					ctx.ui.notify(deleted ? `Deleted ${deleted} chat(s) created by tests/probes.` : "No stray test chats found.", "info");
				} catch (e) {
					ctx.ui.notify(describeError(e), "error");
				}
				return;
			}
			if (sub === "auth") {
				await authFlow(ctx);
				return;
			}
			ctx.ui.notify("Usage: /qwen [status|new|model [id]|thinking <auto|thinking|fast>|ask <topic>|research <query>|cleanup]", "info");
		},
	});

	pi.registerCommand("brainstorm", {
		description: "Brainstorm with Qwen on chat.qwen.ai (alias of /qwen ask)",
		handler: qwenAsk,
	});

	pi.registerCommand("qwen-research", {
		description: "Research a query with Qwen web search (cited)",
		handler: async (args, ctx) => {
			const q = (args || "").trim();
			if (!q) {
				ctx.ui.notify("Usage: /qwen-research <query>", "info");
				return;
			}
			const cfg = configured();
			ctx.ui.setStatus("qwen-research", "🔎 Qwen searching the web…");
			try {
				const result = await runAsk({
					prompt: q,
					mode: "search",
					thinking: cfg.defaultThinking ?? "Auto",
					header: "Qwen Web Search",
					timeoutMs: (cfg.researchTimeoutSec ?? 420) * 1000,
					onUpdate: (p) => ctx.ui.setStatus("qwen-research", p),
				});
				const inject = await ctx.ui.confirm("Research finished", `Answer ready (${result.sources.length} sources). Inject into the conversation?`);
				if (inject) await pi.sendUserMessage(formatResult(result, "Qwen Web Search"));
				else ctx.ui.notify(result.answer.slice(0, 1500), "info");
			} catch (e) {
				ctx.ui.notify(describeError(e), "error");
			} finally {
				ctx.ui.setStatus("qwen-research", undefined);
			}
		},
	});

	pi.registerCommand("qwen-auth", {
		description: "Verify chat.qwen.ai login in the connected Chrome session",
		handler: async (_args, ctx) => {
			await authFlow(ctx);
		},
	});

	async function authFlow(ctx: ExtensionContext): Promise<void> {
		const c = getClient();
		if (!c.isAvailable()) {
			ctx.ui.notify("Browser daemon not running. Run /browser-setup first, then /qwen-auth again.", "warning");
			return;
		}
		ctx.ui.notify("Opening chat.qwen.ai…", "info");
		try {
			await c.ensureQwenTab({ log: (m) => ctx.ui.notify(m, "info") });
			const info = await loginInfo(c);
			if (info.loggedIn) {
				ctx.ui.notify(`✓ chat.qwen.ai session verified (${info.email || info.name || "logged in"}). You're ready: try /qwen ask or the qwen_brainstorm tool.`, "info");
			} else {
				const proceed = await ctx.ui.confirm(
					"Log in required",
					"A chat.qwen.ai tab is open in Chrome. Log in there now (Google/email/etc.), then click OK to verify.",
				);
				if (!proceed) return;
				const retry = await loginInfo(c);
				ctx.ui.notify(
					retry.loggedIn ? `✓ Verified: ${retry.email || retry.name || "logged in"}` : "Still not logged in. Log in to chat.qwen.ai in the Chrome tab and retry /qwen-auth.",
					retry.loggedIn ? "info" : "warning",
				);
			}
		} catch (e) {
			ctx.ui.notify(describeError(e), "error");
		}
	}

	async function cleanupTestChats(c: QwenBrowserClient): Promise<number> {
		const token = await c.evaluate(`localStorage.getItem('token')`, false);
		if (!token) return 0;
		const cookie = await c.evaluate(`document.cookie`, false);
		const H: Record<string, string> = {
			Accept: "application/json",
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
			source: "web",
		};
		if (cookie) H.Cookie = cookie;
		const listRes = await fetch(`${QWEN_ORIGIN}/api/v2/chats/?page=1&exclude_project=true`, { headers: H });
		const listJson: any = await listRes.json().catch(() => null);
		const items: any[] = listJson?.data ?? [];
		// Only touch chats created for testing in this session (last 20 hours).
		const cutoff = Math.floor(Date.now() / 1000) - 20 * 3600;
		const testChats = items.filter((ch) => (ch?.updated_at ?? 0) > cutoff);
		let n = 0;
		for (const ch of testChats) {
			const d = await fetch(`${QWEN_ORIGIN}/api/v2/chats/?chat_id=${encodeURIComponent(ch.id)}`, { method: "DELETE", headers: H });
			if (d.ok) n++;
		}
		return n;
	}

	pi.on("session_start", async (_event, ctx) => {
		const c = getClient();
		if (c.isAvailable()) {
			ctx.ui.setStatus("qwen-ready", "💡 Qwen ready — /brainstorm, /qwen-research (/qwen status)");
		}
	});
}
