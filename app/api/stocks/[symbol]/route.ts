import { success, failure } from "@/lib/api";
import { getCompany, getContext, getDaily, getIntraday, getNews, getQuote } from "@/lib/market/provider";
import { calendar } from "@/lib/market/calendar";
import { isEquity, normalizeSymbol } from "@/lib/market/symbol";
import { currentQuote } from "@/lib/runtime";
import { sessionAt } from "@/lib/time";

export async function GET(request: Request, { params }: { params: Promise<{ symbol: string }> }) {
  try {
    const symbol = normalizeSymbol((await params).symbol);
    if (!isEquity(symbol)) throw new Error("仅支持 A 股股票。");
    const view = new URL(request.url).searchParams.get("view") || "quote";
    if (view === "quote") {
      const cached = await currentQuote(symbol);
      const [quote, dates] = await Promise.all([cached && Date.now() - cached.observedAt < 5000 ? Promise.resolve(cached) : getQuote(symbol), calendar()]);
      return success({ quote, calendar: dates, session: sessionAt(Date.now(), dates.isTradingDay === true) });
    }
    if (view === "intraday") return success(await getIntraday(symbol));
    if (view === "daily") return success({ bars: await getDaily(symbol), adjustment: "前复权", provider: "腾讯公开日 K" });
    if (view === "context") return success(await getContext(symbol));
    if (view === "company") {
      const [company, news] = await Promise.allSettled([getCompany(symbol), getNews(symbol)]);
      return success({ company: company.status === "fulfilled" ? company.value : null, news: news.status === "fulfilled" ? news.value : [], missing: [company.status === "rejected" ? "公司资料暂不可用" : null, news.status === "rejected" ? "公开公告暂不可用" : null].filter(Boolean) });
    }
    throw new Error("不支持的数据类型。");
  } catch (e) { return failure(e); }
}
