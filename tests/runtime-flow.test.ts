import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MinuteBar, Point, Quote } from "@/lib/types";
import type { RequestState } from "@/lib/analysis/request-state";

type Row = { id: string; symbol: string; tradeDate: string; highPoints: Point[]; lowPoints: Point[]; strategy: unknown; coverage: unknown; runtime: RequestState };
const state = vi.hoisted(() => ({ rows: new Map<string, Row>(), tail: Promise.resolve() as Promise<unknown>, quotes: vi.fn(), history: vi.fn(), review: vi.fn(), trading: true as boolean | null, quotePrice: 100, lastStock: "002281.SZ" }));
vi.mock("@/lib/settings", () => ({ appSettings: async () => ({ lastStock: state.lastStock }), resolveLlm: async () => null }));
vi.mock("@/lib/market/calendar", () => ({ calendar: async () => ({ isTradingDay: state.trading }) }));
vi.mock("@/lib/market/provider", () => ({ getQuotes: state.quotes, getDaily: async () => Array.from({ length: 21 }, () => ({ time: "2026-11-16" })), getMinuteHistory: state.history }));
vi.mock("@/lib/analysis/signal-ai", () => ({ reviewPoint: state.review }));
// 每次读取复制数据；模拟 PostgreSQL 行锁的事务串行化，避免借助共享对象隐藏恢复问题。
vi.mock("@/lib/db", () => {
  const key = (where: { id?: string; symbol_tradeDate?: { symbol: string; tradeDate: string } }) => where.id ?? `${where.symbol_tradeDate!.symbol}:${where.symbol_tradeDate!.tradeDate}`;
  const database = {
    $queryRaw: async () => [],
    dailySignal: {
      upsert: async ({ where, create }: { where: Parameters<typeof key>[0]; create: Partial<Row> }) => {
        const id = key(where); if (!state.rows.has(id)) state.rows.set(id, { id, ...where.symbol_tradeDate, highPoints: [], lowPoints: [], strategy: {}, coverage: {}, runtime: {}, ...create } as Row);
        return structuredClone(state.rows.get(id)!);
      },
      findUnique: async ({ where }: { where: Parameters<typeof key>[0] }) => structuredClone(state.rows.get(key(where)) ?? null),
      findUniqueOrThrow: async ({ where }: { where: Parameters<typeof key>[0] }) => { const row = state.rows.get(key(where)); if (!row) throw new Error("missing row"); return structuredClone(row); },
      findMany: async ({ where }: { where: { tradeDate: string; symbol?: string } }) => [...state.rows.values()].filter(r => r.tradeDate === where.tradeDate && (!where.symbol || r.symbol === where.symbol)).map(r => structuredClone(r)),
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => { const row = state.rows.get(where.id)!; Object.assign(row, structuredClone(data)); return structuredClone(row); },
    },
    appSetting: { update: async ({ data }: { data: { lastStock: string } }) => { state.lastStock = data.lastStock; } },
    watchlist: { findMany: async () => [] },
    analysisReport: { findUnique: async () => null },
  };
  return { db: () => ({ ...database, $transaction: async (work: (tx: typeof database) => unknown) => { const next = state.tail.then(() => work(database)); state.tail = next.catch(() => {}); return next; } }) };
});
function history(symbol: string, continuous = false) {
  const start = Date.parse("2026-11-17T09:31:00+08:00"), index = symbol === "399001.SZ";
  const shape = (i: number) => index ? 3000 + Math.sin(i * Math.PI / 4) * .05 : continuous ? i < 75 ? 100 + Math.sin(i * Math.PI / 5) * 2 : i === 80 ? 105.67009618943233 : 106 + Math.sin((i - 75) * Math.PI / 3) * .15 : i < 79 ? 100 + Math.sin(i * Math.PI / 5) * .05 : 102;
  const bars: MinuteBar[] = Array.from({ length: continuous ? 81 : 80 }, (_, i) => {
    const at = start + i * 60000, open = shape(i - 1), close = shape(i), volume = i === 80 ? 40000 : 10000;
    return { at, completedAt: at + 60000, time: new Date(at + 8 * 3600000).toISOString().slice(0, 16).replace("T", " "), open, close, high: Math.max(open, close) + .05, low: Math.min(open, close) - .05, volume, amount: close * volume, average: index ? 3000 : 100 };
  });
  return { fetchedAt: Date.now(), missing: [], bars };
}
function advice(p: Point, accepted = true) { return { accepted, ai: { status: p.mode === "historical" ? "historical_skipped" : accepted ? "approved" : "rejected", summary: "test advice", risks: [], model: p.mode === "historical" ? null : "test-model", snapshotAt: p.pivotAt, startedAt: Date.now(), finishedAt: Date.now() } }; }
async function settleUntil(predicate: () => boolean) { for (let i = 0; i < 30 && !predicate(); i++) await new Promise<void>(resolve => setImmediate(resolve)); expect(predicate()).toBe(true); }
const savedRow = (symbol = "002281.SZ") => state.rows.get(`${symbol}:2026-11-17`)!;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "setInterval", "clearTimeout", "clearInterval"] }); vi.setSystemTime(new Date("2026-11-17T10:51:12+08:00")); vi.resetModules();
  state.rows.clear(); state.tail = Promise.resolve(); state.trading = true; state.quotePrice = 100; state.lastStock = "002281.SZ";
  state.history.mockReset().mockImplementation(async (s: string) => history(s));
  state.review.mockReset().mockImplementation(async (p: Point) => advice(p));
  state.quotes.mockReset().mockImplementation(async (symbols: string[]) => symbols.map(symbol => {
    const price = ["000001.SH", "399001.SZ", "399006.SZ"].includes(symbol) ? 3000 : state.quotePrice;
    return { symbol, name: "测试股票", exchange: "SZ", price, sourceAt: Date.now(), observedAt: Date.now(), volume: 2000000, amount: price === 3000 ? 6000000000 : 200000000, high: Math.max(price, 100.6), low: 99.4, changePercent: 0, bid: price - .01, ask: price + .01, bidSize: 100, askSize: 10000 } as Quote;
  }));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); delete (globalThis as { stocklensRuntime?: unknown }).stocklensRuntime; });

describe("request-driven calculation with database state", () => {
  it("returns the persisted current stock as a code in the watchlist API", async () => {
    await (await import("@/lib/runtime")).monitor("002384.SZ");
    const response = await (await import("@/app/api/watchlist/route")).GET();
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ current: "002384.SZ" });
  });
  it("clears the legacy timer and performs no work without page requests", async () => {
    const work = vi.fn(); (globalThis as { stocklensRuntime?: unknown }).stocklensRuntime = { timer: setInterval(work, 1000) };
    await import("@/lib/runtime"); await vi.advanceTimersByTimeAsync(60000);
    expect(work).not.toHaveBeenCalled(); expect(state.quotes).not.toHaveBeenCalled(); expect(state.history).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("runs one finite request and stays idle after it returns", async () => {
    const { signalState } = await import("@/lib/runtime"); await signalState("002281.SZ");
    expect(state.quotes).toHaveBeenCalledTimes(1); expect(state.history).toHaveBeenCalledTimes(2);
    const counts = [state.quotes.mock.calls.length, state.history.mock.calls.length]; await vi.advanceTimersByTimeAsync(60000);
    expect([state.quotes.mock.calls.length, state.history.mock.calls.length]).toEqual(counts); expect(vi.getTimerCount()).toBe(0);
    expect(savedRow().runtime.leases).toEqual({}); expect((globalThis as { stocklensRuntime?: unknown }).stocklensRuntime).toBeUndefined();
  });
  it("restores samples and indicator state when the next request runs in a new module instance", async () => {
    let runtime = await import("@/lib/runtime"); const first = await runtime.signalState("002281.SZ");
    await vi.advanceTimersByTimeAsync(3000); vi.resetModules(); runtime = await import("@/lib/runtime"); const second = await runtime.signalState("002281.SZ");
    const monitor = savedRow().runtime.monitor as { engine: { samples: unknown[] }; minuteEngine: { bars?: unknown[] }; monitoredSince: number };
    expect(monitor.engine.samples).toHaveLength(2); expect(second.monitoredSince).toBe(first.monitoredSince);
    expect(state.history).toHaveBeenCalledTimes(2); expect(monitor.minuteEngine.bars).toBeUndefined();
  });
  it("allows only one concurrent sampling request across module instances", async () => {
    const a = await import("@/lib/runtime"); vi.resetModules(); const b = await import("@/lib/runtime");
    await Promise.all([a.signalState("002281.SZ"), b.signalState("002281.SZ"), a.signalState("002281.SZ")]);
    expect(state.quotes).toHaveBeenCalledTimes(1); expect(state.history).toHaveBeenCalledTimes(2);
  });
  it.each(["08:00:00", "12:00:00", "18:00:00"])("keeps off-hours history throttling across instances at %s and supports manual refresh", async time => {
    vi.setSystemTime(new Date(`2026-11-17T${time}+08:00`));
    let runtime = await import("@/lib/runtime"); await runtime.signalState("002281.SZ");
    await vi.advanceTimersByTimeAsync(60000); vi.resetModules(); runtime = await import("@/lib/runtime"); await runtime.signalState("002281.SZ");
    expect(state.history).toHaveBeenCalledTimes(2); expect(state.quotes).not.toHaveBeenCalled();
    await runtime.monitor("002281.SZ"); await runtime.signalState("002281.SZ"); expect(state.history).toHaveBeenCalledTimes(4);
  });
  it("lets a switched stock finish independently without cancelling the first stock", async () => {
    let release!: (value: ReturnType<typeof history>) => void;
    const delayed = new Promise<ReturnType<typeof history>>(resolve => { release = resolve; });
    state.history.mockImplementation(async (s: string) => s === "002281.SZ" ? delayed : history(s));
    const runtime = await import("@/lib/runtime"), first = runtime.signalState("002281.SZ");
    await settleUntil(() => state.history.mock.calls.length > 0);
    const second = await runtime.signalState("002384.SZ"); expect(second.coverage.replay?.bars).toBe(80);
    release(history("002281.SZ")); const result = await first; expect(result.coverage.replay?.bars).toBe(80);
    expect(result.coverage.replay?.assessments?.HIGH.warming).toBeGreaterThan(0);
    expect(result.symbol).toBe("002281.SZ"); expect(savedRow("002384.SZ").runtime.monitor).toBeTruthy();
  });
  it("does no upstream work on non-trading or unknown calendar days", async () => {
    for (const trading of [false, null]) { state.trading = trading; await (await import("@/lib/runtime")).signalState("002281.SZ"); }
    expect(state.history).not.toHaveBeenCalled(); expect(state.quotes).not.toHaveBeenCalled();
  });
});

describe("AI finishes within the request", () => {
  it.each([true, false])("awaits AI, exposes pending state to another instance, and persists accepted=%s", async accepted => {
    state.quotePrice = 101.9; let release!: (value: ReturnType<typeof advice>) => void;
    state.review.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const firstRuntime = await import("@/lib/runtime"), work = firstRuntime.signalState("002281.SZ"); let finished = false; void work.then(() => { finished = true; });
    await settleUntil(() => state.review.mock.calls.length === 1); expect(finished).toBe(false);
    vi.resetModules(); const nextRuntime = await import("@/lib/runtime"), busy = await nextRuntime.signalState("002281.SZ");
    expect(busy.pendingAi?.score).toBeGreaterThanOrEqual(85); expect(state.review).toHaveBeenCalledTimes(1); expect(busy.highPoints).toEqual([]);
    const point = state.review.mock.calls[0][0] as Point; release(advice(point, accepted)); const completed = await work;
    expect(completed.highPoints).toHaveLength(accepted ? 1 : 0); expect(completed.pendingAi).toBeNull();
    expect(savedRow().runtime.leases).toEqual({});
    if (!accepted) expect(completed.coverage.lastAiVeto?.summary).toBe("test advice");
    await vi.advanceTimersByTimeAsync(3000); vi.resetModules(); await (await import("@/lib/runtime")).signalState("002281.SZ");
    expect(state.review).toHaveBeenCalledTimes(1);
  });
  it("abandons the frozen point if the quote moves past its invalidation during AI", async () => {
    state.quotePrice = 101.9; state.review.mockImplementation(async (p: Point) => { state.quotePrice = p.invalidationRule.price + 1; return advice(p); });
    const result = await (await import("@/lib/runtime")).signalState("002281.SZ");
    expect(state.review).toHaveBeenCalledTimes(1); expect(result.highPoints).toEqual([]); expect(result.message).toMatch(/过期|空间变化/);
  });
});

describe("causal minute decisions survive instance changes", () => {
  it("backfills morning points on the first afternoon opening, then preserves them across reloads", async () => {
    vi.setSystemTime(new Date("2026-11-17T14:00:00+08:00"));
    state.history.mockImplementation(async (s: string) => history(s, true));
    const runtime = await import("@/lib/runtime"), first = await runtime.signalState("002281.SZ");
    expect(first.highPoints).toHaveLength(1);
    const point = first.highPoints[0];
    expect(point.mode).toBe("historical"); expect(point.pivotAt).toBe(Date.parse("2026-11-17T10:52:00+08:00"));
    expect(point.recordedAt).toBe(Date.now()); expect(point.confirmedAt).toBe(point.pivotAt);
    expect(point.ai?.status).toBe("historical_skipped"); expect(state.review.mock.calls.every(([p]) => p.mode === "historical")).toBe(true);
    expect(point.inputSnapshot.bars!.every(b => b.completedAt <= point.pivotAt)).toBe(true);
    expect(first.coverage.replay?.assessments?.HIGH.qualified).toBe(1);
    await vi.advanceTimersByTimeAsync(30000); vi.resetModules();
    const second = await (await import("@/lib/runtime")).signalState("002281.SZ");
    expect(second.highPoints).toEqual(first.highPoints); expect(second.lowPoints).toEqual(first.lowPoints);
  });
  it("upgrades V4 state and replays under V5 while retaining points and unrelated report/auction state", async () => {
    state.history.mockImplementation(async (s: string) => history(s, true));
    vi.setSystemTime(new Date("2026-11-17T14:00:00+08:00"));
    const runtime = await import("@/lib/runtime"), initial = await runtime.signalState("002281.SZ");
    const row = savedRow(), point = row.highPoints[0]; point.strategyVersion = "causal-realtime-v4.0";
    const frozen = structuredClone(row.highPoints);
    row.strategy = { version: "causal-realtime-v4.0" };
    row.coverage = { ...initial.coverage, auction: { preserved: true }, lastAiVeto: { type: "HIGH", triggerAt: point.pivotAt } };
    row.runtime.leases = { "report:COMPANY_RESEARCH": { owner: "report-owner", until: Date.now() + 60000, startedAt: Date.now() } };
    await vi.advanceTimersByTimeAsync(1000); vi.resetModules();
    const result = await (await import("@/lib/runtime")).signalState("002281.SZ");
    expect(result.strategyVersion).toBe("causal-realtime-v5.0"); expect(result.highPoints).toEqual(frozen);
    expect(result.coverage.auction).toEqual({ preserved: true }); expect(result.coverage.lastAiVeto).toBeUndefined();
    expect(savedRow().runtime.leases?.["report:COMPANY_RESEARCH"].owner).toBe("report-owner");
    expect((savedRow().runtime.monitor as { engine: { strategy: string } }).engine.strategy).toBe("causal-realtime-v5.0");
  });
  it.each([false, true])("handles a newly completed minute with page gap=%s", async gap => {
    state.history.mockImplementation(async (s: string) => history(s, true)); state.quotePrice = 106;
    let runtime = await import("@/lib/runtime"); await runtime.signalState("002281.SZ"); expect(state.review).not.toHaveBeenCalled();
    if (gap) await vi.advanceTimersByTimeAsync(50000);
    else for (let i = 0; i < 16; i++) { await vi.advanceTimersByTimeAsync(3000); vi.resetModules(); runtime = await import("@/lib/runtime"); await runtime.signalState("002281.SZ"); }
    state.quotePrice = 105.67009618943233;
    if (!gap) await vi.advanceTimersByTimeAsync(2000);
    vi.resetModules(); const result = await (await import("@/lib/runtime")).signalState("002281.SZ");
    expect(result.highPoints).toHaveLength(1); const p = result.highPoints[0];
    expect(p.mode).toBe(gap ? "historical" : "live"); expect(p.pivotAt).toBe(Date.parse("2026-11-17T10:52:00+08:00"));
    expect(p.pivotPrice).toBe("105.67"); expect(p.inputSnapshot.samples).toEqual([]); expect(p.inputSnapshot.bars!.every(b => b.completedAt <= p.pivotAt)).toBe(true);
    await vi.advanceTimersByTimeAsync(3000); await (await import("@/lib/runtime")).signalState("002281.SZ"); expect(savedRow().highPoints).toHaveLength(1);
  });
});

describe("database request fencing", () => {
  it("expires a crashed request and prevents its late save or release from affecting the new owner", async () => {
    const store = await import("@/lib/analysis/request-state"), first = await store.acquireRequest("002281.SZ", "2026-11-17", "signal", 1000);
    expect(first.acquired).toBe(true); if (!first.acquired) return;
    expect((await store.acquireRequest("002281.SZ", "2026-11-17", "signal", 1000)).acquired).toBe(false);
    await vi.advanceTimersByTimeAsync(1001); const second = await store.acquireRequest("002281.SZ", "2026-11-17", "signal", 1000); if (!second.acquired) throw new Error("missing new owner");
    await expect(store.saveMonitor("002281.SZ", "2026-11-17", first.request, {})).rejects.toThrow(/过期/);
    await store.releaseRequest("002281.SZ", "2026-11-17", first.request);
    expect(savedRow().runtime.leases?.signal.owner).toBe(second.request.owner);
    const other = await store.acquireRequest("002281.SZ", "2026-11-17", "report:COMPANY_RESEARCH", 1000);
    expect(other.acquired).toBe(true); await store.saveMonitor("002281.SZ", "2026-11-17", second.request, { test: true });
    expect(savedRow().runtime.leases?.["report:COMPANY_RESEARCH"]).toBeTruthy();
    await store.releaseRequest("002281.SZ", "2026-11-17", second.request);
  });
  it("returns 202 for a duplicate report while another instance owns its generation lease", async () => {
    const store = await import("@/lib/analysis/request-state"); await store.acquireRequest("002281.SZ", "2026-11-17", "report:COMPANY_RESEARCH", 1000);
    const { reportsGenerating } = await import("@/lib/analysis/reports"); expect(await reportsGenerating("002281.SZ")).toBe(true);
    const { POST } = await import("@/app/api/reports/route");
    const result = await POST(new Request("http://localhost:3000/api/reports", { method: "POST", body: JSON.stringify({ symbol: "002281.SZ", type: "COMPANY_RESEARCH" }) }));
    expect(result.status).toBe(202); expect(await result.json()).toMatchObject({ generating: true }); expect(state.review).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1001); expect(await reportsGenerating("002281.SZ")).toBe(false);
  });
});
