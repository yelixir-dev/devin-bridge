import { z } from "zod";
import { createHandler } from "./http.ts";
import { loadApiKey, loadApiServerUrl } from "./creds.ts";
import { discoverModels, getUserJwt, SOURCE, streamChat, DEVIN_DEFAULT_BASE_URL } from "./devin-rpc.ts";

const apiKey = z.string().min(16).parse(process.env["DEVIN_BRIDGE_API_KEY"]);
const port = z.coerce.number().int().min(1).max(65535).default(8787).parse(process.env["PORT"]);
const token = loadApiKey();
const baseUrl = loadApiServerUrl() ?? DEVIN_DEFAULT_BASE_URL;
const models = await discoverModels(token, baseUrl);
const server = Bun.serve({
  hostname: "127.0.0.1", port, idleTimeout: 120, maxRequestBodySize: 512 * 1024,
  fetch: createHandler({
    models,
    async *complete(input, signal) {
      const auth = await getUserJwt(token, baseUrl);
      const system = input.messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
      const messages = input.messages.filter(m => m.role !== "system").map(m => ({
        source: m.role === "assistant" ? SOURCE.SYSTEM : SOURCE.USER,
        text: m.content,
      }));
      yield* streamChat({
        apiKey: token, userJwt: auth.userJwt, baseUrl: auth.baseUrl,
        modelUid: input.model, systemPrompt: system, messages,
        maxTokens: input.max_tokens, signal,
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
