import {
  GetUserJwtRequestSchema, GetUserJwtResponseSchema, GetChatMessageResponseSchema,
  GetCliModelConfigsRequestSchema, GetCliModelConfigsResponseSchema,
} from "../vendor/devin-proto.ts";
import type { ChatToolCall } from "../vendor/devin-proto.ts";
import {
  CLI_IDENTITY, DISCOVERY_IDENTITY, DEVIN_DEFAULT_BASE_URL, metadata, encodeChatRequest,
} from "./chat-request.ts";
import type { ChatParams } from "./chat-request.ts";
import { checkStatus, decodeUnary, encodeFrame, readFrames, UpstreamError } from "./connect.ts";

export { CLI_IDENTITY, DISCOVERY_IDENTITY, DEVIN_DEFAULT_BASE_URL, SOURCE } from "./chat-request.ts";
export type { ChatParams } from "./chat-request.ts";

async function unary(url: string, body: Uint8Array): Promise<Uint8Array> {
  // Native fetch has an explicit deadline and intentionally no retry/fallback.
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/proto", "connect-protocol-version": "1", accept: "*/*" },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(30_000),
  });
  await checkStatus(response);
  return decodeUnary(new Uint8Array(await response.arrayBuffer()));
}

export async function getUserJwt(
  apiKey: string,
  baseUrl = DEVIN_DEFAULT_BASE_URL,
  identity: Readonly<Partial<ReturnType<typeof metadata>>> = CLI_IDENTITY,
): Promise<{ readonly userJwt: string; readonly baseUrl: string }> {
  const payload = await unary(`${baseUrl}/exa.auth_pb.AuthService/GetUserJwt`,
    GetUserJwtRequestSchema.encode(GetUserJwtRequestSchema.create({ metadata: metadata(apiKey, identity) })));
  const decoded = GetUserJwtResponseSchema.decode(payload);
  if (!decoded.userJwt) throw new UpstreamError("empty_user_jwt");
  const custom = decoded.customApiServerUrl.trim();
  if (custom && new URL(custom).protocol !== "https:") throw new UpstreamError("invalid_api_url");
  return { userJwt: decoded.userJwt, baseUrl: custom ? custom.replace(/\/+$/, "") : baseUrl };
}

export interface DiscoveredModel {
  readonly uid: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly maxTokens: number;
  readonly router: boolean;
}

export async function discoverModels(apiKey: string, baseUrl = DEVIN_DEFAULT_BASE_URL): Promise<DiscoveredModel[]> {
  const payload = await unary(`${baseUrl}/exa.api_server_pb.ApiServerService/GetCliModelConfigs`,
    GetCliModelConfigsRequestSchema.encode(GetCliModelConfigsRequestSchema.create({
      metadata: metadata(apiKey, DISCOVERY_IDENTITY),
    })));
  return GetCliModelConfigsResponseSchema.decode(payload).clientModelConfigs
    .filter(m => m.modelUid)
    .map(m => ({
      uid: m.modelUid, label: m.label, disabled: m.disabled, maxTokens: m.maxTokens,
      router: m.modelInfo?.isModelRouter ?? false,
    }));
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  readonly modelUid: string;
}

export type ChatEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string }
  | { readonly type: "toolcall"; readonly toolCalls: readonly ChatToolCall[] }
  | { readonly type: "usage"; readonly usage: Usage }
  | { readonly type: "done"; readonly stopReason: number; readonly usage: Usage | null };

export async function* streamChat(p: ChatParams): AsyncGenerator<ChatEvent> {
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal, AbortSignal.timeout(90_000), ...(p.signal ? [p.signal] : []),
  ]);
  try {
    const response = await fetch(`${p.baseUrl}/exa.api_server_pb.ApiServerService/GetChatMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/connect+proto", "connect-protocol-version": "1",
        "connect-content-encoding": "gzip", "connect-accept-encoding": "gzip", "accept-encoding": "identity",
      },
      body: new Uint8Array(encodeFrame(encodeChatRequest(p))),
      signal,
    });
    let stopReason = 0;
    let usage: Usage | null = null;
    for await (const payload of readFrames(response)) {
      let message: ReturnType<typeof GetChatMessageResponseSchema.decode>;
      try {
        message = GetChatMessageResponseSchema.decode(payload);
      } catch (error) {
        if (error instanceof Error) throw new UpstreamError("protocol_error");
        throw error;
      }
      const reported = message.actualModelUid || message.usage?.modelUid;
      if (reported && reported !== p.modelUid) throw new UpstreamError("model_mismatch");
      if (message.redact || message.thinkingRedacted) throw new UpstreamError("content_filtered", 403);
      if (message.deltaText) yield { type: "text", text: message.deltaText };
      if (message.deltaThinking) yield { type: "thinking", thinking: message.deltaThinking };
      if (message.deltaToolCalls.length) yield { type: "toolcall", toolCalls: message.deltaToolCalls };
      if (message.usage) {
        usage = {
          inputTokens: Number(message.usage.inputTokens), outputTokens: Number(message.usage.outputTokens),
          cacheWriteTokens: Number(message.usage.cacheWriteTokens), cacheReadTokens: Number(message.usage.cacheReadTokens),
          modelUid: message.usage.modelUid,
        };
        yield { type: "usage", usage };
      }
      if (message.stopReason) stopReason = message.stopReason;
    }
    yield { type: "done", stopReason, usage };
  } finally {
    controller.abort(); // Also cancels upstream when a consumer stops reading.
  }
}
