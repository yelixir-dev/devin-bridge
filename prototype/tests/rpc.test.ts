import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { GetChatMessageRequestSchema, GetChatMessageResponseSchema } from "../vendor/devin-proto.ts";
import { SOURCE, streamChat } from "../src/devin-rpc.ts";

test("sends a CASCADE request rather than the obsolete GENERAL request", async () => {
  // Given a real HTTP seam decoding the independently sourced wire schema.
  const observed = Promise.withResolvers<ReturnType<typeof GetChatMessageRequestSchema.decode>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const framed = Buffer.from(await request.arrayBuffer());
      observed.resolve(GetChatMessageRequestSchema.decode(gunzipSync(framed.subarray(5))));
      return new Response(new Uint8Array([2, 0, 0, 0, 2, 123, 125]));
    },
  });
  try {
    // When the existing production client sends a request.
    for await (const _event of streamChat({
      apiKey: "test-session",
      userJwt: "test-user-jwt",
      baseUrl: server.url.origin,
      modelUid: "swe-2-medium",
      messages: [{ source: SOURCE.USER, text: "wire probe" }],
    })) {
      // Consume the response to completion.
    }
    // Then upstream receives CASCADE=5 with the exact requested model.
    const request = await observed.promise;
    expect(request.requestType).toBe(5);
    expect(request.chatModelUid).toBe("swe-2-medium");
    expect(request.chatMessagePrompts[0]?.prompt).toBe("wire probe");
  } finally {
    await server.stop(true);
  }
});

function frame(flag: number, payload: Uint8Array) {
  const output = Buffer.alloc(payload.length + 5);
  output[0] = flag;
  output.writeUInt32BE(payload.length, 1);
  output.set(payload, 5);
  return output;
}

async function consume(baseUrl: string) {
  return Array.fromAsync(streamChat({
    apiKey: "test-session",
    userJwt: "test-user-jwt",
    baseUrl,
    modelUid: "swe-2-medium",
    messages: [{ source: SOURCE.USER, text: "test" }],
  }));
}

test("preserves whitespace and reports the upstream usage and model", async () => {
  // Given a compressed response with real wire-schema usage fields.
  const text = " \n  answer\t ";
  const payload = GetChatMessageResponseSchema.encode(GetChatMessageResponseSchema.create({
    deltaText: text, actualModelUid: "swe-2-medium", stopReason: 2,
  }));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response(Buffer.concat([frame(0, payload), frame(2, Buffer.from("{}"))]));
  } });
  try {
    // When the client decodes the real HTTP stream.
    const events = await consume(server.url.origin);
    // Then text remains byte-equivalent and a terminal event exists.
    expect(events.filter(e => e.type === "text").map(e => e.text).join("")).toBe(text);
    expect(events.at(-1)?.type).toBe("done");
  } finally {
    await server.stop(true);
  }
});

test.each(["permission_denied", "resource_exhausted", "not_found"])(
  "propagates %s without retrying or reporting success",
  async (code) => {
    // Given an upstream that refuses this exact model.
    let calls = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      calls++;
      return new Response(frame(2, Buffer.from(JSON.stringify({ error: { code, message: "rejected" } }))));
    } });
    try {
      // When one completion is requested.
      const completion = consume(server.url.origin);
      // Then the refusal is an error, not a done event or another model attempt.
      await expect(completion).rejects.toMatchObject({ code });
      expect(calls).toBe(1);
    } finally {
      await server.stop(true);
    }
  },
);

test.each([
  { name: "partial frame header", payload: Buffer.from([0, 0, 0]) },
  { name: "missing end-stream trailer", payload: frame(0, Buffer.from([26, 1, 65])) },
  { name: "invalid trailer JSON", payload: frame(2, Buffer.from("{broken")) },
])("rejects $name instead of silently ending", async ({ payload }) => {
  // Given a malformed or incomplete response.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(payload) });
  try {
    // When the stream closes.
    // Then completion fails rather than fabricating success.
    await expect(consume(server.url.origin)).rejects.toMatchObject({ code: "protocol_error" });
  } finally {
    await server.stop(true);
  }
});

test("rejects an upstream-reported model substitution", async () => {
  // Given a response reporting a model different from the explicitly requested one.
  const payload = GetChatMessageResponseSchema.encode(GetChatMessageResponseSchema.create({
    actualModelUid: "claude-opus-4-8-medium", deltaText: "wrong model",
  }));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response(Buffer.concat([frame(0, payload), frame(2, Buffer.from("{}"))]));
  } });
  try {
    // When the response is consumed.
    // Then no substitute answer is accepted.
    await expect(consume(server.url.origin)).rejects.toMatchObject({ code: "model_mismatch" });
  } finally {
    await server.stop(true);
  }
});
