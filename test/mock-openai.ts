/**
 * A tiny OpenAI-compatible chat-completions server for integration tests.
 * Each request is answered by `respond(messages)`, which returns either text or
 * a single tool call; responses stream as SSE like the real API.
 */

import * as http from "node:http";

export type MockReply = { text: string } | { tool: string; args: Record<string, unknown> };

export interface MockServer {
  url: string;
  requests: Array<{ model: string; messages: any[]; tools: string[] }>;
  close(): Promise<void>;
}

export async function startMockOpenAI(respond: (messages: any[], index: number) => MockReply): Promise<MockServer> {
  const requests: MockServer["requests"] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const payload = JSON.parse(body || "{}");
      const tools = (payload.tools ?? []).map((t: any) => t.function?.name).filter(Boolean);
      requests.push({ model: payload.model, messages: payload.messages ?? [], tools });
      const reply = respond(payload.messages ?? [], requests.length - 1);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if ("text" in reply) {
        chunk({ role: "assistant", content: reply.text });
        chunk({}, "stop");
      } else {
        chunk({
          role: "assistant",
          tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }],
        });
        chunk({}, "tool_calls");
      }
      res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: payload.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: requests.length > 1 ? 60 : 0 } } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
