import { expect, test } from "bun:test";
import { createHandler, type ChatInput } from "../src/http.ts";

async function check(extra: Record<string, unknown>, status: number, expected?: unknown) {
  const calls: ChatInput[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: createHandler({
      models: [{ uid: "swe-2-high", label: "SWE-2", disabled: false, router: false, maxTokens: 65536 }],
      async *complete(input) {
        calls.push(input);
        yield { type: "text", text: "OK" };
        yield { type: "done", stopReason: 2, usage: null };
      },
    }, "compat-local-test"),
  });
  try {
    const response = await fetch(`${server.url.origin}/v1/chat/completions`, {
      method: "POST", headers: { Authorization: "Bearer compat-local-test", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "swe-2", messages: [{ role: "user", content: "hello" }], ...extra }),
    });
    await response.text();
    expect(response.status).toBe(status);
    if (expected) expect(calls[0]).toMatchObject(expected);
    else expect(calls).toHaveLength(0);
  } finally { await server.stop(true); }
}

test("normalizes OmO developer and text blocks without losing whitespace", async () => {
  await check({
    messages: [
      { role: "developer", content: [{ type: "text", text: "system instruction" }] },
      { role: "user", content: [{ type: "text", text: "\n  first " }, { type: "text", text: "second\t" }] },
    ],
    max_completion_tokens: 123, store: false,
  }, 200, {
    max_tokens: 123,
    messages: [{ role: "developer", content: "system instruction" }, { role: "user", content: "\n  first second\t" }],
  });
});

test("normalizes assistant and correlated tool-result blocks", async () => {
  const call = { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } };
  await check({ messages: [
    { role: "assistant", content: [{ type: "text", text: "working" }], tool_calls: [call] },
    { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "result\n" }] },
  ] }, 200, { messages: [
    { role: "assistant", content: "working", tool_calls: [call] },
    { role: "tool", tool_call_id: "call_1", content: "result\n" },
  ] });
});

test.each([
  { max_completion_tokens: 1 }, { max_completion_tokens: 65536 },
  { max_tokens: 123, max_completion_tokens: 123 },
])("accepts a valid token alias %j", async extra => {
  await check(extra, 200, { max_tokens: extra.max_completion_tokens });
});

test.each([
  { max_tokens: 123, max_completion_tokens: 124 },
  { max_completion_tokens: 131072 }, { max_completion_tokens: 0 },
  { max_completion_tokens: null }, { store: true },
  { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] },
  { messages: [{ role: "user", content: [{ type: "text", text: 2 }] }] },
])("rejects unsupported content or ambiguous limits %j", async extra => {
  await check(extra, 400);
});
