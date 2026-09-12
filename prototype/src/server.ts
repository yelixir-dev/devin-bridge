import { z } from "zod";
import { createHandler, MAX_REQUEST_BODY_BYTES } from "./http.ts";
import { createUserJwtCache } from "./auth.ts";
import { loadApiKey, loadApiServerUrl } from "./creds.ts";
import { discoverModels, getUserJwt, SOURCE, streamChat, DEVIN_DEFAULT_BASE_URL } from "./devin-rpc.ts";
import type { ChatParams } from "./devin-rpc.ts";

const apiKey = z.string().min(16).parse(process.env["DEVIN_BRIDGE_API_KEY"]);
const port = z.coerce.number().int().min(1).max(65535).default(8787).parse(process.env["PORT"]);
const token = loadApiKey();
const baseUrl = loadApiServerUrl() ?? DEVIN_DEFAULT_BASE_URL;
const models = await discoverModels(token, baseUrl);
const userJwt = createUserJwtCache({ fetchJwt: () => getUserJwt(token, baseUrl) });
const server = Bun.serve({
  hostname: "127.0.0.1", port, idleTimeout: 120, maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  fetch: createHandler({
    models,
    async *complete(input, signal) {
      const auth = await userJwt.get();
      const system = input.messages.filter(m => m.role === "system" || m.role === "developer").map(m => m.content).join("\n\n");
      const messages = input.messages.filter(m => m.role !== "system" && m.role !== "developer").map((m): ChatParams["messages"][number] => {
        switch (m.role) {
          case "user": return { source: SOURCE.USER, text: m.content };
          case "assistant": return {
            source: SOURCE.SYSTEM, text: m.content ?? "",
            toolCalls: (m.tool_calls ?? []).map(call => ({
              id: call.id, name: call.function.name, argumentsJson: call.function.arguments,
            })),
          };
          case "tool": return { source: SOURCE.TOOL, text: m.content, toolCallId: m.tool_call_id };
          default: { const unhandled: never = m; throw unhandled; }
        }
      });
      const toolChoice = typeof input.tool_choice === "object"
        ? { toolName: input.tool_choice.function.name }
        : { optionName: input.tool_choice ?? "auto" };
      yield* streamChat({
        apiKey: token, userJwt: auth.userJwt, baseUrl: auth.baseUrl,
        modelUid: input.model, systemPrompt: system, messages,
        maxTokens: input.max_tokens, signal,
        tools: (input.tools ?? []).map(tool => ({
          name: tool.function.name, description: tool.function.description ?? "",
          jsonSchemaString: JSON.stringify(tool.function.parameters ?? { type: "object", properties: {} }),
          strict: tool.function.strict ?? false,
        })),
        toolChoice,
        ...(input.parallel_tool_calls !== undefined ? { parallelToolCalls: input.parallel_tool_calls } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.stop !== undefined ? { stop: typeof input.stop === "string" ? [input.stop] : input.stop } : {}),
      });
    },
  }, apiKey),
});
console.log(JSON.stringify({
  event: "listening", url: server.url.origin, pid: process.pid,
  models: models.filter(m => !m.disabled && !m.router).length,
  transport: "direct-connect-rpc", modelFallback: false,
}));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.stop(true).then(() => process.exit(0));
  });
}
