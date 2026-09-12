import {
  CacheControlType, ChatMessagePromptSchema, ChatMessageRequestType, ChatMessageSource,
  ChatToolCallSchema, ChatToolChoiceSchema, ChatToolDefinitionSchema,
  CompletionConfigurationSchema, ConversationalPlannerMode,
  GetChatMessageRequestSchema, MetadataSchema, PromptCacheOptionsSchema,
} from "../vendor/devin-proto.ts";

export const DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com";
export const SOURCE = ChatMessageSource;
const os = process.platform === "win32" ? "windows" : process.platform;

// Values retained from the pinned oh-my-pi wire/devin.ts, not a runtime CLI dependency.
export const CLI_IDENTITY = {
  ideName: "devin-cli", ideType: "chisel", ideVersion: "3000.6.2",
  extensionName: "chisel", extensionVersion: "3000.6.2", locale: "en", os,
} as const;
export const DISCOVERY_IDENTITY = {
  ideName: "chisel", ideVersion: "0.0.0-dev",
  extensionName: "chisel", extensionVersion: "0.0.0-dev", locale: "en", os,
} as const;
type Identity = Readonly<Partial<ReturnType<typeof MetadataSchema.create>>>;

export function metadata(apiKey: string, identity: Identity, userJwt = "") {
  return MetadataSchema.create({
    ...identity,
    apiKey: apiKey.startsWith("devin-session-token$") ? apiKey : `devin-session-token$${apiKey}`,
    userJwt,
  });
}

export interface ChatParams {
  readonly apiKey: string;
  readonly userJwt: string;
  readonly baseUrl: string;
  readonly modelUid: string;
  readonly systemPrompt?: string;
  readonly messages: readonly {
    readonly source: ChatMessageSource;
    readonly text: string;
    readonly messageId?: string;
    readonly toolCalls?: readonly {
      readonly id: string;
      readonly name: string;
      readonly argumentsJson: string;
    }[];
    readonly toolCallId?: string;
    readonly toolResultIsError?: boolean;
  }[];
  readonly tools?: readonly {
    readonly name: string;
    readonly description: string;
    readonly jsonSchemaString: string;
    readonly strict: boolean;
  }[];
  readonly toolChoice?: { readonly optionName: string } | { readonly toolName: string };
  readonly parallelToolCalls?: boolean;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly stop?: readonly string[];
  readonly identity?: Identity;
  readonly signal?: AbortSignal;
}

export function encodeChatRequest(p: ChatParams): Uint8Array {
  const temperature = p.temperature ?? 0.4;
  const toolChoice = p.toolChoice ?? { optionName: "auto" };
  return GetChatMessageRequestSchema.encode(GetChatMessageRequestSchema.create({
    metadata: metadata(p.apiKey, p.identity ?? CLI_IDENTITY, p.userJwt),
    prompt: p.systemPrompt ?? "",
    chatMessagePrompts: p.messages.map(m => ChatMessagePromptSchema.create({
      messageId: m.messageId ?? crypto.randomUUID(), source: m.source, prompt: m.text,
      toolCalls: (m.toolCalls ?? []).map(call => ChatToolCallSchema.create(call)),
      toolCallId: m.toolCallId ?? "",
      toolResultIsError: m.toolResultIsError ?? false,
    })),
    chatModelUid: p.modelUid,
    requestType: ChatMessageRequestType.CASCADE,
    plannerMode: ConversationalPlannerMode.DEFAULT,
    tools: (p.tools ?? []).map(tool => ChatToolDefinitionSchema.create(tool)),
    disableParallelToolCalls: !(p.parallelToolCalls ?? false),
    toolChoice: ChatToolChoiceSchema.create({ choice: "toolName" in toolChoice
      ? { case: "toolName", value: toolChoice.toolName }
      : { case: "optionName", value: toolChoice.optionName } }),
    systemPromptCacheOptions: PromptCacheOptionsSchema.create({ type: CacheControlType.EPHEMERAL }),
    cascadeId: crypto.randomUUID(),
    executionId: crypto.randomUUID(),
    configuration: CompletionConfigurationSchema.create({
      numCompletions: 1n, maxTokens: BigInt(p.maxTokens ?? 512), maxNewlines: 200n,
      temperature, firstTemperature: temperature, topK: 50n, topP: 1,
      stopPatterns: ["<|user|>", "<|bot|>", "<|context_request|>", "<|endoftext|>", "<|end_of_turn|>", ...(p.stop ?? [])],
      fimEotProbThreshold: 1,
    }),
  }));
}
