import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ChatEvent, DiscoveredModel, Usage } from "./devin-rpc.ts";
import { UpstreamError } from "./connect.ts";
import { finishReason, openaiStream, openaiUsage, publicError } from "./openai.ts";

const requestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant"]), content: z.string(),
  }).strict()).min(1),
  stream: z.boolean().default(false),
  max_tokens: z.number().int().min(1).max(65_536).default(512),
  temperature: z.number().min(0).max(2).optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
  n: z.literal(1).optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).strict().optional(),
}).strict();
export type ChatInput = z.infer<typeof requestSchema>;

export interface Backend {
  readonly models: readonly DiscoveredModel[];
  complete(input: ChatInput, signal: AbortSignal): AsyncIterable<ChatEvent>;
}

function failure(code: string, status: number) {
  return Response.json({ error: { message: code, type: "invalid_request_error", code } }, { status });
}

export function createHandler(backend: Backend, apiKey: string) {
  const expectedKey = createHash("sha256").update(apiKey).digest();
  const models = backend.models.filter(m => !m.disabled && !m.router);
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return failure("invalid_host", 403);
    if (request.headers.has("origin")) return failure("browser_origin_denied", 403);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", transport: "direct-connect-rpc", model_fallback: false });
    }
    const provided = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!timingSafeEqual(expectedKey, createHash("sha256").update(provided).digest())) {
      return failure("unauthorized", 401);
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: models.map(m => ({
        id: m.uid, object: "model", created: 0, owned_by: "devin",
      })) });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") return failure("not_found", 404);
    let raw: unknown;
    try {
      raw = await request.json();
    } catch (error) {
      if (error instanceof SyntaxError) return failure("invalid_json", 400);
      throw error;
    }
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) return failure("unsupported_or_invalid_request", 400);
    const input = parsed.data;
    if (!models.some(m => m.uid === input.model)) return failure("model_not_found", 404);
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const identity = { id: `chatcmpl-${crypto.randomUUID()}`, model: input.model, created: Math.floor(Date.now() / 1000) };
    try {
      const iterator = backend.complete(input, signal)[Symbol.asyncIterator]();
      const first = await iterator.next(); // Early upstream errors retain their HTTP status.
      async function* events(): AsyncGenerator<ChatEvent> {
        try {
          if (!first.done) yield first.value;
          for (;;) {
            const next = await iterator.next();
            if (next.done) return;
            yield next.value;
          }
        } finally {
          controller.abort();
          await iterator.return?.();
        }
      }
      if (input.stream) {
        const output = openaiStream(events(), identity, input.stream_options?.include_usage ?? false);
        return new Response(new ReadableStream<Uint8Array>({
          async pull(stream) {
            const next = await output.next();
            if (next.done) stream.close();
            else stream.enqueue(new TextEncoder().encode(next.value));
          },
          async cancel() { controller.abort(); await output.return(undefined); },
        }), { headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store", "X-Accel-Buffering": "no",
        } });
      }
      let text = "";
      let usage: Usage | null = null;
      let reason: ReturnType<typeof finishReason> | undefined;
      for await (const event of events()) {
        switch (event.type) {
          case "text": text += event.text; break;
          case "thinking": break;
          case "toolcall": throw new UpstreamError("unsupported_tool_call");
          case "usage": usage = event.usage; break;
          case "done": reason = finishReason(event.stopReason); usage = event.usage ?? usage; break;
          default: { const unhandled: never = event; throw unhandled; }
        }
      }
      if (!reason || (!text && reason === "stop")) throw new UpstreamError("empty_response");
      return Response.json({
        ...identity, object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: reason }],
        ...(usage ? { usage: openaiUsage(usage) } : {}),
      });
    } catch (error) {
      controller.abort();
      const upstream = publicError(error);
      console.error(JSON.stringify({ event: "request_error", code: upstream.code, model: input.model }));
      return Response.json({ error: { message: upstream.message, type: "upstream_error", code: upstream.code } }, {
        status: upstream.status,
      });
    }
  };
}
