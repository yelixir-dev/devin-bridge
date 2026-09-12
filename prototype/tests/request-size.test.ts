import { expect, test } from "bun:test";
import { createHandler, MAX_REQUEST_BODY_BYTES } from "../src/http.ts";

const key = "request-size-fixture-key";

async function serve(check: (origin: string, calls: () => number) => Promise<void>) {
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    fetch: createHandler({
      models: [{ uid: "swe-2-high", label: "SWE-2 High", disabled: false, router: false, maxTokens: 8192 }],
      async *complete() {
        calls++;
        yield { type: "text", text: "OK" };
        yield { type: "done", stopReason: 2, usage: null };
      },
    }, key),
  });
  try { await check(server.url.origin, () => calls); } finally { await server.stop(true); }
}

function post(origin: string, toolResultBytes: number) {
  const call = { id: "lookup_0", type: "function", function: { name: "lookup", arguments: '{"key":"document"}' } };
  return fetch(`${origin}/v1/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "swe-2-high", messages: [
      { role: "user", content: "Read the document." },
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: "x".repeat(toolResultBytes) },
    ] }),
  });
}

test("accepts a 700 KB conversation, the size that a real agent tool result reached", async () => {
  // Given a tool result of 700 KB, well inside the model's 262k-token context.
  await serve(async (origin, calls) => {
    // When it is posted to the bridge.
    const response = await post(origin, 700 * 1024);
    // Then inference runs instead of a 413.
    expect(response.status).toBe(200);
    expect(calls()).toBe(1);
  });
});

test("still refuses a body above the documented limit before inference", async () => {
  await serve(async (origin, calls) => {
    const response = await post(origin, MAX_REQUEST_BODY_BYTES + 1024);
    expect(response.status).toBe(413);
    expect(calls()).toBe(0);
  });
});

test("keeps the limit large enough for the full model context", () => {
  // 262,144 tokens at several UTF-8 bytes per token must fit with headroom for JSON escaping and schemas.
  expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThanOrEqual(8 * 1024 * 1024);
});
