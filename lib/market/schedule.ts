import { sessionAt, tradeDate } from "@/lib/time";

export type MarketCalendar = { date: string; isTradingDay: boolean | null; next: string | null; provider: string };

// 已核验的官方年度日历，客户端与服务端使用同一份休市规则。
// https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml
const holidays2026 = [["2026-01-01", "2026-01-03"], ["2026-02-15", "2026-02-23"], ["2026-04-04", "2026-04-06"], ["2026-05-01", "2026-05-05"], ["2026-06-19", "2026-06-21"], ["2026-09-25", "2026-09-27"], ["2026-10-01", "2026-10-07"]];

export function officialTradingDay(date: string): boolean | null {
  if (!/^2026-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T12:00:00+08:00`);
  if (!Number.isFinite(parsed.getTime()) || tradeDate(parsed.getTime()) !== date) return null;
  const day = parsed.getUTCDay();
  if (day === 0 || day === 6) return false;
  return !holidays2026.some(([from, to]) => date >= from && date <= to);
}

function tradingDay(date: string, calendar?: MarketCalendar | null) {
  if (calendar?.date === date) return calendar.isTradingDay;
  if (calendar?.next === date) return true;
  return officialTradingDay(date);
}

export function marketPollingActive(at = Date.now(), calendar?: MarketCalendar | null): boolean {
  return ["auction", "preopen", "morning", "afternoon", "closing"].includes(sessionAt(at, tradingDay(tradeDate(at), calendar) === true));
}

/** 返回下一次实际请求时间；休市等待由本地定时器完成，不请求接口确认时间。 */
export function nextMarketPoll(at: number, interval: number, calendar?: MarketCalendar | null, reports = false, generating = false): number {
  if (marketPollingActive(at, calendar) || reports && generating) return at + interval;
  const today = tradeDate(at), day = new Date(`${today}T12:00:00+08:00`);
  for (let i = 0; i < 370; i++) {
    const date = tradeDate(day.getTime()), trading = tradingDay(date, calendar);
    if (trading === true) {
      // 边界后补取一次最终分钟；盘后报告只额外检查生成状态。
      const times = ["09:15:00", "11:31:00", "13:00:00", "15:01:00", ...(reports ? ["15:10:35"] : [])];
      const next = times.map(time => Date.parse(`${date}T${time}+08:00`)).find(time => time > at);
      if (next) return next;
    } else if (trading === null) {
      // 未知年度每天开市前按需核验一次，不能假设未知日期可交易。
      const check = Date.parse(`${date}T09:15:00+08:00`);
      if (check > at) return check;
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return at + 86400000;
}
