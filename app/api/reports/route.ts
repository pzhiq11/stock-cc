import { z } from "zod";
import { body, success, failure } from "@/lib/api";
import { db } from "@/lib/db";
import { REPORT_TYPES } from "@/lib/types";
import { generateReport, ReportBusyError, reportsGenerating, serializeReport } from "@/lib/analysis/reports";
import { normalizeSymbol } from "@/lib/market/symbol";

export const maxDuration = 180;
export async function GET(request: Request) {
  try {
    const p = new URL(request.url).searchParams;
    const rows = await db().analysisReport.findMany({ where: { ...(p.get("symbol") ? { symbol: normalizeSymbol(p.get("symbol")!) } : {}), ...(p.get("type") && REPORT_TYPES.includes(p.get("type") as typeof REPORT_TYPES[number]) ? { type: p.get("type")! } : {}), ...(p.get("date") ? { tradeDate: p.get("date")! } : {}) }, orderBy: { createdAt: "desc" }, take: 50 });
    return success({ reports: rows.map(serializeReport), generating: await reportsGenerating(p.get("symbol") ? normalizeSymbol(p.get("symbol")!) : undefined, p.get("date") || undefined) });
  } catch (e) { return failure(e); }
}
export async function POST(request: Request) {
  try {
    const input = z.object({ symbol: z.string(), type: z.enum(REPORT_TYPES), force: z.boolean().optional(), requestId: z.string().uuid().optional() }).parse(await body(request));
    const symbol = normalizeSymbol(input.symbol);
    return success(await generateReport(symbol, input.type, { force: input.force, requestId: input.requestId }));
  } catch (e) { return e instanceof ReportBusyError ? success({ generating: true, message: e.message }, 202) : failure(e); }
}
