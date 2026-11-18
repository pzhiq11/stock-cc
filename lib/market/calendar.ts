import { tradeDate } from "@/lib/time";
import { akShareRecords } from "./provider";
import { cached } from "./http";
import { officialTradingDay, type MarketCalendar } from "./schedule";
export { officialTradingDay } from "./schedule";

export async function calendar(date = tradeDate()): Promise<MarketCalendar> {
  // 包含降级结果的日期缓存，扩展服务离线时也不会在每次报价循环重试。
  return cached(`trading-day:${date}`, 86400000, () => loadCalendar(date));
}

async function loadCalendar(date: string): Promise<MarketCalendar> {
  if (process.env.AKTOOLS_BASE_URL) {
    try {
      const rows = await cached("calendar", 86400000, () => akShareRecords("tool_trade_date_hist_sina"));
      const dates = rows.map(r => String(r.trade_date ?? r["交易日"] ?? "").slice(0, 10)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
      if (dates.length && date >= dates[0] && date <= dates.at(-1)!) return { date, isTradingDay: dates.includes(date), next: dates.find(d => d > date) ?? null, provider: "AKShare 交易日历" };
    } catch { /* 使用已核验的官方年度日历。 */ }
  }
  const known = officialTradingDay(date);
  let next: string | null = null;
  const d = new Date(`${date}T12:00:00+08:00`);
  if (known !== null) for (let i = 0; i < 20; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const candidate = tradeDate(d.getTime());
    if (officialTradingDay(candidate) === true) { next = candidate; break; }
    if (officialTradingDay(candidate) === null) break;
  }
  return { date, isTradingDay: known, next, provider: known === null ? "当前年份日历未核验" : "上交所 2026 年官方休市日历" };
}
