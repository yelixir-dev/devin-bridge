import { StopReason } from "../vendor/devin-proto.ts";
import type { ChatEvent, Usage } from "./devin-rpc.ts";
import { UpstreamError } from "./connect.ts";

export function publicError(error: unknown): UpstreamError {
  if (error instanceof UpstreamError) return error;
  if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
    return new UpstreamError("deadline_exceeded", 504);
  }
  return new UpstreamError("upstream_error");
}

export function finishReason(reason: number): "stop" | "length" | "content_filter" {
  switch (reason) {
    case StopReason.STOP_PATTERN: return "stop";
    case StopReason.MAX_TOKENS: return "length";
    case StopReason.CONTENT_FILTER: return "content_filter";
    default: throw new UpstreamError("unsupported_stop_reason");
  }
}

export function openaiUsage(usage: Usage) {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
  };
}

const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

export async function* openaiStream(
  events: AsyncIterable<ChatEvent>,
  identity: { readonly id: string; readonly model: string; readonly created: number },
  includeUsage: boolean,
): AsyncGenerator<string> {
  const chunk = { ...identity, object: "chat.completion.chunk" };
  yield sse({ ...chunk, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  let usage: Usage | null = null;
  let visible = false;
  try {
    for await (const event of events) {
      switch (event.type) {
        case "text":
          visible ||= event.text.length > 0;
          yield sse({ ...chunk, choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }] });
          break;
        case "thinking": break; // This text-only surface does not expose internal reasoning.
        case "toolcall": throw new UpstreamError("unsupported_tool_call");
        case "usage": usage = event.usage; break; // Snapshot, not an additive charge.
        case "done": {
          const reason = finishReason(event.stopReason);
          if (!visible && reason === "stop") throw new UpstreamError("empty_response");
          yield sse({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: reason }] });
          usage = event.usage ?? usage;
          if (includeUsage && usage) yield sse({ ...chunk, choices: [], usage: openaiUsage(usage) });
          yield "data: [DONE]\n\n";
          return;
        }
        default: {
          const unhandled: never = event;
          throw unhandled;
        }
      }
    }
    throw new UpstreamError("protocol_error");
  } catch (error) {
    const failure = publicError(error);
    console.error(JSON.stringify({ event: "stream_error", code: failure.code, model: identity.model }));
    yield sse({ error: { message: failure.message, type: "upstream_error", code: failure.code } });
  }
}
