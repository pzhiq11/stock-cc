import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { dailyRecord } from "@/lib/analysis/store";
import { minuteOfDay, tradeDate } from "@/lib/time";
import type { AuctionInstrument, AuctionSnapshot, SignalState } from "@/lib/types";
import { cached, json, optionalNumber } from "./http";
import { getCompany, parseMinuteBars } from "./provider";
import { normalizeSymbol } from "./symbol";

type AuctionResponse = { rc: number; data?: { code?: string; name?: string; preClose?: unknown; trends?: unknown } };
const preopenEnd = (date: string) => Date.parse(`${date}T09:30:00+08:00`);

export function parseAuctionInstrument(data: AuctionResponse, symbol: string, date: string, availableBefore = Date.now()): AuctionInstrument {
  const code = symbol.split(".")[0];
  if (data.rc !== 0 || data.data?.code !== code) throw new Error("竞价历史接口未返回匹配证券的数据。");
  // 与 AKShare stock_zh_a_hist_pre_min_em 同源。只用开盘前标签，并保守按标签后一分钟可用。
  const cutoff = Math.min(availableBefore, preopenEnd(date));
  const bars = parseMinuteBars(data.data.trends).filter(b => b.time.startsWith(date) && minuteOfDay(b.at) >= 555 && minuteOfDay(b.at) < 570 && b.completedAt <= cutoff);
  const last = bars.at(-1);
  const matched = bars.filter(b => minuteOfDay(b.at) >= 565 && b.volume > 0 && b.amount > 0);
  if (!last || !matched.length) throw new Error("尚未取得今日已撮合的竞价历史结果；不使用开盘后的价格替代，请在数据可用后重试。");
  const previousClose = optionalNumber(data.data.preClose);
  return {
    symbol, name: data.data.name || symbol, price: last.close,
    previousClose: previousClose !== null && previousClose > 0 ? previousClose : null,
    volume: matched.reduce((sum, b) => sum + b.volume, 0), amount: matched.reduce((sum, b) => sum + b.amount, 0),
    sourceAt: last.at, availableAt: last.completedAt,
    samples: bars.map(b => ({ at: b.at, availableAt: b.completedAt, price: b.close, volume: b.volume, amount: b.amount })),
  };
}

export function validAuctionSnapshot(value: unknown, symbol: string, date: string): value is AuctionSnapshot {
  const snapshot = value as AuctionSnapshot | null;
  if (!snapshot || snapshot.version !== 1 || snapshot.symbol !== symbol || snapshot.tradeDate !== date || !Number.isFinite(snapshot.cutoffAt) || !Number.isFinite(snapshot.capturedAt) || snapshot.capturedAt < snapshot.cutoffAt || snapshot.capturedAt > Date.now() || snapshot.cutoffAt > preopenEnd(date) || snapshot.cutoffAt > Date.now() || !Array.isArray(snapshot.indices) || !Array.isArray(snapshot.missing)) return false;
  const valid = (q: AuctionInstrument) => {
    if (!q || !Array.isArray(q.samples) || !q.samples.length || !Number.isFinite(q.price) || q.price <= 0 || !Number.isFinite(q.sourceAt) || !Number.isFinite(q.availableAt) || !Number.isFinite(q.volume) || q.volume <= 0 || !Number.isFinite(q.amount) || q.amount <= 0 || tradeDate(q.sourceAt) !== date || minuteOfDay(q.sourceAt) < 565 || minuteOfDay(q.sourceAt) >= 570 || q.availableAt > snapshot.cutoffAt) return false;
    const last = q.samples.at(-1)!;
    return last.at === q.sourceAt && last.availableAt === q.availableAt && last.price === q.price && q.samples.every(s => Number.isFinite(s.at) && Number.isFinite(s.availableAt) && Number.isFinite(s.price) && s.price > 0 && tradeDate(s.at) === date && minuteOfDay(s.at) >= 555 && minuteOfDay(s.at) < 570 && s.availableAt >= s.at + 60000 && s.availableAt <= snapshot.cutoffAt);
  };
  return snapshot.stock?.symbol === symbol && valid(snapshot.stock) && snapshot.indices.every(valid) && (!snapshot.industry || valid(snapshot.industry.quote));
}

async function loadInstrument(secid: string, symbol: string, date: string, cutoff = Date.now()) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=1&ndays=1`;
  return parseAuctionInstrument(await json<AuctionResponse>(url), symbol, date, cutoff);
}

async function relatedIndustry(symbol: string): Promise<{ code: string; name: string } | null> {
  const company = await getCompany(symbol);
  if (!company.industry) return null;
  const rows = await cached("auction-industry-names", 6 * 3600000, async () => {
    const data = await json<{ rc: number; data?: { diff?: { f12?: string; f14?: string }[] | Record<string, { f12?: string; f14?: string }> } }>("https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=500&po=1&np=1&fltt=2&invt=2&fs=m:90+t:2&fields=f12,f14");
    if (data.rc !== 0) throw new Error("行业板块目录暂不可用。");
    return Object.values(data.data?.diff ?? {}).filter(r => /^BK\d+$/.test(r.f12 ?? "") && r.f14);
  });
  const row = rows.filter(r => company.industry!.includes(r.f14!)).sort((a, b) => b.f14!.length - a.f14!.length)[0];
  return row ? { code: row.f12!, name: row.f14! } : null;
}

export async function getAuctionSnapshot(symbol: string, date = tradeDate()): Promise<AuctionSnapshot> {
  const s = normalizeSymbol(symbol);
  const row = await db().dailySignal.findUnique({ where: { symbol_tradeDate: { symbol: s, tradeDate: date } } });
  const saved = (row?.coverage as SignalState["coverage"] | undefined)?.auction;
  if (validAuctionSnapshot(saved, s, date)) return saved;
  return cached(`auction-snapshot:${s}:${date}`, 86400000, async () => {
    const [code, exchange] = s.split(".");
    if (exchange === "BJ") throw new Error("当前历史竞价数据源尚未覆盖北交所。");
    const stock = await loadInstrument(`${exchange === "SH" ? 1 : 0}.${code}`, s, date);
    const cutoffAt = stock.availableAt;
    const results = await Promise.allSettled([
      loadInstrument("1.000001", "000001.SH", date, cutoffAt),
      loadInstrument("0.399001", "399001.SZ", date, cutoffAt),
      loadInstrument("0.399006", "399006.SZ", date, cutoffAt),
      relatedIndustry(s).then(async industry => industry ? { ...industry, quote: await loadInstrument(`90.${industry.code}`, industry.code, date, cutoffAt) } : null),
    ]);
    const indices = results.slice(0, 3).flatMap(r => r.status === "fulfilled" ? [r.value as AuctionInstrument] : []);
    const sector = results[3];
    const industry = sector.status === "fulfilled" ? sector.value as AuctionSnapshot["industry"] : null;
    const snapshot: AuctionSnapshot = {
      version: 1, symbol: s, tradeDate: date, stock, indices, industry, cutoffAt, capturedAt: Date.now(),
      missing: ["分钟级竞价历史，不包含逐笔委托、撤单和未匹配量", ...(stock.previousClose === null ? ["竞价昨收参考价缺失"] : []), ...(indices.length < 3 ? ["部分指数的竞价历史缺失，未使用盘中指数替代"] : []), ...(!industry ? ["相关行业板块的竞价历史缺失，未使用盘中板块行情替代"] : [])],
    };
    if (!validAuctionSnapshot(snapshot, s, date)) throw new Error("竞价快照时间校验未通过，暂不生成研判。");
    await dailyRecord(s, date);
    // 存在原有 DailySignal JSON 中，首次有效快照冻结，重启后也可重复研判。
    return db().$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "DailySignal" WHERE symbol = ${s} AND "tradeDate" = ${date} FOR UPDATE`;
      const fresh = await tx.dailySignal.findUniqueOrThrow({ where: { symbol_tradeDate: { symbol: s, tradeDate: date } } });
      const coverage = fresh.coverage as SignalState["coverage"];
      if (validAuctionSnapshot(coverage.auction, s, date)) return coverage.auction;
      await tx.dailySignal.update({ where: { id: fresh.id }, data: { coverage: JSON.parse(JSON.stringify({ ...coverage, auction: snapshot })) as Prisma.InputJsonValue } });
      return snapshot;
    });
  });
}
