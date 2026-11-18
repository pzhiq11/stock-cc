import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { LlmConfig } from "@/lib/settings";

export type ModelMessage = { role: "system" | "user" | "assistant"; content: string };
type Mode = "connection" | "report" | "signal";
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map(block => {
    const item = record(block);
    if (!item || !["text", "output_text"].includes(String(item.type))) return "";
    if (typeof item.text === "string") return item.text;
    const text = record(item.text);
    return typeof text?.value === "string" ? text.value : "";
  }).join("").trim();
}

export function parseModelResult(value: unknown): { text: string; usage: Record<string, number> | null } {
  const result = record(value);
  if (!result || result.error) throw new Error("模型接口返回了错误结果，请检查模型权限或供应商服务状态。");
  const choices = Array.isArray(result.choices) ? result.choices : [];
  const choice = record(choices[0]), message = record(choice?.message);
  if (message?.refusal || choice?.finish_reason === "content_filter") throw new Error("模型拒绝了本次请求，请调整输入后重试。");
  if (choice?.finish_reason === "length") throw new Error("模型输出预算耗尽，正文可能被截断；请降低思考强度或增加输出预算后重试。");
  const text = contentText(message?.content);
  if (!text) {
    if (typeof message?.reasoning_content === "string" && message.reasoning_content.trim()) throw new Error("模型只返回了思考内容，没有最终正文。连接测试会关闭 DeepSeek 思考模式；请检查模型或代理是否支持该参数。");
    if (!choice || !message) throw new Error("模型响应不符合 Chat Completions 格式，请检查 Base URL 与代理接口类型。");
    throw new Error("模型返回了空正文，请重试或检查供应商状态。");
  }
  // 只保存 token 统计，不把供应商任意字段或推理内容写入日志和数据库。
  const rawUsage = record(result.usage), usage: Record<string, number> = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"]) {
    const count = rawUsage?.[key];
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) usage[key] = count;
  }
  return { text, usage: Object.keys(usage).length ? usage : null };
}

export async function requestModel(config: LlmConfig, messages: ModelMessage[], maxTokens: number, timeout: number, mode: Mode) {
  const baseURL = modelBaseUrl(config.baseUrl);
  const hostname = new URL(baseURL).hostname;
  const isDeepSeek = hostname === "api.deepseek.com" || /^deepseek[-/]/i.test(config.model);
  const isReasoning = /^(?:gpt-(?:[5-9]|\d{2,})(?:[.-]|$)|o[1-9](?:-|$))/i.test(config.model);
  const isOpenAI = hostname === "api.openai.com";
  const budget = (isDeepSeek || isReasoning) && mode === "report" ? Math.max(maxTokens, 8192) : isReasoning ? Math.max(maxTokens, 4096) : maxTokens;
  // 推理模型的输出预算也包含思考 token；不传 temperature 等非通用参数。
  const body: ChatCompletionCreateParamsNonStreaming & { thinking?: { type: "enabled" | "disabled" } } = {
    model: config.model, messages: messages as ChatCompletionMessageParam[], stream: false,
    ...(mode === "report" ? { response_format: { type: "json_object" as const } } : {}),
    ...(isOpenAI || isReasoning ? { max_completion_tokens: budget } : { max_tokens: budget }),
    ...(isReasoning && !/-pro(?:-|$)/i.test(config.model) && /^(?:gpt-|o[34])/.test(config.model) ? { reasoning_effort: "low" as const } : {}),
    ...(isDeepSeek && !/deepseek-reasoner$/i.test(config.model) ? { thinking: { type: mode === "report" ? "enabled" : "disabled" }, ...(mode === "report" ? { reasoning_effort: "high" as const } : {}) } : {}),
  };
  const client = new OpenAI({ apiKey: config.apiKey, baseURL, timeout, maxRetries: 0, logLevel: "off" });
  let value: unknown;
  try {
    value = await client.chat.completions.create(body, { signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    if (error instanceof OpenAI.APIConnectionTimeoutError || error instanceof OpenAI.APIUserAbortError || error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw new Error("模型请求超时，请稍后重试。");
    if (error instanceof OpenAI.APIError && error.status) {
      const status = error.status;
      const explanation = status === 402
        ? hostname === "api.deepseek.com"
          ? "DeepSeek API 账户余额不足，请到 API Key 所属账户的开放平台检查余额，充值后重试"
          : "模型供应商返回付款或额度限制，请到 API Key 所属账户的供应商平台检查余额、额度与计费状态"
        : status === 401 || status === 403 ? "API Key 或访问权限不正确"
        : status === 404 ? "请检查 Base URL、模型名称与 Chat Completions 兼容性"
        : status === 429 ? "模型接口限流，请稍后重试"
        : status === 400 ? "模型不支持当前聊天参数，请检查模型的 Chat Completions 兼容性"
        : "模型接口未接受请求";
      throw new Error(`${explanation}（HTTP ${status}）`);
    }
    if (error instanceof SyntaxError) throw new Error("模型接口没有返回有效 JSON，请检查代理接口格式。");
    throw new Error("无法连接模型接口，请检查 Base URL 与服务器网络。");
  }
  if (typeof value === "string") throw new Error("模型接口没有返回 JSON 格式，请使用 Chat Completions 接口前缀。");
  return parseModelResult(value);
}

export function modelBaseUrl(input: string): string {
  const url = new URL(input);
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  if (url.hostname === "api.openai.com" && (!url.pathname || url.pathname === "/")) url.pathname = "/v1";
  return url.toString().replace(/\/+$/, "");
}
