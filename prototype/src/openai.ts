import { StopReason } from "../vendor/devin-proto.ts";
import type { ChatToolCall } from "../vendor/devin-proto.ts";
import type { ChatEvent, Usage } from "./devin-rpc.ts";
import { UpstreamError } from "./connect.ts";
import { conformsToSchema } from "./tool-schema.ts";

export function publicError(error: unknown): UpstreamError {
  if (error instanceof UpstreamError) return error;
  if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
    return new UpstreamError("deadline_exceeded", 504);
  }
  return new UpstreamError("upstream_error");
}

export type FinishReason = "stop" | "length" | "content_filter" | "tool_calls";

export function finishReason(reason: number): FinishReason {
  switch (reason) {
    case StopReason.STOP_PATTERN: return "stop";
    case StopReason.MAX_TOKENS:
    case StopReason.MAX_NEWLINES: return "length";
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

export interface ToolContract {
  readonly name: string;
  /** OpenAI strict mode promises schema-conforming arguments; only then is the schema enforced. */
  readonly strict: boolean;
  readonly parameters: unknown;
}

export interface ToolCallPolicy {
  readonly tools: readonly ToolContract[];
  readonly choice: "auto" | "none" | "required" | { readonly name: string };
}

// Mutable per-completion state shared by JSON and SSE. Never repair argument values.
export class ToolCallAccumulator {
  private readonly calls = new Map<string, { index: number; name: string; arguments: string }>();
  private activeId: string | undefined;

  constructor(private readonly policy?: ToolCallPolicy) {}

  update(incoming: readonly ChatToolCall[]): readonly ToolDelta[] {
    const deltas: ToolDelta[] = [];
    for (const call of incoming) {
      const id = call.id || this.activeId;
      if (!id || call.invalidJsonErr || call.invalidJsonStr || call.isCustomToolCall) {
        throw new UpstreamError("invalid_tool_call");
      }
      if (this.policy && (this.policy.choice === "none" || (call.name && (
        !this.policy.tools.some(tool => tool.name === call.name)
        || (typeof this.policy.choice === "object" && call.name !== this.policy.choice.name)
      )))) throw new UpstreamError("invalid_tool_call");
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

  finish(reason: FinishReason): readonly OpenAIToolCall[] {
    const calls = this.snapshot();
    const required = this.policy?.choice === "required" || typeof this.policy?.choice === "object";
    if ((calls.length > 0) !== (reason === "tool_calls")
      || (reason === "stop" && required && !calls.length)) {
      throw new UpstreamError("invalid_tool_call");
    }
    return calls;
  }

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
      const contract = this.policy?.tools.find(tool => tool.name === state.name);
      if (contract?.strict && !conformsToSchema(argumentsValue, contract.parameters)) {
        throw new UpstreamError("invalid_tool_call");
      }
      return { id, type: "function", function: { name: state.name, arguments: state.arguments } };
    });
  }
}

export type CompletionStep =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool_calls"; readonly deltas: readonly ToolDelta[] }
  | { readonly kind: "ignored" }
  | { readonly kind: "done"; readonly reason: FinishReason; readonly toolCalls: readonly OpenAIToolCall[]; readonly usage: Usage | null };

// One completion's mutable state; JSON and SSE consume the same steps and the same terminal validation.
export class CompletionState {
  private text = "";
  private usage: Usage | null = null;
  private readonly tools: ToolCallAccumulator;

  constructor(policy?: ToolCallPolicy) { this.tools = new ToolCallAccumulator(policy); }

  get content(): string { return this.text; }

  apply(event: ChatEvent): CompletionStep {
    switch (event.type) {
      case "text": this.text += event.text; return { kind: "text", text: event.text };
      case "thinking": return { kind: "ignored" }; // This text-only surface does not expose internal reasoning.
      case "toolcall": return { kind: "tool_calls", deltas: this.tools.update(event.toolCalls) };
      case "usage": this.usage = event.usage; return { kind: "ignored" }; // Snapshot, not an additive charge.
      case "done": {
        const reason = finishReason(event.stopReason);
        const toolCalls = this.tools.finish(reason);
        if (!this.text && reason === "stop") throw new UpstreamError("empty_response");
        this.usage = event.usage ?? this.usage;
        return { kind: "done", reason, toolCalls, usage: this.usage };
      }
      default: { const unhandled: never = event; throw unhandled; }
    }
  }
}

export async function* openaiStream(
  events: AsyncIterable<ChatEvent>,
  identity: { readonly id: string; readonly model: string; readonly created: number },
  includeUsage: boolean,
  policy?: ToolCallPolicy,
): AsyncGenerator<string> {
  const chunk = { ...identity, object: "chat.completion.chunk" };
  yield sse({ ...chunk, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  const state = new CompletionState(policy);
  try {
    for await (const event of events) {
      const step = state.apply(event);
      switch (step.kind) {
        case "text":
          yield sse({ ...chunk, choices: [{ index: 0, delta: { content: step.text }, finish_reason: null }] });
          break;
        case "tool_calls":
          if (step.deltas.length) yield sse({
            ...chunk, choices: [{ index: 0, delta: { tool_calls: step.deltas }, finish_reason: null }],
          });
          break;
        case "ignored": break;
        case "done":
          yield sse({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: step.reason }] });
          if (includeUsage && step.usage) yield sse({ ...chunk, choices: [], usage: openaiUsage(step.usage) });
          yield "data: [DONE]\n\n";
          return;
        default: {
          const unhandled: never = step;
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
