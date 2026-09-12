import { expect, test } from "bun:test";
import { createHandler, type ChatInput } from "../src/http.ts";
import { ChatToolCallSchema } from "../vendor/devin-proto.ts";

const key = "tool-http-fixture-key";
const declaration = {
  type: "function",
  function: {
    name: "add_numbers", description: "Add two integers", strict: true,
    parameters: {
      type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } },
      required: ["a", "b"], additionalProperties: false,
    },
  },
};
const call = { id: "call_sum", type: "function", function: { name: "add_numbers", arguments: '{"a":17,"b":25}' } };
const base = { model: "swe-2-high", messages: [{ role: "user", content: "Add 17 and 25." }] };

async function fixture(check: (origin: string, calls: readonly ChatInput[]) => Promise<void>) {
  const calls: ChatInput[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: createHandler({
      models: [{ uid: "swe-2-high", label: "SWE-2 High", disabled: false, router: false, maxTokens: 8192 }],
      async *complete(input) {
        calls.push(input);
        if (input.messages.some(message => "tool_call_id" in message)) {
          yield { type: "text", text: "42" };
          yield { type: "done", stopReason: 2, usage: null };
        } else {
          yield { type: "toolcall", toolCalls: [ChatToolCallSchema.create({
            id: call.id, name: call.function.name, argumentsJson: '{"a":17,',
          })] };
          yield { type: "toolcall", toolCalls: [ChatToolCallSchema.create({
            id: call.id, argumentsJson: '"b":25}',
          })] };
          yield { type: "done", stopReason: 10, usage: null };
        }
      },
    }, key),
  });
  try { await check(server.url.origin, calls); }
  finally { await server.stop(true); }
}

function post(origin: string, extra: Record<string, unknown>) {
  return fetch(`${origin}/v1/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...base, ...extra }),
  });
}

test("returns a JSON tool call and accepts its correlated result on the next turn", async () => {
  // Given a declared native function; the client, not the bridge, executes it.
  await fixture(async (origin, calls) => {
    const first = await post(origin, {
      tools: [declaration], tool_choice: { type: "function", function: { name: "add_numbers" } },
      parallel_tool_calls: true,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      choices: [{ message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }],
    });
    // When the client supplies the tool result and its original ID.
    const second = await post(origin, {
      messages: [...base.messages,
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: "call_sum", content: String(17 + 25) }],
      tools: [declaration], tool_choice: "none",
    });
    // Then the next completion receives the intact history and returns the result.
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ choices: [{ message: { content: "42" }, finish_reason: "stop" }] });
    expect(calls.length).toBe(2);
    expect(calls[0]).toMatchObject({ tools: [declaration], parallel_tool_calls: true });
    expect(calls[1]?.messages[2]).toEqual({ role: "tool", tool_call_id: "call_sum", content: "42" });
  });
});

test("streams tool arguments and selects the requested SWE-2 effort together", async () => {
  await fixture(async (origin, calls) => {
    const response = await post(origin, {
      model: "swe-2", reasoning_effort: "high", stream: true, tools: [declaration], tool_choice: "required",
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('"tool_calls"');
    expect(body).toContain('"name":"add_numbers"');
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).toEndWith("data: [DONE]\n\n");
    expect(calls[0]?.model).toBe("swe-2-high");
  });
});

test("allows a call ID to be reused after its earlier result was resolved", async () => {
  // Native SWE-2 uses per-turn IDs such as add_numbers_0, not global UUIDs.
  await fixture(async (origin, calls) => {
    const response = await post(origin, {
      messages: [
        ...base.messages,
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "42" },
        { role: "user", content: "Call the tool again." },
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "42" },
      ],
      tools: [declaration], tool_choice: "none",
    });
    expect(response.status).toBe(200);
    expect(calls.length).toBe(1);
  });
});

test.each([
  { tools: [{ type: "function" }] },
  { tools: [declaration, declaration] },
  { tool_choice: "required" },
  { tools: [declaration], tool_choice: { type: "function", function: { name: "missing" } } },
  { tools: [declaration], parallel_tool_calls: "yes" },
  { messages: [{ role: "assistant", content: null }] },
  { messages: [{ role: "tool", content: "42" }] },
  { messages: [{ role: "tool", tool_call_id: "orphan", content: "42" }] },
  { messages: [...base.messages, { role: "assistant", content: null, tool_calls: [call] }] },
])("rejects invalid tool input before inference: %j", async extra => {
  await fixture(async (origin, calls) => {
    const response = await post(origin, extra);
    expect(response.status).toBe(400);
    expect(calls.length).toBe(0);
  });
});
