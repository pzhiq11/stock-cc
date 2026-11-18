const parts = (date: Date) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date).map(p => [p.type, p.value]));

export function tradeDate(at = Date.now()): string {
  const p = parts(new Date(at));
  return `${p.year}-${p.month}-${p.day}`;
}

export function shanghaiTime(at = Date.now()): string {
  const p = parts(new Date(at));
  return `${p.hour}:${p.minute}:${p.second}`;
}

export function minuteOfDay(at = Date.now()): number {
  const p = parts(new Date(at));
  return Number(p.hour) * 60 + Number(p.minute);
}

export function sourceTimestamp(raw: string | undefined): number | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 14) return null;
  const iso = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}+08:00`;
  const result = Date.parse(iso);
  if (!Number.isFinite(result)) return null;
  const p = parts(new Date(result));
  return `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}` === digits ? result : null;
}

export type Session = "auction" | "preopen" | "morning" | "lunch" | "afternoon" | "closing" | "closed" | "holiday";
export function sessionAt(at = Date.now(), tradingDay = true): Session {
  const day = new Date(`${tradeDate(at)}T12:00:00+08:00`).getUTCDay();
  if (!tradingDay || day === 0 || day === 6) return "holiday";
  const m = minuteOfDay(at);
  if (m >= 555 && m < 565) return "auction";
  if (m >= 565 && m < 570) return "preopen";
  if (m >= 570 && m < 690) return "morning";
  if (m >= 690 && m < 780) return "lunch";
  if (m >= 780 && m < 897) return "afternoon";
  if (m >= 897 && m < 900) return "closing";
  return "closed";
}

export const SESSION_LABELS: Record<Session, string> = { auction: "开盘竞价", preopen: "竞价结束", morning: "上午交易", lunch: "午间休市", afternoon: "下午交易", closing: "收盘竞价", closed: "非交易时段", holiday: "非交易日" };
