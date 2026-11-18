import { success } from "@/lib/api";
import { db } from "@/lib/db";
import { publicSettings } from "@/lib/settings";
import { currentSymbol } from "@/lib/runtime";

export async function GET() {
  try { await db().$queryRaw`SELECT 1`; await db().dailySignal.findFirst({ select: { runtime: true } }); const settings = await publicSettings(); return success({ database: "connected", model: settings.llm.configured ? "configured" : "unconfigured", monitoring: await currentSymbol(), sampling: "page-request", stateStorage: "postgresql", backgroundTasks: false, bridge: !!process.env.AKTOOLS_BASE_URL }); }
  catch { return success({ database: "unavailable", model: "unknown", error: "数据库未连接，请检查 DATABASE_URL 和迁移。" }, 503); }
}
