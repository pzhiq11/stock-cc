import { success, failure } from "@/lib/api";
import { normalizeSymbol } from "@/lib/market/symbol";
import { signalState } from "@/lib/runtime";
import { tradeDate } from "@/lib/time";
export const maxDuration = 60;

export async function GET(request: Request, { params }: { params: Promise<{ symbol: string }> }) {
  try {
    const date = new URL(request.url).searchParams.get("date") || tradeDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("日期格式不正确。");
    return success(await signalState(normalizeSymbol((await params).symbol), date));
  } catch (e) { return failure(e); }
}
