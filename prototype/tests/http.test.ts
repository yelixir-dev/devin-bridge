import { expect, test } from "bun:test";
import { createHandler } from "../src/http.ts";
import { UpstreamError } from "../src/connect.ts";
import type { ChatEvent } from "../src/devin-rpc.ts";

const key = "local-fixture-key";
const payload = {
  model: "swe-2-medium", stream: true, max_tokens: 128,
  messages: [{ role: "user", content: "wire fixture" }],
};
const usage = {
  inputTokens: 111, outputTokens: 27, cacheWriteTokens: 0, cacheReadTokens: 0,
  modelUid: "swe-2-medium",
};

async function fixture(
  produce: () => AsyncIterable<ChatEvent>,
  check: (origin: string, calls: () => number) => Promise<void>,
) {
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: createHandler({
      models: [{ uid: "swe-2-medium", label: "SWE-2 Medium", disabled: false, maxTokens: 8192, router: false }],
      complete(input) {
        calls++;
        expect(input.model).toBe("swe-2-medium");
        return produce();
      },
    }, key),
  });
  try {
    await check(server.url.origin, () => calls);
  } finally {
    await server.stop(true);
  }
}

function send(origin: string, body: unknown) {
  return fetch(`${origin}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

async function* answer(): AsyncGenerator<ChatEvent> {
  yield { type: "text", text: " \nOK" };
  yield { type: "usage", usage };
  yield { type: "done", stopReason: 2, usage };
}

test("streams real text events as OpenAI chunks with terminal usage", async () => {
  // Given a backend producing independent text and usage events.
  await fixture(answer, async (origin, calls) => {
    // When the live HTTP endpoint is called.
    const response = await send(origin, { ...payload, stream_options: { include_usage: true } });
    const body = await response.text();
    // Then JSON SSE carries exact text and a successful terminal marker.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain('"content":" \\nOK"');
    expect(body).toContain('"model":"swe-2-medium"');
    expect(body).toContain('"prompt_tokens":111');
    expect(body).toEndWith("data: [DONE]\n\n");
    expect(calls()).toBe(1);
  });
});

test("returns a nonstreamed OpenAI completion with actual usage", async () => {
  // Given a text/usage-producing backend.
  await fixture(answer, async (origin, calls) => {
    // When stream=false.
    const response = await send(origin, { ...payload, stream: false });
    // Then one JSON response preserves the model and answer.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      object: "chat.completion", model: "swe-2-medium",
      choices: [{ message: { role: "assistant", content: " \nOK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 111, completion_tokens: 27, total_tokens: 138 },
    });
    expect(calls()).toBe(1);
  });
});

test.each([
  { extra: { model: "unknown-model" }, status: 404 },
  { extra: { model: "claude-opus-5-max" }, status: 404 },
  { extra: { n: 2 }, status: 400 },
  { extra: { tools: [{ type: "function" }] }, status: 400 },
  { extra: { max_tokens: -1 }, status: 400 },
])("rejects unsupported input $extra before inference", async ({ extra, status }) => {
  // Given an explicit supported model and text-only capability.
  await fixture(answer, async (origin, calls) => {
    // When an unsupported request arrives.
    const response = await send(origin, { ...payload, ...extra });
    // Then it fails without model substitution or upstream work.
    expect(response.status).toBe(status);
    expect(calls()).toBe(0);
  });
});

test("rejects missing client authorization", async () => {
  // Given a private loopback service.
  await fixture(answer, async (origin, calls) => {
    // When no API key is sent.
    const response = await fetch(`${origin}/v1/models`);
    // Then no upstream work is performed.
    expect(response.status).toBe(401);
    expect(calls()).toBe(0);
  });
});

test("maps upstream 429 without attempting any other model", async () => {
  // Given an upstream refusing the requested model.
  await fixture(async function* () { throw new UpstreamError("resource_exhausted"); }, async (origin, calls) => {
    // When one request is received.
    const response = await send(origin, payload);
    // Then it returns 429 before stream headers, exactly once.
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: "resource_exhausted" } });
    expect(calls()).toBe(1);
  });
});

test("emits an error without DONE if upstream fails after visible text", async () => {
  // Given a stream that fails after its first chunk.
  await fixture(async function* () {
    yield { type: "text", text: "partial" };
    throw new UpstreamError("protocol_error");
  }, async (origin, calls) => {
    // When the real HTTP stream is consumed.
    const response = await send(origin, payload);
    const body = await response.text();
    // Then the partial answer is not reported as successful.
    expect(body).toContain('"content":"partial"');
    expect(body).toContain('"code":"protocol_error"');
    expect(body).not.toContain("[DONE]");
    expect(calls()).toBe(1);
  });
});
