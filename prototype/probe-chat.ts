import { loadApiKey, loadApiServerUrl } from "./src/creds.ts";
import {
  getUserJwt, streamChat, SOURCE, DEVIN_DEFAULT_BASE_URL,
} from "./src/devin-rpc.ts";

const key = loadApiKey();
const base = loadApiServerUrl() ?? DEVIN_DEFAULT_BASE_URL;
const model = process.argv[2] ?? "swe-2-medium";
const authStart = performance.now();
const auth = await getUserJwt(key, base);
console.log(JSON.stringify({ event: "auth_ok", elapsedMs: performance.now() - authStart }));
const started = performance.now();
let firstTextMs: number | undefined;
let text = "";
let usage: unknown = null;
let stopReason = 0;
let textChunks = 0;
for await (const event of streamChat({
  apiKey: key,
  userJwt: auth.userJwt,
  baseUrl: auth.baseUrl,
  modelUid: model,
  systemPrompt: "You are a terse assistant.",
  messages: [{ source: SOURCE.USER, text: "Reply with exactly: OK" }],
  maxTokens: 128,
  temperature: 0.2,
  signal: AbortSignal.timeout(60_000),
})) {
  switch (event.type) {
    case "text":
      firstTextMs ??= performance.now() - started;
      text += event.text ?? "";
      textChunks++;
      break;
    case "usage":
      usage = event.usage;
      break;
    case "done":
      stopReason = event.stopReason ?? 0;
      break;
    case "thinking":
    case "toolcall":
      break;
  }
}
console.log(JSON.stringify({
  event: "result", model, firstTextMs, totalMs: performance.now() - started,
  text, textChunks, usage, stopReason,
}, (_key, value) => typeof value === "bigint" ? value.toString() : value));
if (!text) process.exitCode = 1;
