import { expect, test } from "bun:test";
import { createHandler } from "../src/http.ts";
import type { ChatEvent } from "../src/devin-rpc.ts";
import { ChatToolCallSchema, StopReason } from "../vendor/devin-proto.ts";

const model = { uid: "swe-2-high", label: "SWE-2", disabled: false, router: false, maxTokens: 8192 };
const declaration = (name: string) => ({
  type: "function", function: { name, parameters: { type: "object", properties: { text: { type: "string" } } } },
});
const native = (argumentsJson: string, extra: Partial<ReturnType<typeof ChatToolCallSchema.create>> = {}): ChatEvent => ({
  type: "toolcall", toolCalls: [ChatToolCallSchema.create({ id: "store_0", name: "store", argumentsJson, ...extra })],
});
const done = (stopReason = StopReason.FUNCTION_CALL): ChatEvent => ({ type: "done", stopReason, usage: null });
const xml = '<invoke name="store"><parameter name="text">literal\\n\u0000</parameter></invoke>';

async function request(stream: boolean, events: readonly ChatEvent[], extra: Record<string, unknown> = {}) {
  let attempts = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: createHandler({
      models: [model],
      async *complete() { attempts++; yield* events; },
    }, "tool-boundary-fixture"),
  });
  try {
    const response = await fetch(`${server.url.origin}/v1/chat/completions`, {
      method: "POST", headers: { Authorization: "Bearer tool-boundary-fixture", "Content-Type": "application/json" },
      body: JSON.stringify({ model: model.uid, stream, messages: [{ role: "user", content: "fixture" }], tools: [declaration("store")], ...extra }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.text();
    expect(attempts).toBe(1);
    return { status: response.status, body };
  } finally { await server.stop(true); }
}

function expectFailure(response: { status: number; body: string }, stream: boolean) {
  if (stream) {
    expect(response.body).not.toContain("data: [DONE]");
    const frames = response.body.split("\n\n").filter(Boolean).map(frame => JSON.parse(frame.slice(6)));
    expect(frames.at(-1)).toMatchObject({ error: { code: "invalid_tool_call" } });
    expect(frames.flatMap(frame => frame.choices ?? []).every(choice => choice.finish_reason == null)).toBe(true);
    expect(response.body).not.toContain("data: [DONE]");
  } else {
    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "invalid_tool_call" } });
  }
}

for (const stream of [false, true]) {
  test.each([
    { label: "required", tool_choice: "required" },
    { label: "named", tool_choice: { type: "function", function: { name: "store" } } },
  ])(`rejects XML-only output instead of claiming forced tool success (stream=${stream}, $label)`, async ({ tool_choice }) => {
    expectFailure(await request(stream, [{ type: "text", text: xml }, done(StopReason.STOP_PATTERN)], { tool_choice }), stream);
  });

  test.each([
    { label: "unparsed source", extra: { invalidJsonStr: '<parameter name="text">lost\u0000value</parameter>' } },
    { label: "parser error", extra: { invalidJsonErr: "parse failed" } },
    { label: "custom tool payload", extra: { isCustomToolCall: true } },
  ])(`rejects flagged upstream tool output even with valid arguments (stream=${stream}, $label)`, async ({ extra }) => {
    expectFailure(await request(stream, [native('{"text":"value"}', extra), done()]), stream);
  });

  test.each([
    { label: "none", extra: { tool_choice: "none" }, name: "store" },
    { label: "undeclared name", extra: {}, name: "other" },
    { label: "no tools declared", extra: { tools: [] }, name: "store" },
    { label: "wrong named choice", extra: { tools: [declaration("store"), declaration("other")], tool_choice: { type: "function", function: { name: "store" } } }, name: "other" },
  ])(`rejects native calls outside the requested tool contract (stream=${stream}, $label)`, async ({ extra, name }) => {
    expectFailure(await request(stream, [native("{}", { name }), done()], extra), stream);
  });

  test(`rejects native calls with a non-tool stop reason (stream=${stream})`, async () => {
    expectFailure(await request(stream, [{ type: "text", text: "partial" }, native("{}"), done(StopReason.STOP_PATTERN)]), stream);
  });

  test(`rejects truncated tool JSON without a successful terminal marker (stream=${stream})`, async () => {
    expectFailure(await request(stream, [native('{"text":"partial'), done(StopReason.MAX_TOKENS)]), stream);
  });

  test.each([StopReason.MAX_TOKENS, StopReason.CONTENT_FILTER])(`retains upstream interruption without inventing a forced call (stream=${stream}, %s)`, async stopReason => {
    const response = await request(stream, [done(stopReason)], { tool_choice: "required" });
    const reason = stopReason === StopReason.MAX_TOKENS ? "length" : "content_filter";
    expect(response.status).toBe(200);
    if (stream) {
      const chunks = response.body.split("\n\n").filter(frame => frame && frame !== "data: [DONE]").map(frame => JSON.parse(frame.slice(6)));
      expect(chunks.at(-1).choices[0].finish_reason).toBe(reason);
      expect(response.body).toEndWith("data: [DONE]\n\n");
    } else expect(JSON.parse(response.body).choices[0].finish_reason).toBe(reason);
  });

  test.each(["auto", "none"])(`keeps XML examples literal when tools are not required (stream=${stream}, %s)`, async tool_choice => {
    const response = await request(stream, [{ type: "text", text: xml }, done(StopReason.STOP_PATTERN)], { tool_choice });
    expect(response.status).toBe(200);
    if (stream) {
      const chunks = response.body.split("\n\n").filter(frame => frame && frame !== "data: [DONE]").map(frame => JSON.parse(frame.slice(6)));
      expect(chunks.flatMap(chunk => chunk.choices ?? []).map(choice => choice.delta?.content ?? "").join("")).toBe(xml);
      expect(chunks.flatMap(chunk => chunk.choices ?? []).some(choice => choice.delta?.tool_calls)).toBe(false);
      expect(response.body).toEndWith("data: [DONE]\n\n");
    } else {
      expect(JSON.parse(response.body).choices[0]).toEqual({ index: 0, message: { role: "assistant", content: xml }, finish_reason: "stop" });
    }
  });

  test(`preserves every control and literal escape in native JSON (stream=${stream})`, async () => {
    const text = `  한글 e\u0301 😀 "quoted" \\path\\\tTAB\nnewline\rreturn\u0000null ${Array.from({ length: 32 }, (_, n) => String.fromCharCode(n)).join("")} literal \\n \\r \\t \\u0000 &amp; ${xml}  `;
    const argumentsJson = ` { "text": ${JSON.stringify(text)} }\n`;
    const events = [...argumentsJson].map(fragment => native(fragment));
    const response = await request(stream, [...events, done()]);
    expect(response.status).toBe(200);
    let actual: string;
    if (stream) {
      const chunks = response.body.split("\n\n").filter(frame => frame && frame !== "data: [DONE]").map(frame => JSON.parse(frame.slice(6)));
      actual = chunks.flatMap(chunk => chunk.choices ?? []).flatMap(choice => choice.delta?.tool_calls ?? []).map(call => call.function.arguments ?? "").join("");
      expect(response.body).toEndWith("data: [DONE]\n\n");
    } else actual = JSON.parse(response.body).choices[0].message.tool_calls[0].function.arguments;
    expect(actual).toBe(argumentsJson);
    expect(JSON.parse(actual)).toEqual({ text });
  });
}
