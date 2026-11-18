import { z } from "zod";
import { db } from "@/lib/db";
import { body, success, failure } from "@/lib/api";
import { getQuote, getQuotes } from "@/lib/market/provider";
import { normalizeSymbol, isEquity } from "@/lib/market/symbol";
import { currentSymbol } from "@/lib/runtime";
import { calendar } from "@/lib/market/calendar";

export async function GET() {
  try {
    const stocks = await db().watchlist.findMany({ orderBy: { sort: "asc" } });
    let quotes: Awaited<ReturnType<typeof getQuotes>> = [], sourceError: string | null = null;
    try { quotes = await getQuotes(stocks.map(s => s.symbol)); } catch { sourceError = "列表行情暂不可用"; }
    return success({ stocks, quotes, current: await currentSymbol(), sourceError, calendar: await calendar() });
  } catch (e) { return failure(e); }
}
export async function PUT(request: Request) {
  try {
    const input = z.object({ action: z.enum(["add", "remove", "reorder"]), symbol: z.string().optional(), name: z.string().max(40).optional(), symbols: z.array(z.string()).max(20).optional() }).parse(await body(request));
    if (input.action === "reorder") {
      const symbols = input.symbols?.map(normalizeSymbol) ?? [];
      const current = await db().watchlist.findMany();
      if (symbols.length !== current.length || new Set(symbols).size !== symbols.length || symbols.some(s => !current.some(c => c.symbol === s))) throw new Error("排序与现有列表不一致。");
      await db().$transaction(symbols.map((symbol, sort) => db().watchlist.update({ where: { symbol }, data: { sort } })));
    } else {
      if (!input.symbol) throw new Error("缺少股票代码。");
      const symbol = normalizeSymbol(input.symbol);
      if (!isEquity(symbol)) throw new Error("仅支持 A 股股票。");
      if (input.action === "remove") await db().watchlist.deleteMany({ where: { symbol } });
      else {
        const count = await db().watchlist.count();
        if (count >= 20 && !await db().watchlist.findUnique({ where: { symbol } })) throw new Error("首版常看列表最多 20 只股票。");
        const name = input.name || (await getQuote(symbol)).name;
        await db().watchlist.upsert({ where: { symbol }, update: {}, create: { symbol, name, sort: count } });
      }
    }
    return success({ ok: true });
  } catch (e) { return failure(e); }
}
