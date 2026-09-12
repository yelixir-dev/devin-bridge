import { StopReason } from "../vendor/devin-proto.ts";
import type { ChatToolCall } from "../vendor/devin-proto.ts";
import type { ChatEvent, Usage } from "./devin-rpc.ts";
import { UpstreamError } from "./connect.ts";

export function publicError(error: unknown): UpstreamError {
  if (error instanceof UpstreamError) return error;
  if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
    return new UpstreamError("deadline_exceeded", 504);
  }
  return new UpstreamError("upstream_error");
}

export function finishReason(reason: number): "stop" | "length" | "content_filter" | "tool_calls" {
  switch (reason) {
    case StopReason.STOP_PATTERN: return "stop";
    case StopReason.MAX_TOKENS: return "length";
    case StopReason.CONTENT_FILTER: return "content_filter";
    case StopReason.FUNCTION_CALL: return "tool_calls";
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

export interface OpenAIToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

interface ToolDelta {
  readonly index: number;
  readonly id?: string;
  readonly type?: "function";
  readonly function: { readonly name?: string; readonly arguments?: string };
}

// Mutable per-completion state. Both JSON and SSE use the same byte-preserving accumulator.
export class ToolCallAccumulator {
  private readonly calls = new Map<string, { index: number; name: string; arguments: string }>();
  private activeId: string | undefined;

  update(incoming: readonly ChatToolCall[]): readonly ToolDelta[] {
    const deltas: ToolDelta[] = [];
    for (const call of incoming) {
      const id = call.id || this.activeId;
      if (!id || call.invalidJsonErr) throw new UpstreamError("invalid_tool_call");
      const previous = this.calls.get(id);
      const state = previous ?? { index: this.calls.size, name: "", arguments: "" };
      if (state.name && call.name && state.name !== call.name) throw new UpstreamError("invalid_tool_call");
      const name = state.name ? "" : call.name;
      const nextArguments = call.argumentsJson.startsWith(state.arguments)
        ? call.argumentsJson : state.arguments + call.argumentsJson;
      const argumentDelta = nextArguments.slice(state.arguments.length);
      state.name ||= call.name;
      state.arguments = nextArguments;
      this.calls.set(id, state);
      this.activeId = id;
      if (!previous || name || argumentDelta) deltas.push({
        index: state.index,
        ...(!previous ? { id, type: "function" as const } : {}),
        function: {
          ...(name ? { name } : {}),
          ...(argumentDelta ? { arguments: argumentDelta } : {}),
        },
      });
    }
    return deltas;
  }

  get size(): number { return this.calls.size; }

  snapshot(): readonly OpenAIToolCall[] {
    return [...this.calls].map(([id, state]) => {
      if (!state.name) throw new UpstreamError("invalid_tool_call");
      let argumentsValue: unknown;
      try { argumentsValue = JSON.parse(state.arguments); }
      catch (error) {
        if (error instanceof SyntaxError) throw new UpstreamError("invalid_tool_call");
        throw error;
      }
      if (argumentsValue === null || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
        throw new UpstreamError("invalid_tool_call");
      }
      return { id, type: "function", function: { name: state.name, arguments: state.arguments } };
    });
  }
}

export async function* openaiStream(
  events: AsyncIterable<ChatEvent>,
  identity: { readonly id: string; readonly model: string; readonly created: number },
  includeUsage: boolean,
): AsyncGenerator<string> {
  const chunk = { ...identity, object: "chat.completion.chunk" };
  yield sse({ ...chunk, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  let usage: Usage | null = null;
  let visible = false;
  const tools = new ToolCallAccumulator();
  try {
    for await (const event of events) {
      switch (event.type) {
        case "text":
          visible ||= event.text.length > 0;
          yield sse({ ...chunk, choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }] });
          break;
        case "thinking": break; // This text-only surface does not expose internal reasoning.
        case "toolcall": {
          const deltas = tools.update(event.toolCalls);
          if (deltas.length) yield sse({
            ...chunk, choices: [{ index: 0, delta: { tool_calls: deltas }, finish_reason: null }],
          });
          break;
        }
        case "usage": usage = event.usage; break; // Snapshot, not an additive charge.
        case "done": {
          const reason = finishReason(event.stopReason);
          if (reason === "tool_calls") {
            if (!tools.snapshot().length) throw new UpstreamError("invalid_tool_call");
          }
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
