import { expect, test } from "bun:test";
import { z } from "zod";
import { openaiStream } from "../src/openai.ts";
import { UpstreamError } from "../src/connect.ts";
import { ChatToolCallSchema } from "../vendor/devin-proto.ts";
import type { ChatEvent } from "../src/devin-rpc.ts";

const call = (id: string, name: string, argumentsJson: string): ChatEvent => ({
  type: "toolcall", toolCalls: [ChatToolCallSchema.create({ id, name, argumentsJson })],
});
const done: ChatEvent = { type: "done", stopReason: 10, usage: null };
const chunkSchema = z.object({
  choices: z.array(z.object({
    delta: z.object({
      content: z.string().optional(),
      tool_calls: z.array(z.object({
        index: z.number(), id: z.string().optional(), type: z.literal("function").optional(),
        function: z.object({ name: z.string().optional(), arguments: z.string().optional() }),
      })).optional(),
    }).optional(),
    finish_reason: z.string().nullable().optional(),
  })).optional(),
  error: z.object({ code: z.string() }).optional(),
});

async function render(events: readonly ChatEvent[]) {
  async function* source() { yield* events; }
  const frames = await Array.fromAsync(openaiStream(source(), {
    id: "chatcmpl-fixture", model: "swe-2-high", created: 1,
  }, false));
  const chunks = frames.filter(f => f !== "data: [DONE]\n\n")
    .map(f => chunkSchema.parse(JSON.parse(f.slice(6))));
  return { frames, chunks, deltas: chunks.flatMap(c => c.choices?.flatMap(v => v.delta?.tool_calls ?? []) ?? []) };
}

test("streams native tool-only output with exact cumulative/incremental arguments", async () => {
  // Given a cumulative prefix followed by a genuine incremental suffix.
  const result = await render([
    call("call_sum", "add_numbers", ' { "a":'),
    call("", "", ' { "a":17'),
    call("", "", ', "b":25 }\n'),
    done,
  ]);
  // When consumed as OpenAI deltas, then identity appears once and bytes are exact.
  expect(result.deltas[0]).toEqual({
    index: 0, id: "call_sum", type: "function",
    function: { name: "add_numbers", arguments: ' { "a":' },
  });
  expect(result.deltas.map(d => d.function.arguments ?? "").join("")).toBe(' { "a":17, "b":25 }\n');
  expect(result.deltas.filter(d => d.id).length).toBe(1);
  expect(result.chunks.at(-1)?.choices?.[0]?.finish_reason).toBe("tool_calls");
  expect(result.frames.at(-1)).toBe("data: [DONE]\n\n");
});

test("keeps independent IDs and indices for interleaved parallel calls", async () => {
  const result = await render([
    call("call_a", "first", '{"x":'),
    call("call_b", "second", '{"y":'),
    call("call_a", "", "1}"),
    call("call_b", "", "2}"),
    done,
  ]);
  expect(result.deltas.map(d => d.index)).toEqual([0, 1, 0, 1]);
  expect(result.deltas.filter(d => d.index === 0).map(d => d.function.arguments).join("")).toBe('{"x":1}');
  expect(result.deltas.filter(d => d.index === 1).map(d => d.function.arguments).join("")).toBe('{"y":2}');
  expect(result.chunks.at(-1)?.choices?.[0]?.finish_reason).toBe("tool_calls");
});

test("does not duplicate repeated cumulative argument snapshots", async () => {
  const result = await render([
    call("call_a", "first", '{"x":1}'),
    call("call_a", "first", '{"x":1}'),
    done,
  ]);
  expect(result.deltas.map(d => d.function.arguments ?? "").join("")).toBe('{"x":1}');
  expect(result.frames.at(-1)).toBe("data: [DONE]\n\n");
});

test("supports text followed by a tool call and zero-argument functions", async () => {
  const result = await render([{ type: "text", text: "Checking." }, call("call_a", "status", "{}"), done]);
  expect(result.chunks.flatMap(c => c.choices?.map(v => v.delta?.content ?? "") ?? []).join("")).toBe("Checking.");
  expect(result.deltas[0]?.function).toEqual({ name: "status", arguments: "{}" });
  expect(result.chunks.at(-1)?.choices?.[0]?.finish_reason).toBe("tool_calls");
});

test.each([
  { events: [call("call_a", "broken", '{"x":'), done] },
  { events: [call("", "", '{"x":1}'), done] },
  { events: [call("call_a", "first", "{}"), call("call_a", "different", "{}"), done] },
])("does not return DONE for incomplete or inconsistent tool data: %j", async ({ events }) => {
  const result = await render(events);
  expect(result.chunks.at(-1)?.error?.code).toBe("invalid_tool_call");
  expect(result.frames).not.toContain("data: [DONE]\n\n");
});

test("preserves upstream failure after a partial tool call", async () => {
  async function* source(): AsyncGenerator<ChatEvent> {
    yield call("call_a", "first", '{"x":');
    throw new UpstreamError("unavailable");
  }
  const frames = await Array.fromAsync(openaiStream(source(), {
    id: "chatcmpl-fixture", model: "swe-2-high", created: 1,
  }, false));
  expect(frames.join("")).toContain('"code":"unavailable"');
  expect(frames.join("")).toContain('"id":"call_a"');
  expect(frames).not.toContain("data: [DONE]\n\n");
});
