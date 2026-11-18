export function price(value: number | null | undefined): string { return value !== null && value !== undefined && Number.isFinite(value) ? value.toFixed(2) : "—"; }
export function percent(value: number | null | undefined): string { return value !== null && value !== undefined && Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(2)}%` : "—"; }
export function compact(value: number | null | undefined, unit = ""): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(2)}亿${unit}`;
  if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(2)}万${unit}`;
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${unit}`;
}
export function time(at: number | string | null | undefined, seconds = false): string {
  if (!at) return "—";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hourCycle: "h23" }).format(new Date(at));
}
export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求未完成。");
  return data as T;
}
