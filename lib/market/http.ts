type Entry<T> = { expires: number; value: Promise<T>; failures: number };
const globalCache = globalThis as unknown as { stocklensCache?: Map<string, Entry<unknown>> };
const cache = globalCache.stocklensCache ??= new Map();

export async function cached<T>(key: string, ttl: number, work: () => Promise<T>): Promise<T> {
  const old = cache.get(key);
  if (old && old.expires > Date.now()) return old.value as Promise<T>;
  const value = work();
  const entry: Entry<T> = { expires: Infinity, value, failures: old?.failures ?? 0 };
  cache.set(key, entry);
  value.then(() => { entry.expires = Date.now() + ttl; entry.failures = 0; }, () => { entry.failures++; entry.expires = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(entry.failures - 1, 4)); });
  if (cache.size > 300) for (const [k, v] of cache) if (v.expires < Date.now()) cache.delete(k);
  if (cache.size > 350) for (const [k, v] of cache) { if (v.expires !== Infinity) cache.delete(k); if (cache.size <= 300) break; }
  return value;
}

export async function remote(url: string, encoding = "utf-8"): Promise<string> {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000), headers: { "User-Agent": "Mozilla/5.0 StockLens/0.1", Accept: "application/json,text/plain,*/*" } });
  if (!response.ok) throw new Error(`行情接口暂不可用（HTTP ${response.status}）`);
  return new TextDecoder(encoding).decode(await response.arrayBuffer());
}

export async function json<T>(url: string): Promise<T> {
  return JSON.parse(await remote(url)) as T;
}

export function numeric(input: unknown, fallback = 0): number {
  const n = typeof input === "string" && input.trim() === "" ? NaN : Number(input);
  return Number.isFinite(n) ? n : fallback;
}

export function optionalNumber(input: unknown): number | null {
  if (input === "" || input === null || input === undefined || input === "-") return null;
  const n = Number(input);
  return Number.isFinite(n) ? n : null;
}
