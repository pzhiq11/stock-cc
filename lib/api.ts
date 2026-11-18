import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function success(data: unknown, status = 200) { return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } }); }
export function failure(error: unknown, status = 400) {
  const name = error instanceof Error ? error.constructor.name : "";
  const message = error instanceof ZodError ? "请求参数不正确，请检查输入。" : name.startsWith("Prisma") ? "数据库连接或写入失败，请检查当前环境数据库与迁移。" : error instanceof TypeError ? "数据接口暂不可用，请稍后重试。" : error instanceof Error ? error.message.slice(0, 350) : "请求未完成，请稍后重试。";
  return success({ error: message }, status);
}
export async function body(request: Request): Promise<unknown> {
  const origin = request.headers.get("origin");
  // Next 在内部可能将 request.url 重建为 localhost；Host 对应浏览器实际访问的入口。
  if (origin) { let source: URL; try { source = new URL(origin); } catch { throw new Error("请求来源无效。"); } const host = request.headers.get("host") || new URL(request.url).host; if (!["http:", "https:"].includes(source.protocol) || source.host !== host) throw new Error("不允许来自其他网站的写入请求。"); }
  const text = await request.text();
  if (text.length > 30000) throw new Error("请求内容过大。");
  return JSON.parse(text || "{}");
}
