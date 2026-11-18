import type { Bar, Company, Context, Evidence, Intraday, MinuteBar, MinuteHistory, Quote, StockRef } from "@/lib/types";
import { sourceTimestamp, tradeDate } from "@/lib/time";
import { cached, json, numeric, optionalNumber, remote } from "./http";
import { isEquity, normalizeSymbol, providerSymbol, ref } from "./symbol";

export function parseQuotes(text: string, observedAt = Date.now()): Quote[] {
  const result: Quote[] = [];
  for (const match of text.matchAll(/v_([a-z]{2})(\d{6})="([^"]*)"/g)) {
    const f = match[3].split("~");
    if (f.length < 35 || numeric(f[3]) <= 0) continue;
    const symbol = `${match[2]}.${match[1].toUpperCase()}`;
    const amount = optionalNumber(f[35]?.split("/")[2]) ?? numeric(f[37]) * 10000;
    result.push({
      ...ref(symbol, f[1]), price: numeric(f[3]), previousClose: numeric(f[4]), open: numeric(f[5]),
      high: numeric(f[33]), low: numeric(f[34]), change: numeric(f[31]), changePercent: numeric(f[32]),
      volume: numeric(f[6]) * 100, amount, sourceAt: sourceTimestamp(f[30]), observedAt, provider: "腾讯公开行情",
      bid: optionalNumber(f[9]), ask: optionalNumber(f[19]), bidSize: optionalNumber(f[10]) === null ? null : numeric(f[10]) * 100,
      askSize: optionalNumber(f[20]) === null ? null : numeric(f[20]) * 100,
      turnover: optionalNumber(f[38]), pe: optionalNumber(f[39]), pb: optionalNumber(f[46]),
      marketCap: optionalNumber(f[45]) === null ? null : numeric(f[45]) * 1e8,
      circulatingCap: optionalNumber(f[44]) === null ? null : numeric(f[44]) * 1e8,
    });
  }
  return result;
}

export async function getQuotes(symbols: string[]): Promise<Quote[]> {
  if (!symbols.length) return [];
  const normalized = [...new Set(symbols.map(normalizeSymbol))].sort();
  return cached(`quote:${normalized.join(",")}`, 500, async () => {
    const text = await remote(`https://qt.gtimg.cn/q=${normalized.map(providerSymbol).join(",")}`, "gb18030");
    const results = parseQuotes(text);
    if (!results.length) throw new Error("未取得有效行情，接口可能暂不可用。");
    return results;
  });
}

export async function getQuote(symbol: string): Promise<Quote> {
  const s = normalizeSymbol(symbol);
  const quote = (await getQuotes([s])).find(q => q.symbol === s);
  if (!quote) throw new Error("股票暂无有效报价，可能已停牌或数据源未覆盖。");
  return quote;
}

export async function searchStocks(query: string): Promise<StockRef[]> {
  const q = query.trim();
  if (!q || q.length > 60) return [];
  if (/^(?:[a-z]{2})?\d{6}(?:\.[a-z]{2})?$/i.test(q)) {
    const symbol = normalizeSymbol(q);
    if (!isEquity(symbol)) return [];
    try { const quote = await getQuote(symbol); return [ref(symbol, quote.name)]; } catch { return []; }
  }
  return cached(`search:${q}`, 60000, async () => {
    const text = await remote(`https://smartbox.gtimg.cn/s3/?q=${encodeURIComponent(q)}&t=all`, "gb18030");
    const match = text.match(/v_hint=(".*")/);
    if (!match) return [];
    const decoded: string = JSON.parse(match[1]);
    return decoded.split("^").flatMap(row => {
      const [exchange, code, name, initials, kind] = row.split("~");
      if (!code || !["sh", "sz", "bj"].includes(exchange) || kind !== "GP-A") return [];
      const symbol = `${code}.${exchange.toUpperCase()}`;
      return isEquity(symbol) ? [{ ...ref(symbol, name), initials }] : [];
    }).slice(0, 12);
  });
}

type TencentData = { code: number; data: Record<string, { data?: { data?: string[]; date?: string }; qfqday?: string[][]; day?: string[][]; qt?: Record<string, unknown> }> };
export async function getIntraday(symbol: string): Promise<Intraday> {
  const s = providerSymbol(symbol);
  return cached(`minute:${s}`, 5000, async () => {
    try {
      const history = await getMinuteHistory(symbol);
      return minuteCloseIntraday(history);
    } catch { /* 分钟OHLC不可用时保留腾讯分时展示，点位引擎仍暂停回放。 */ }
    const data = await json<TencentData>(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${s}`);
    const content = data.data?.[s]?.data;
    if (data.code !== 0 || !content?.data?.length) throw new Error("分时数据暂不可用。");
    let lastVolume = 0;
    const points = content.data.flatMap(row => {
      const [time, p, v, a] = row.split(" ");
      const price = numeric(p), cumulative = numeric(v) * 100;
      if (!/^\d{4}$/.test(time) || price <= 0) return [];
      const minute = Number(time.slice(0, 2)) * 60 + Number(time.slice(2));
      if (!(minute >= 570 && minute <= 690 || minute >= 780 && minute <= 900)) return [];
      const volume = Math.max(0, cumulative - lastVolume);
      lastVolume = cumulative;
      return [{ time: `${time.slice(0, 2)}:${time.slice(2)}`, price, volume, average: cumulative > 0 && numeric(a) > 0 ? numeric(a) / cumulative : null }];
    });
    const date = content.date?.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3") || tradeDate();
    return { date, points, provider: "腾讯公开分时（分钟采样）", fetchedAt: Date.now(), complete: points.at(-1)?.time === "15:00" };
  });
}

export function minuteCloseIntraday(history: MinuteHistory, cutoff = Date.now()): Intraday {
  const known = history.bars.filter(b => b.completedAt <= cutoff);
  const date = known.at(-1)?.time.slice(0, 10);
  if (!date) throw new Error("尚无已完成分钟数据。");
  const bars = known.filter(b => b.time.startsWith(date));
  // 与因果引擎使用相同数据和保守完成时刻，不把点位回画到原始标签或分钟内部极值。
  const points = bars.map(b => ({ time: new Date(b.completedAt + 8 * 3600000).toISOString().slice(11, 16), sourceTime: b.time.slice(11), price: b.close, volume: b.volume, average: b.average }));
  return { date, points, provider: "东方财富分钟收盘 · 与点位完成时刻一致", fetchedAt: history.fetchedAt, complete: bars.at(-1)?.time.endsWith("15:00") ?? false };
}

export async function getDaily(symbol: string): Promise<Bar[]> {
  const s = providerSymbol(symbol);
  return cached(`daily:${s}`, 60000, async () => {
    const data = await json<TencentData>(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${s},day,,,180,qfq`);
    const rows = data.data?.[s]?.qfqday ?? data.data?.[s]?.day;
    if (data.code !== 0 || !rows?.length) throw new Error("日 K 数据暂不可用。");
    return rows.map(row => ({ time: row[0], open: numeric(row[1]), close: numeric(row[2]), high: numeric(row[3]), low: numeric(row[4]), volume: numeric(row[5]) * 100 })).filter(b => b.close > 0);
  });
}

export function parseMinuteBars(value: unknown): MinuteBar[] {
  if (!Array.isArray(value)) return [];
  const bars: MinuteBar[] = [];
  const seen = new Set<number>();
  for (const row of value) {
    if (typeof row !== "string") continue;
    const [time, o, c, h, l, v, a, avg] = row.split(",");
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(time)) continue;
    const at = Date.parse(`${time.replace(" ", "T")}:00+08:00`);
    const [open, close, high, low, lots, amount] = [o, c, h, l, v, a].map(x => optionalNumber(x));
    if (!Number.isFinite(at) || close === null || high === null || low === null || lots === null || amount === null || close <= 0 || low <= 0 || high < low || close > high + .001 || close < low - .001 || lots < 0 || amount < 0 || seen.has(at)) continue;
    if (open !== null && open > 0 && (open > high + .001 || open < low - .001)) continue;
    seen.add(at);
    // 未取得分钟起止与实际到达保证，保守等待标签后一分钟；曲线使用同一完成时刻。
    // 历史接口的 open=0 表示缺失，不能伪造开盘价或据此识别蜡烛形态。
    bars.push({ time, at, completedAt: at + 60000, open: open !== null && open > 0 ? open : null, close, high, low, volume: lots * 100, amount, average: optionalNumber(avg) });
  }
  return bars.sort((a, b) => a.at - b.at);
}

export async function getMinuteHistory(symbol: string): Promise<MinuteHistory> {
  const normalized = normalizeSymbol(symbol);
  return cached(`ohlc:${normalized}`, 5000, async () => {
    const [code, exchange] = normalized.split(".");
    if (exchange === "BJ") throw new Error("当前分钟回放数据源尚未覆盖北交所。");
    const secid = `${exchange === "SH" ? 1 : 0}.${code}`;
    const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0&ndays=5`;
    const data = await json<{ rc: number; data?: { code?: string; trends?: unknown } }>(url);
    if (data.rc !== 0 || data.data?.code !== code) throw new Error("分钟 K 线接口未返回匹配股票的有效数据。");
    const bars = parseMinuteBars(data.data.trends);
    if (!bars.length) throw new Error("未取得有效分钟 OHLC，暂停因果回放；不使用分时价格伪造 K 线。");
    return { bars, provider: "东方财富公开分钟 OHLC（最多五交易日）", fetchedAt: Date.now(), missing: ["历史秒级盘口与实际到达延迟无法恢复", ...(bars.some(b => b.open === null) ? ["部分历史分钟开盘价缺失，仅用于不依赖开盘价的指标"] : [])] };
  });
}

export async function akShareRecords(name: string, args: Record<string, string> = {}): Promise<Record<string, unknown>[]> {
  if (!process.env.AKTOOLS_BASE_URL) throw new Error("未配置 AKTools 数据接口。");
  const url = new URL(`/api/public/${name}`, process.env.AKTOOLS_BASE_URL);
  for (const [k, v] of Object.entries(args)) url.searchParams.set(k, v);
  const response = await json<unknown>(url.toString());
  if (Array.isArray(response)) return response as Record<string, unknown>[];
  if (response && typeof response === "object" && "data" in response && Array.isArray(response.data)) return response.data as Record<string, unknown>[];
  throw new Error("AKTools 返回格式与预期不一致。");
}

export async function getCompany(symbol: string): Promise<Company> {
  const s = normalizeSymbol(symbol);
  return cached(`company:${s}`, 6 * 3600000, async () => {
    const url = `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=${providerSymbol(s).toUpperCase()}`;
    const data = await json<{ jbzl?: Record<string, unknown>[]; fxxg?: Record<string, unknown>[] }>(url);
    const basic = data.jbzl?.[0];
    if (!basic) throw new Error("公司资料暂无有效返回。");
    const string = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : null;
    let industry = string(basic.EM2016);
    if (process.env.AKTOOLS_BASE_URL) {
      try {
        const records = await akShareRecords("stock_individual_info_em", { symbol: s.split(".")[0] });
        const found = records.find(r => r.item === "行业");
        industry = string(found?.value) ?? industry;
      } catch { /* 基础资料仍使用已取得的公开来源。 */ }
    }
    return {
      name: string(basic.ORG_NAME) || string(basic.SECURITY_NAME_ABBR) || s,
      introduction: string(basic.ORG_PROFILE), business: string(basic.MAIN_BUSINESS) || string(basic.BUSINESS_SCOPE),
      industry, listedAt: string(data.fxxg?.[0]?.LISTING_DATE)?.slice(0, 10) ?? null,
      website: string(basic.ORG_WEB), region: string(basic.PROVINCE),
      provider: "东方财富公司资料", fetchedAt: new Date().toISOString(), url: `https://data.eastmoney.com/stockdata/${s.split(".")[0]}.html`,
    };
  });
}

export async function getNews(symbol: string): Promise<Evidence[]> {
  const code = normalizeSymbol(symbol).split(".")[0];
  return cached(`news:${code}`, 300000, async () => {
    const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=8&page_index=1&ann_type=A&client_source=web&stock_list=${code}`;
    const data = await json<{ data?: { list?: Record<string, unknown>[] } }>(url);
    return (data.data?.list ?? []).map((r, i) => ({
      id: `notice-${i}`, title: String(r.title || "公司公告"),
      url: `https://data.eastmoney.com/notices/detail/${code}/${String(r.art_code)}.html`,
      publishedAt: typeof r.notice_date === "string" ? r.notice_date.slice(0, 10) : null,
      fetchedAt: new Date().toISOString(), summary: String(r.title || "仅取得公告标题，未读取公告全文。"), publisher: "东方财富公告索引",
    }));
  });
}

export async function getContext(symbol: string): Promise<Context> {
  const [indices, company] = await Promise.allSettled([getQuotes(["000001.SH", "399001.SZ", "399006.SZ"]), getCompany(symbol)]);
  const missing: string[] = [];
  if (indices.status === "rejected") missing.push("指数行情暂不可用");
  let industry: Context["industry"] = company.status === "fulfilled" && company.value.industry ? { name: company.value.industry, changePercent: null, sourceAt: null } : null;
  if (industry && process.env.AKTOOLS_BASE_URL) {
    try {
      const list = await cached("industry-list", 20000, () => akShareRecords("stock_board_industry_name_em"));
      const row = list.find(r => typeof r["板块名称"] === "string" && industry!.name.includes(String(r["板块名称"])));
      if (row) industry = { name: String(row["板块名称"]), changePercent: optionalNumber(row["涨跌幅"]), sourceAt: null };
    } catch { missing.push("板块行情暂不可用"); }
  }
  if (!industry || industry.sourceAt === null) missing.push("板块实时因子时间尚未核验，未参与正式点位确认");
  return { indices: indices.status === "fulfilled" ? indices.value : [], industry, missing };
}
