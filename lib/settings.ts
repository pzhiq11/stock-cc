import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

type Cipher = { iv: string; tag: string; text: string; keySource?: "environment" | "project" | "local" };
export type LlmOverride = { enabled?: boolean; baseUrl?: string; model?: string; secret?: Cipher; testedAt?: string };
export type LlmConfig = { baseUrl: string; model: string; apiKey: string; source: "界面配置" | "环境变量" };

// 固定项目默认密钥，跨实例和重部署一致；有环境变量时优先用于新配置。
const PROJECT_ENCRYPTION_KEY = createHash("sha256").update("stocklens/config-encryption/default/v1").digest();

function encryptionKey(source: "environment" | "project" | "local"): Buffer {
  if (source === "project") return PROJECT_ENCRYPTION_KEY;
  if (source === "local") throw new Error("旧模型配置使用已移除的本地文件密钥，请重新填写 API Key 后保存，或先迁移原配置。");
  const configured = process.env.CONFIG_ENCRYPTION_KEY?.trim() || "";
  const key = Buffer.from(configured, "base64");
  if (key.length !== 32 || key.toString("base64") !== configured) throw new Error("CONFIG_ENCRYPTION_KEY 必须是 Base64 编码的 32 字节密钥；已保存的环境密钥配置需保留原值，或重新填写 API Key 后保存。");
  return key;
}

export function encryptKey(text: string): Cipher {
  const keySource = process.env.CONFIG_ENCRYPTION_KEY?.trim() ? "environment" : "project";
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(keySource), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), text: encrypted.toString("base64"), keySource };
}
export function decryptKey(secret: Cipher): string {
  const key = encryptionKey(secret.keySource ?? "environment");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(secret.iv, "base64"));
    decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(secret.text, "base64")), decipher.final()]).toString("utf8");
  } catch { throw new Error("已保存的模型密钥无法解密，请恢复加密密钥备份，或重新填写 API Key 后保存。"); }
}

export async function appSettings() {
  return db().appSetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
}

export function validateModelUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("模型 Base URL 格式不正确。"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Base URL 只支持不包含账号、参数的 HTTP / HTTPS 地址。");
  if (/^(169\.254\.|0\.0\.0\.0|::|metadata\.)/.test(url.hostname) || url.hostname.endsWith(".internal")) throw new Error("不允许访问元数据或特殊内部地址。");
  return url.toString().replace(/\/$/, "");
}

export async function resolveLlm(): Promise<LlmConfig | null> {
  const setting = await appSettings();
  const cfg = setting.llm as LlmOverride;
  if (cfg.baseUrl && cfg.model && cfg.secret) return { baseUrl: validateModelUrl(cfg.baseUrl), model: cfg.model, apiKey: decryptKey(cfg.secret), source: "界面配置" };
  if (process.env.LLM_BASE_URL && process.env.LLM_MODEL && process.env.LLM_API_KEY) return { baseUrl: validateModelUrl(process.env.LLM_BASE_URL), model: process.env.LLM_MODEL, apiKey: process.env.LLM_API_KEY, source: "环境变量" };
  return null;
}

export async function publicSettings() {
  const setting = await appSettings();
  const cfg = setting.llm as LlmOverride;
  let active: LlmConfig | null = null, error: string | null = null;
  try { active = await resolveLlm(); } catch (e) { error = e instanceof Error ? e.message : "模型配置读取失败"; }
  return { lastStock: setting.lastStock, prefs: setting.prefs, llm: { baseUrl: cfg.baseUrl || process.env.LLM_BASE_URL || "", model: cfg.model || process.env.LLM_MODEL || "", hasKey: !!cfg.secret || !!process.env.LLM_API_KEY, source: active?.source ?? "尚未配置", configured: !!active, testedAt: cfg.testedAt ?? null, error } };
}

export async function configFromInput(input: { baseUrl: string; model: string; apiKey?: string }): Promise<LlmConfig> {
  const current = await appSettings();
  const cfg = current.llm as LlmOverride;
  const apiKey = input.apiKey || (cfg.secret ? decryptKey(cfg.secret) : process.env.LLM_API_KEY) || "";
  if (!input.model.trim() || !apiKey.trim()) throw new Error("请填写模型名称和 API Key。");
  return { baseUrl: validateModelUrl(input.baseUrl.trim()), model: input.model.trim(), apiKey, source: "界面配置" };
}

export async function saveModel(config: LlmConfig) {
  const llm: LlmOverride = { baseUrl: config.baseUrl, model: config.model, secret: encryptKey(config.apiKey), testedAt: new Date().toISOString() };
  await appSettings();
  await db().appSetting.update({ where: { id: 1 }, data: { llm: JSON.parse(JSON.stringify(llm)) as Prisma.InputJsonValue } });
}
