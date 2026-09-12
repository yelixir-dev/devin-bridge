import { expect, test } from "bun:test";
import { encodeChatRequest, SOURCE } from "../src/chat-request.ts";
import type { ChatParams } from "../src/chat-request.ts";
import { GetChatMessageRequestSchema } from "../vendor/devin-proto.ts";

const base = {
  apiKey: "test-session", userJwt: "test-user-jwt", baseUrl: "http://127.0.0.1",
  modelUid: "swe-2-medium", messages: [{ source: SOURCE.USER, text: "wire probe" }],
} as const satisfies ChatParams;

const tools = [
  {
    name: "read_file", description: "Read a file",
    jsonSchemaString: '{ "type": "object", "properties": {"path":{"type":"string"}}, "required":["path"], "additionalProperties":false }',
    strict: true,
  },
  { name: "list_files", description: "List files", jsonSchemaString: '{"type":"object"}', strict: false },
] as const;

test("encodes native declarations with schema bytes and strict flags", () => {
  // Given two declarations with different strictness.
  const input = { ...base, tools } satisfies ChatParams;
  // When encoded by production and independently decoded by the vendored schema.
  const request = GetChatMessageRequestSchema.decode(encodeChatRequest(input));
  // Then every declaration field, including raw schema formatting, survives.
  expect(request.tools.map(({ name, description, jsonSchemaString, strict }) => ({
    name, description, jsonSchemaString, strict,
  }))).toEqual([...tools]);
});

test("encodes named tool choice in the toolName oneof", () => {
  // Given an explicitly selected function.
  const input = { ...base, tools, toolChoice: { toolName: "read_file" } } satisfies ChatParams;
  // When the wire request is decoded.
  const request = GetChatMessageRequestSchema.decode(encodeChatRequest(input));
  // Then the named branch replaces the default option branch.
  expect(request.toolChoice?.choice).toEqual({ case: "toolName", value: "read_file" });
});

test.each(["auto", "none", "any"])("preserves wire option choice %s", optionName => {
  // Given an opaque wire value; legacy "any" is not the HTTP "required" mapping.
  const input = { ...base, tools, toolChoice: { optionName } } satisfies ChatParams;
  // When the wire request is decoded.
  const request = GetChatMessageRequestSchema.decode(encodeChatRequest(input));
  // Then the codec forwards the option without interpreting provider semantics.
  expect(request.toolChoice?.choice).toEqual({ case: "optionName", value: optionName });
});

test.each([true, false])("inverts parallelToolCalls=%s to the wire disable flag", parallelToolCalls => {
  // Given an explicit parallel setting.
  const input = { ...base, tools, parallelToolCalls } satisfies ChatParams;
  // When the wire request is decoded.
  const request = GetChatMessageRequestSchema.decode(encodeChatRequest(input));
  // Then true exercises the non-default wire value, while false keeps it disabled.
  expect(request.disableParallelToolCalls).toBe(!parallelToolCalls);
});

const toolCalls = [
  { id: "call-read", name: "read_file", argumentsJson: ' { "path": "src/\\u0061.ts", "n": 1e2 }\n' },
  { id: "call-list", name: "list_files", argumentsJson: "{}" },
] as const;

test.each(["", "Inspecting files"])("preserves assistant calls and argument bytes with text=%j", text => {
  // Given tool-only or mixed assistant content, with JSON that must not be reserialized.
  const input = {
    ...base, messages: [{ source: SOURCE.SYSTEM, text, messageId: "assistant-turn", toolCalls }],
  } satisfies ChatParams;
  // When the wire request is decoded.
  const request = GetChatMessageRequestSchema.decode(encodeChatRequest(input));
  // Then call order, identifiers, names and argument strings are unchanged.
  expect(request.chatMessagePrompts).toHaveLength(1);
  const assistant = request.chatMessagePrompts[0];
  expect(assistant).toMatchObject({ messageId: "assistant-turn", source: SOURCE.SYSTEM, prompt: text });
  expect(assistant?.toolCalls.map(({ id, name, argumentsJson }) => ({ id, name, argumentsJson }))).toEqual([...toolCalls]);
  expect(Buffer.from(assistant?.toolCalls[0]?.argumentsJson ?? "")).toEqual(Buffer.from(toolCalls[0].argumentsJson));
});

test("correlates tool results by call ID rather than message ID or position", () => {
  // Given two assistant calls and their results returned in reverse order.
  const input = {
    ...base, messages: [
      { source: SOURCE.SYSTEM, text: "", messageId: "assistant-turn", toolCalls },
      { source: SOURCE.TOOL, text: "[]", messageId: "result-list", toolCallId: "call-list", toolResultIsError: false },
      { source: SOURCE.TOOL, text: "missing file", messageId: "result-read", toolCallId: "call-read", toolResultIsError: true },
    ],
  } satisfies ChatParams;
  // When the wire request is decoded.
  const request = GetChatMessageRequestSchema.decode(encodeChatRequest(input));
  // Then distinct message IDs do not overwrite the result-to-call links or error status.
  expect(request.chatMessagePrompts).toHaveLength(3);
  expect(request.chatMessagePrompts.slice(1).map(({ source, prompt, messageId, toolCallId, toolResultIsError }) => ({
    source, prompt, messageId, toolCallId, toolResultIsError,
  }))).toEqual([
    { source: SOURCE.TOOL, prompt: "[]", messageId: "result-list", toolCallId: "call-list", toolResultIsError: false },
    { source: SOURCE.TOOL, prompt: "missing file", messageId: "result-read", toolCallId: "call-read", toolResultIsError: true },
  ]);
  expect(request.chatMessagePrompts[0]?.toolCalls.map(call => call.id)).toEqual(["call-read", "call-list"]);
});

test("retains ordinary text request defaults and routing", () => {
  // Given an existing text-only caller with no new fields.
  const input = { ...base, messages: [
    { source: SOURCE.USER, text: " \nquestion\t " },
    { source: SOURCE.SYSTEM, text: " answer\n " },
  ] } satisfies ChatParams;
  // When the wire request is decoded.
  const request = GetChatMessageRequestSchema.decode(encodeChatRequest(input));
  // Then content bytes, routing, configuration and tool defaults remain compatible.
  expect(request.chatMessagePrompts.map(({ source, prompt }) => ({ source, text: prompt }))).toEqual(input.messages);
  for (const message of request.chatMessagePrompts) {
    expect(message.messageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(message.toolCalls).toEqual([]);
    expect(message.toolCallId).toBe("");
    expect(message.toolResultIsError).toBe(false);
  }
  expect(request.chatModelUid).toBe(input.modelUid);
  expect(request.requestType).toBe(5);
  expect(request.plannerMode).toBe(1);
  expect(request.prompt).toBe("");
  expect(request.metadata).toMatchObject({ apiKey: "devin-session-token$test-session", userJwt: input.userJwt });
  expect(request.tools).toEqual([]);
  expect(request.disableParallelToolCalls).toBe(true);
  expect(request.toolChoice?.choice).toEqual({ case: "optionName", value: "auto" });
  expect(request.configuration).toMatchObject({ maxTokens: 512n, numCompletions: 1n, temperature: 0.4 });
});

test("retains explicit text configuration overrides", () => {
  // Given existing optional fields, including zero temperature.
  const input = { ...base, systemPrompt: "system input", maxTokens: 123, temperature: 0, stop: ["custom-stop"] } satisfies ChatParams;
  // When the wire request is decoded.
  const request = GetChatMessageRequestSchema.decode(encodeChatRequest(input));
  // Then the codec neither replaces explicit values nor loses caller stop patterns.
  expect(request.prompt).toBe(input.systemPrompt);
  expect(request.configuration).toMatchObject({ maxTokens: 123n, temperature: 0, firstTemperature: 0 });
  expect(request.configuration?.stopPatterns).toEqual([
    "<|user|>", "<|bot|>", "<|context_request|>", "<|endoftext|>", "<|end_of_turn|>", ...input.stop,
  ]);
});
