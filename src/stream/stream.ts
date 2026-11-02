import crypto from "node:crypto";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  acquireCaptchaVerifyParam,
  buildLlmZCodeHeaders,
  buildStartPlanHeaders,
  getOrSolveCaptchaParam,
  getStagedCaptchaParam,
  parseApiKey,
  resolveBaseHost,
  solveCaptchaHeadless,
} from "../client/index.js";
import {
  setLastEndpoint,
  setLastError,
  setLastLatencyMs,
  setLastRequestId,
  setLastResolvedRuntimeModel,
  setLastStatus,
} from "../diagnostics/diagnostics.js";
import { ZCodePlan } from "../types/enums.js";
import { ZCODE_API } from "../types/types.js";
import { redactSecrets } from "../utils/security.js";
import { zcodeEnv } from "../utils/util.js";
import { buildZCodeStartPlanSystem } from "./system-prompt.js";

export { ZCODE_API } from "../types/types.js";

const MAX_TRANSIENT_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

/** Modes we never retry without action (auth / hard risk control). */
const NON_RETRYABLE_PATTERN =
  /3001|401|403|invalid api key|token expired|authentication failed|parameter error/i;

function friendlyZCodeError(status: number | undefined, text: string): string {
  const msg = redactSecrets(text).slice(0, 500);
  if (/context_length_exceeded|maximum context length/i.test(msg)) {
    return `context_length_exceeded: ${msg}`;
  }
  if (/3007|captcha verify failed/i.test(msg)) {
    return `Captcha verification failed for Start Plan. Please check network connection or retry.`;
  }
  if (/3009|3010|concurrency limit|system is busy/i.test(msg)) {
    return `Start Plan model is currently busy or concurrency limit reached. Please retry shortly.`;
  }
  if (/3012|unusual activity/i.test(msg)) {
    return `ZCode gateway check rejected request. Please check /zcode.doctor.`;
  }
  if (/1113|insufficient balance|arrear|no resource package/i.test(msg)) {
    return `Insufficient balance or no active plan for this model. Run /login zcode to refresh.`;
  }
  if (/1004|1000|invalid api key|token expired|authentication failed/i.test(msg)) {
    return `Authentication failed. Run /login zcode to re-authenticate.`;
  }
  if (/1305|overloaded/i.test(msg)) {
    return `The model is currently overloaded. Please retry in a few moments.`;
  }
  if (/1211|model not found/i.test(msg)) {
    return `Model is not available or not enabled for this account.`;
  }
  if (status === 400) {
    return `Request rejected (${msg}). Please verify model parameters.`;
  }
  if (status === 401) {
    return "Authentication failed. Next: run /login zcode.";
  }
  if (status === 403) {
    return `Access denied (${msg}). Next: check account entitlement.`;
  }
  if (status === 429) {
    return `Rate limit exceeded. Please wait a moment and retry.`;
  }
  if (status && status >= 500) {
    return `Server error (${status}: ${msg}). Next: retry in a moment.`;
  }
  return msg || "Unknown API error";
}

function convertTools(tools?: Tool[]): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

/** OpenAI chat-completions tool schema (`{type:"function", function:{...}}`). */
function convertToolsOpenAI(tools?: Tool[]): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function toolResultText(message: { content: unknown }): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((p: any) => p?.type === "text")
      .map((p: any) => p.text)
      .join("\n");
  }
  return "";
}

/**
 * OpenAI chat-completions message list for the Individual Plan endpoint.
 *
 * The Anthropic-shaped converter is not reusable here: OpenAI has no
 * `tool_use`/`tool_result` content blocks (it uses `assistant.tool_calls` and a
 * `role:"tool"` message) and carries images as `image_url` data URLs. Sending
 * Anthropic blocks made the upstream silently ignore every tool, which looked
 * like "the model refuses to use tools".
 */
function convertMessagesOpenAI(context: Context, systemPrompt: string): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];

  if (systemPrompt && systemPrompt.trim().length > 0) {
    messages.push({ role: "system", content: systemPrompt });
  }

  for (const message of context.messages) {
    // System messages were folded into `systemPrompt` above; OpenAI accepts one
    // leading system message, not a stream of them.
    if ((message as { role: string }).role === "system") {
      continue;
    }
    if (message.role === "user") {
      if (typeof message.content === "string") {
        messages.push({ role: "user", content: message.content });
      } else if (Array.isArray(message.content)) {
        const parts: Record<string, unknown>[] = [];
        for (const part of message.content) {
          if (part.type === "text") {
            parts.push({ type: "text", text: part.text });
          } else if (part.type === "image") {
            parts.push({
              type: "image_url",
              image_url: { url: `data:${part.mimeType};base64,${part.data}` },
            });
          }
        }
        messages.push({ role: "user", content: parts });
      }
      continue;
    }

    if (message.role === "assistant") {
      let text = "";
      const toolCalls: Record<string, unknown>[] = [];
      if (typeof message.content === "string") {
        text = message.content;
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "text" && part.text) {
            text += part.text;
          } else if (part.type === "toolCall") {
            toolCalls.push({
              id: part.id,
              type: "function",
              function: {
                name: part.name,
                arguments: JSON.stringify(part.arguments ?? {}),
              },
            });
          }
        }
      }
      const assistant: Record<string, unknown> = { role: "assistant", content: text };
      if (toolCalls.length > 0) {
        assistant.tool_calls = toolCalls;
        if (!text) assistant.content = null;
      }
      messages.push(assistant);
      continue;
    }

    if (message.role === "toolResult") {
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: toolResultText(message),
      });
    }
  }

  return messages;
}

function convertMessages(context: Context, isStartPlan = false): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];

  for (const message of context.messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        messages.push({
          role: "user",
          content: message.content,
          ...(isStartPlan ? { cache_control: { type: "ephemeral" } } : {}),
        });
      } else if (Array.isArray(message.content)) {
        const parts: Record<string, unknown>[] = [];
        for (const part of message.content) {
          if (part.type === "text") {
            parts.push({
              type: "text",
              text: part.text,
              ...(isStartPlan ? { cache_control: { type: "ephemeral" } } : {}),
            });
          } else if (part.type === "image") {
            parts.push({
              type: "image",
              source: {
                type: "base64",
                media_type: part.mimeType,
                data: part.data,
              },
            });
          }
        }
        messages.push({ role: "user", content: parts });
      }
    } else if (message.role === "assistant") {
      const parts: Record<string, unknown>[] = [];
      if (typeof message.content === "string") {
        if (message.content) parts.push({ type: "text", text: message.content });
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "text" && part.text) {
            parts.push({ type: "text", text: part.text });
          } else if (part.type === "toolCall") {
            parts.push({
              type: "tool_use",
              id: part.id,
              name: part.name,
              input: part.arguments,
            });
          }
        }
      }
      messages.push({ role: "assistant", content: parts });
    } else if (message.role === "toolResult") {
      let contentStr = "";
      if (typeof message.content === "string") {
        contentStr = message.content;
      } else if (Array.isArray(message.content)) {
        contentStr = message.content
          .filter((p) => p.type === "text")
          .map((p) => (p as TextContent).text)
          .join("\n");
      }

      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: contentStr,
          },
        ],
      });
    }
  }

  return messages;
}

function resolveEndpointForPlan(
  plan: ZCodePlan,
  model: Model<Api>,
  auth: ReturnType<typeof parseApiKey>,
): string {
  const explicit = zcodeEnv("BASE_URL")?.trim();
  if (explicit && plan !== ZCodePlan.START_PLAN) {
    return explicit.endsWith("/chat/completions")
      ? explicit
      : `${explicit.replace(/\/+$/, "")}/api/coding/paas/v4/chat/completions`;
  }

  // Start Plan goes through the ZCode shared plan proxy.
  if (plan === ZCodePlan.START_PLAN) {
    return "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages";
  }

  if (model.baseUrl) {
    if (model.baseUrl.endsWith("/chat/completions")) {
      return model.baseUrl;
    }
    // The registered provider baseUrl is a bare host (e.g. https://api.z.ai),
    // and the paid Individual Plan only serves the coding subscription gateway.
    // Concatenating blindly produced /api/paas/v4/chat/completions, which the
    // upstream rejects with 1113 "Insufficient balance".
    const base = model.baseUrl.replace(/\/+$/, "");
    if (/\/api\/(coding\/)?paas\/v4$/.test(base)) {
      return `${base}/chat/completions`;
    }
    if (/\/api\/paas\/v4$/.test(base)) {
      return `${base.replace("/api/paas/v4", "/api/coding/paas/v4")}/chat/completions`;
    }
    return `${base}/api/coding/paas/v4/chat/completions`;
  }

  const host = resolveBaseHost(auth);
  return `${host}/api/coding/paas/v4/chat/completions`;
}

function buildRequestHeaders(
  plan: ZCodePlan,
  auth: ReturnType<typeof parseApiKey>,
  captcha?: { param: string; region: string },
): Record<string, string> {
  if (plan === ZCodePlan.START_PLAN) {
    const sessionId = crypto.randomUUID();
    const traceId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const queryId = `01a0${crypto.randomBytes(14).toString("hex")}`;

    const extra: Record<string, string> = {
      "x-zcode-agent": "glm",
      "x-release-channel": "production",
      "x-client-language": "zh-CN",
      "x-request-id": requestId,
      "x-zcode-session-type": "main",
      "x-zcode-trace-id": traceId,
      "x-query-id": queryId,
      "x-session-id": sessionId,
    };

    const effectiveCaptcha = captcha || getStagedCaptchaParam();
    if (effectiveCaptcha?.param) {
      extra["x-aliyun-captcha-verify-param"] = effectiveCaptcha.param;
      if (effectiveCaptcha.region) {
        extra["x-aliyun-captcha-verify-region"] = effectiveCaptcha.region;
      }
    }
    return buildStartPlanHeaders(auth, extra);
  }
  return buildLlmZCodeHeaders(auth);
}

/**
 * Pi (>= 0.8x) normalizes every request into a transcript: the system prompt and
 * the tool declarations are leading `role:"system"` messages (`toolsAdded` /
 * `toolsRemoved` deltas), and `context.systemPrompt` / `context.tools` are empty
 * for a custom stream. Reading only the legacy fields sent every request without
 * a system prompt and without tools, so the model truthfully answered "I have no
 * access to a terminal".
 *
 * These two helpers mirror pi-ai's `getCurrentSystemPrompt` / `getCurrentTools`
 * locally: importing them from `@earendil-works/pi-ai/utils/transcript` breaks on
 * pi-ai builds whose `exports` map does not expose that subpath.
 */
function contentTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part && part.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

function resolveTranscriptSystemPrompt(messages: readonly unknown[]): string {
  const parts: string[] = [];
  for (const raw of messages) {
    const message = raw as { role?: string; content?: unknown };
    if (message?.role !== "system") continue;
    const text = contentTextOf(message.content);
    if (text.length > 0) parts.push(text);
  }
  return parts.join("\n\n");
}

function resolveTranscriptTools(messages: readonly unknown[]): Tool[] {
  const tools = new Map<string, Tool>();
  for (const raw of messages) {
    const message = raw as { role?: string; toolsAdded?: Tool[]; toolsRemoved?: Array<{ name: string }> };
    if (message?.role !== "system") continue;
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  return [...tools.values()];
}

function buildRequestBody({
  model,
  context,
  options,
  plan,
  systemPrompt,
  tools,
}: {
  model: Model<Api>;
  context: Context;
  options: SimpleStreamOptions | undefined;
  plan: ZCodePlan;
  /** Resolved from the transcript; `context.systemPrompt` is empty for custom streams. */
  systemPrompt: string;
  /** Resolved from the transcript; `context.tools` is empty for custom streams. */
  tools: Tool[];
}): Record<string, unknown> {
  if (plan === ZCodePlan.START_PLAN) {
    const system = buildZCodeStartPlanSystem(systemPrompt, model.id);
    const messages = convertMessages(context, true);
    const anthropicTools = convertTools(tools);

    const body: Record<string, unknown> = {
      model: model.id,
      max_tokens: model.maxTokens || 128000,
      system,
      messages,
      stream: true,
      temperature: options?.temperature ?? 0.7,
    };

    if (anthropicTools && anthropicTools.length > 0) {
      body.tools = anthropicTools;
      body.tool_choice = { type: "auto" };
    }

    if (model.reasoning) {
      body.thinking = { type: "enabled", budget_tokens: 8000 };
      body.output_config = { effort: "low" };
    }

    return body;
  }

  // Standard PaaS chat completions format (Individual Plan).
  const body: Record<string, unknown> = {
    model: model.id,
    messages: convertMessagesOpenAI(context, systemPrompt),
    max_tokens: model.maxTokens || 4096,
    stream: true,
    stream_options: { include_usage: true },
    temperature: options?.temperature ?? 0.7,
  };

  const openaiTools = convertToolsOpenAI(tools);
  if (openaiTools) {
    body.tools = openaiTools;
    body.tool_choice = "auto";
  }
  if (model.reasoning && options?.reasoning) {
    body.reasoning_effort = model.thinkingLevelMap?.[options.reasoning] || "medium";
  }

  return body;
}

function isTransientRetryable(text: string): boolean {
  return (
    /1305|3009|3010|overloaded|concurrency limit|temporarily overloaded|429|529/i.test(text) &&
    !NON_RETRYABLE_PATTERN.test(text)
  );
}

/**
 * Native simple stream implementation for ZCode, dispatched by the model's plan.
 */
export function streamZCode(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const plan = resolvePlanFromModel(model);

  (async () => {
    const startTime = Date.now();
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: ZCODE_API,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    let textBlockIndex = -1;
    let thinkingBlockIndex = -1;
    const toolCallIndices = new Map<number, number>();
    const toolCallRawArgs = new Map<number, string>();

    try {
      const auth = parseApiKey(options?.apiKey);
      if (!auth.token && !auth.zcodeJwtToken) {
        throw new Error("Missing ZCode credentials. Run /login zcode first.");
      }

      const endpoint = resolveEndpointForPlan(plan, model, auth);
      setLastEndpoint(endpoint);
      setLastResolvedRuntimeModel(model.id);

      let captchaParam: { param: string; region: string } | undefined = undefined;
      if (plan === ZCodePlan.START_PLAN) {
        try {
          captchaParam = await getOrSolveCaptchaParam(auth.zcodeJwtToken);
        } catch {
          // background solve failed; continue with staged/empty and auto-recover on 3007
        }
      }

      let headers = buildRequestHeaders(plan, auth, captchaParam);
      const requestBody = buildRequestBody({
        model,
        context,
        options,
        plan,
        // Pi's normalized transcript keeps the system prompt and tool
        // declarations as leading system messages; a custom stream that reads
        // `context.systemPrompt` / `context.tools` gets empty values and the
        // model then answers "I have no tools".
        systemPrompt: context.systemPrompt || resolveTranscriptSystemPrompt(context.messages),
        tools: context.tools && context.tools.length > 0 ? context.tools : resolveTranscriptTools(context.messages),
      });

      stream.push({ type: "start", partial: output });

      let res: Response | undefined = undefined;
      let lastErrText = "";

      for (let attempt = 0; attempt < MAX_TRANSIENT_RETRIES; attempt++) {
        if (options?.signal?.aborted) {
          throw new Error("Request aborted");
        }
        if (attempt > 0) {
          const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
          await new Promise((r) => setTimeout(r, delay));
        }

        const candidateRes = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          signal: options?.signal,
        });

        setLastStatus(candidateRes.status);
        const requestId = candidateRes.headers.get("x-request-id") || undefined;
        if (requestId) setLastRequestId(requestId);

        if (candidateRes.ok) {
          res = candidateRes;
          break;
        }

        lastErrText = await candidateRes.text().catch(() => "");

        // Auto-recover from 3007 (Captcha required on Start Plan) by solving headlessly in background
        if (
          /3007|captcha verify failed/i.test(lastErrText) &&
          plan === ZCodePlan.START_PLAN &&
          attempt === 0
        ) {
          try {
            const verified = await solveCaptchaHeadless(auth.zcodeJwtToken);
            if (verified?.captchaVerifyParam) {
              headers = buildRequestHeaders(plan, auth, {
                param: verified.captchaVerifyParam,
                region: verified.captchaRegion,
              });
              continue; // retry immediately with the fresh captcha header
            }
          } catch {
            // fallback
          }
        }

        if (isTransientRetryable(lastErrText) && attempt < MAX_TRANSIENT_RETRIES - 1) {
          continue;
        }

        const friendly = friendlyZCodeError(candidateRes.status, lastErrText);
        setLastError(friendly);
        setLastLatencyMs(Date.now() - startTime);
        throw new Error(friendly);
      }

      if (!res || !res.ok) {
        const friendly = friendlyZCodeError(res?.status, lastErrText);
        setLastError(friendly);
        setLastLatencyMs(Date.now() - startTime);
        throw new Error(friendly);
      }

      if (!res.body) {
        throw new Error("Empty response body received from API");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        if (options?.signal?.aborted) {
          output.stopReason = "aborted";
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || line.startsWith(":") || line.startsWith("event:")) {
            continue;
          }

          if (line.startsWith("data:")) {
            const dataStr = line.slice(5).trim();
            if (dataStr === "[DONE]") continue;

            let chunk: Record<string, unknown> | undefined = undefined;
            try {
              chunk = JSON.parse(dataStr) as Record<string, unknown>;
            } catch {
              continue;
            }

            if (chunk.error) {
              const errObj = chunk.error as { message?: string };
              throw new Error(friendlyZCodeError(res.status, errObj.message || "Streaming error"));
            }

            // 1. Anthropic format events (content_block_delta, message_delta)
            if (chunk.type === "content_block_delta") {
              const delta = chunk.delta as
                { type?: string; text?: string; thinking?: string } | undefined;
              if (delta?.type === "text_delta" && delta.text) {
                if (textBlockIndex === -1) {
                  const block: TextContent = { type: "text", text: delta.text };
                  output.content.push(block);
                  textBlockIndex = output.content.length - 1;
                  stream.push({
                    type: "text_start",
                    contentIndex: textBlockIndex,
                    partial: output,
                  });
                } else {
                  const block = output.content[textBlockIndex] as TextContent;
                  block.text += delta.text;
                  stream.push({
                    type: "text_delta",
                    contentIndex: textBlockIndex,
                    delta: delta.text,
                    partial: output,
                  });
                }
              } else if (delta?.type === "thinking_delta" && delta.thinking) {
                if (thinkingBlockIndex === -1) {
                  const block: ThinkingContent = {
                    type: "thinking",
                    thinking: delta.thinking,
                  };
                  output.content.push(block);
                  thinkingBlockIndex = output.content.length - 1;
                  stream.push({
                    type: "thinking_start",
                    contentIndex: thinkingBlockIndex,
                    partial: output,
                  });
                } else {
                  const block = output.content[thinkingBlockIndex] as ThinkingContent;
                  block.thinking += delta.thinking;
                  stream.push({
                    type: "thinking_delta",
                    contentIndex: thinkingBlockIndex,
                    delta: delta.thinking,
                    partial: output,
                  });
                }
              }
            } else if (chunk.type === "message_delta") {
              const delta = chunk.delta as { stop_reason?: string } | undefined;
              if (delta?.stop_reason === "tool_use") output.stopReason = "toolUse";
              else if (delta?.stop_reason === "max_tokens") output.stopReason = "length";
              else output.stopReason = "stop";

              const usage = chunk.usage as { output_tokens?: number } | undefined;
              if (usage?.output_tokens) {
                output.usage.output = usage.output_tokens;
                output.usage.totalTokens = output.usage.input + output.usage.output;
                calculateCost(model, output.usage);
              }
            }

            // 2. OpenAI format events (choices[0].delta)
            const choices = chunk.choices as
              | Array<{
                  finish_reason?: string;
                  delta?: {
                    content?: string;
                    reasoning_content?: string;
                    tool_calls?: Array<{
                      index?: number;
                      id?: string;
                      function?: { name?: string; arguments?: string };
                    }>;
                  };
                }>
              | undefined;

            if (choices && choices.length > 0) {
              const choice = choices[0];
              if (choice.finish_reason) {
                if (choice.finish_reason === "tool_calls") output.stopReason = "toolUse";
                else if (choice.finish_reason === "length") output.stopReason = "length";
                else output.stopReason = "stop";
              }

              const delta = choice.delta;
              if (delta?.reasoning_content) {
                if (thinkingBlockIndex === -1) {
                  const block: ThinkingContent = {
                    type: "thinking",
                    thinking: delta.reasoning_content,
                  };
                  output.content.push(block);
                  thinkingBlockIndex = output.content.length - 1;
                  stream.push({
                    type: "thinking_start",
                    contentIndex: thinkingBlockIndex,
                    partial: output,
                  });
                } else {
                  const block = output.content[thinkingBlockIndex] as ThinkingContent;
                  block.thinking += delta.reasoning_content;
                  stream.push({
                    type: "thinking_delta",
                    contentIndex: thinkingBlockIndex,
                    delta: delta.reasoning_content,
                    partial: output,
                  });
                }
              }

              if (delta?.content) {
                if (thinkingBlockIndex !== -1) {
                  const block = output.content[thinkingBlockIndex] as ThinkingContent;
                  stream.push({
                    type: "thinking_end",
                    contentIndex: thinkingBlockIndex,
                    content: block.thinking,
                    partial: output,
                  });
                  thinkingBlockIndex = -1;
                }

                if (textBlockIndex === -1) {
                  const block: TextContent = { type: "text", text: delta.content };
                  output.content.push(block);
                  textBlockIndex = output.content.length - 1;
                  stream.push({
                    type: "text_start",
                    contentIndex: textBlockIndex,
                    partial: output,
                  });
                } else {
                  const block = output.content[textBlockIndex] as TextContent;
                  block.text += delta.content;
                  stream.push({
                    type: "text_delta",
                    contentIndex: textBlockIndex,
                    delta: delta.content,
                    partial: output,
                  });
                }
              }

              if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const callIdx = tc.index ?? 0;
                  if (!toolCallIndices.has(callIdx)) {
                    const block: ToolCall = {
                      type: "toolCall",
                      id: tc.id || `call_${Date.now()}_${callIdx}`,
                      name: tc.function?.name || "",
                      arguments: {},
                    };
                    output.content.push(block);
                    const contentIdx = output.content.length - 1;
                    toolCallIndices.set(callIdx, contentIdx);
                    toolCallRawArgs.set(callIdx, tc.function?.arguments || "");
                    stream.push({
                      type: "toolcall_start",
                      contentIndex: contentIdx,
                      partial: output,
                    });
                  } else {
                    const contentIdx = toolCallIndices.get(callIdx)!;
                    const block = output.content[contentIdx] as ToolCall;
                    if (tc.function?.name && !block.name) block.name = tc.function.name;
                    if (tc.function?.arguments) {
                      const prevArgs = toolCallRawArgs.get(callIdx) || "";
                      const newArgs = prevArgs + tc.function.arguments;
                      toolCallRawArgs.set(callIdx, newArgs);
                      try {
                        block.arguments = JSON.parse(newArgs);
                      } catch {
                        // incomplete JSON
                      }
                      stream.push({
                        type: "toolcall_delta",
                        contentIndex: contentIdx,
                        delta: tc.function.arguments,
                        partial: output,
                      });
                    }
                  }
                }
              }
            }

            // Usage update
            const chunkUsage = chunk.usage as
              | {
                  prompt_tokens?: number;
                  completion_tokens?: number;
                  prompt_tokens_details?: { cached_tokens?: number };
                }
              | undefined;

            if (chunkUsage) {
              const inTokens = chunkUsage.prompt_tokens || 0;
              const outTokens = chunkUsage.completion_tokens || 0;
              const cached = chunkUsage.prompt_tokens_details?.cached_tokens || 0;
              // `prompt_tokens` already contains the cached prefix. Pi's convention
              // (and its cost/context accounting) expects `input` to be the
              // non-cached part, otherwise every cached token is billed twice and
              // the context meter reads as if the window were almost full.
              output.usage.input = Math.max(0, inTokens - cached);
              output.usage.output = outTokens;
              output.usage.cacheRead = cached;
              output.usage.totalTokens = inTokens + outTokens;
              calculateCost(model, output.usage);
            }
          }
        }
      }

      // Close open blocks
      if (thinkingBlockIndex !== -1) {
        const block = output.content[thinkingBlockIndex] as ThinkingContent;
        stream.push({
          type: "thinking_end",
          contentIndex: thinkingBlockIndex,
          content: block.thinking,
          partial: output,
        });
      }
      if (textBlockIndex !== -1) {
        const block = output.content[textBlockIndex] as TextContent;
        stream.push({
          type: "text_end",
          contentIndex: textBlockIndex,
          content: block.text,
          partial: output,
        });
      }
      for (const [callIdx, contentIdx] of toolCallIndices.entries()) {
        const block = output.content[contentIdx] as ToolCall;
        const rawArgs = toolCallRawArgs.get(callIdx) || "{}";
        try {
          block.arguments = JSON.parse(rawArgs);
        } catch {
          block.arguments = {};
        }
        stream.push({
          type: "toolcall_end",
          contentIndex: contentIdx,
          toolCall: block,
          partial: output,
        });
      }

      setLastLatencyMs(Date.now() - startTime);
      setLastError(undefined);

      const doneReason =
        output.stopReason === "toolUse" ||
        output.stopReason === "length" ||
        output.stopReason === "deferred"
          ? output.stopReason
          : "stop";

      stream.push({ type: "done", reason: doneReason, message: output });
      stream.end();
    } catch (error) {
      setLastLatencyMs(Date.now() - startTime);
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      setLastError(output.errorMessage);

      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

// The plain `zcode` provider re-exports whatever plan is actually entitled.
// Hardcoding START_PLAN there sent paid accounts to the start-plan gateway,
// which answers 401 for them (and drags in a captcha solve) — the provider
// registration sets this to the detected plan instead.
let _fallbackPlan: ZCodePlan | undefined;

export function setFallbackPlan(plan: ZCodePlan | undefined): void {
  _fallbackPlan = plan;
}

function resolvePlanFromModel(model: Model<Api>): ZCodePlan {
  if (model.provider === "zcode-individual-plan" || model.provider === "zcode-individual") {
    return ZCodePlan.INDIVIDUAL_PLAN;
  }
  if (model.provider === "zcode-start-plan") {
    return ZCodePlan.START_PLAN;
  }
  return _fallbackPlan ?? ZCodePlan.START_PLAN;
}
