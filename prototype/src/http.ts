import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ChatEvent, DiscoveredModel } from "./devin-rpc.ts";
import { UpstreamError } from "./connect.ts";
import { CompletionState, openaiStream, openaiUsage, publicError, type CompletionStep, type ToolCallPolicy } from "./openai.ts";
import { BRIDGE_VERSION } from "./version.ts";

// A 262k-token history can exceed 512 KB of JSON; a real 700 KB tool result was rejected with 413 before this.
export const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const sweEffort = z.enum(["medium", "high", "max"]);
const sweVariants = {
  medium: "swe-2-medium", high: "swe-2-high", max: "swe-2-max",
} as const;
const sweVariantIds = new Set<string>(Object.values(sweVariants));
const toolName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const toolCall = z.object({
  id: z.string().min(1), type: z.literal("function"),
  function: z.object({ name: toolName, arguments: z.string() }).strict(),
}).strict();
const textContent = z.union([
  z.string(),
  z.array(z.object({
    type: z.literal("text"), text: z.string(),
    cache_control: z.object({ type: z.literal("ephemeral") }).strict().optional(),
  }).strict()).transform(parts => parts.map(part => part.text).join("")),
]);
const message = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: textContent }).strict(),
  z.object({ role: z.literal("developer"), content: textContent }).strict(),
  z.object({ role: z.literal("user"), content: textContent }).strict(),
  z.object({
    role: z.literal("assistant"), content: textContent.nullable().optional(),
    tool_calls: z.array(toolCall).min(1).optional(),
  }).strict().refine(m => typeof m.content === "string" || Boolean(m.tool_calls?.length)),
  z.object({ role: z.literal("tool"), content: textContent, tool_call_id: z.string().min(1) }).strict(),
]);
const requestSchema = z.object({
  model: z.string().min(1),
  reasoning_effort: sweEffort.optional(),
  messages: z.array(message).min(1),
  tools: z.array(z.object({
    type: z.literal("function"),
    function: z.object({
      name: toolName, description: z.string().optional(),
      parameters: z.record(z.string(), z.unknown()).optional(), strict: z.boolean().optional(),
    }).strict(),
  }).strict()).max(128).optional(),
  tool_choice: z.union([
    z.enum(["auto", "none", "required"]),
    z.object({ type: z.literal("function"), function: z.object({ name: toolName }).strict() }).strict(),
  ]).optional(),
  parallel_tool_calls: z.boolean().optional(),
  stream: z.boolean().default(false),
  max_tokens: z.number().int().min(1).max(65_536).optional(),
  max_completion_tokens: z.number().int().min(1).max(65_536).optional(),
  store: z.literal(false).optional(),
  temperature: z.number().min(0).max(2).optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
  n: z.literal(1).optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).strict().optional(),
}).strict().superRefine((input, context) => {
  if (input.max_tokens !== undefined && input.max_completion_tokens !== undefined
    && input.max_tokens !== input.max_completion_tokens) {
    context.addIssue({ code: "custom", message: "Conflicting token limits", path: ["max_completion_tokens"] });
  }
  const names = new Set((input.tools ?? []).map(t => t.function.name));
  if (names.size !== (input.tools?.length ?? 0)) {
    context.addIssue({ code: "custom", message: "Duplicate function names", path: ["tools"] });
  }
  if ((input.tool_choice === "required" && !names.size)
    || (typeof input.tool_choice === "object" && !names.has(input.tool_choice.function.name))) {
    context.addIssue({ code: "custom", message: "Selected tool is not declared", path: ["tool_choice"] });
  }
  const pending = new Set<string>();
  for (const m of input.messages) {
    switch (m.role) {
      case "assistant":
        for (const call of m.tool_calls ?? []) {
          if (pending.has(call.id)) context.addIssue({ code: "custom", message: "Duplicate pending tool call ID" });
          pending.add(call.id);
        }
        break;
      case "tool":
        if (!pending.delete(m.tool_call_id)) context.addIssue({ code: "custom", message: "Unmatched tool result" });
        break;
      case "system":
      case "developer":
      case "user": break;
      default: { const unhandled: never = m; throw unhandled; }
    }
  }
  if (pending.size) context.addIssue({ code: "custom", message: "Missing tool results" });
}).transform(({ max_completion_tokens, ...input }) => ({
  ...input, max_tokens: input.max_tokens ?? max_completion_tokens ?? 512,
}));
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
  const availableEfforts = sweEffort.options.filter(e => models.some(m => m.uid === sweVariants[e]));
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return failure("invalid_host", 403);
    if (request.headers.has("origin")) return failure("browser_origin_denied", 403);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", version: BRIDGE_VERSION, transport: "direct-connect-rpc", model_fallback: false });
    }
    const provided = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!timingSafeEqual(expectedKey, createHash("sha256").update(provided).digest())) {
      return failure("unauthorized", 401);
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [
        ...models.filter(m => !sweVariantIds.has(m.uid)).map(m => ({
          id: m.uid, object: "model", created: 0, owned_by: "devin",
        })),
        ...(availableEfforts.length ? [{
          id: "swe-2", object: "model", created: 0, owned_by: "devin",
          reasoning_efforts: availableEfforts,
          ...(availableEfforts.includes("high") ? { default_reasoning_effort: "high" } : {}),
        }] : []),
      ] });
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
    const requested = parsed.data;
    if (requested.reasoning_effort !== undefined && requested.model !== "swe-2"
      && requested.model !== sweVariants[requested.reasoning_effort]) {
      return failure("conflicting_or_unsupported_reasoning_effort", 400);
    }
    const input = {
      ...requested,
      model: requested.model === "swe-2"
        ? sweVariants[requested.reasoning_effort ?? "high"]
        : requested.model,
    };
    if (!models.some(m => m.uid === input.model)) return failure("model_not_found", 404);
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const identity = {
      id: `chatcmpl-${crypto.randomUUID()}`, model: input.model, created: Math.floor(Date.now() / 1000),
      system_fingerprint: `devin-bridge-${BRIDGE_VERSION}`, // Lets operators confirm which build answered through any proxy.
    };
    const toolPolicy: ToolCallPolicy = {
      tools: (input.tools ?? []).map(tool => ({
        name: tool.function.name, strict: tool.function.strict ?? false, parameters: tool.function.parameters,
      })),
      choice: typeof input.tool_choice === "object" ? { name: input.tool_choice.function.name } : input.tool_choice ?? "auto",
    };
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
        const output = openaiStream(events(), identity, input.stream_options?.include_usage ?? false, toolPolicy);
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
      const state = new CompletionState(toolPolicy);
      let done: Extract<CompletionStep, { kind: "done" }> | undefined;
      for await (const event of events()) {
        const step = state.apply(event);
        switch (step.kind) {
          case "text":
          case "tool_calls":
          case "ignored": break;
          case "done": done = step; break;
          default: { const unhandled: never = step; throw unhandled; }
        }
      }
      if (!done) throw new UpstreamError("protocol_error"); // Ended without a terminal event: same failure as SSE.
      const text = state.content;
      return Response.json({
        ...identity, object: "chat.completion",
        choices: [{ index: 0, message: {
          role: "assistant", content: done.toolCalls.length && !text ? null : text,
          ...(done.toolCalls.length ? { tool_calls: done.toolCalls } : {}),
        }, finish_reason: done.reason }],
        ...(done.usage ? { usage: openaiUsage(done.usage) } : {}),
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
