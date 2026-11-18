import { db } from "@/lib/db";
import type { MinuteBar, Observation, Point, SignalState } from "@/lib/types";
import { tradeDate } from "@/lib/time";
import type { Prisma } from "@/generated/prisma/client";
import { consecutiveBars, PARAMETERS, STRATEGY_VERSION } from "./engine";
import type { RequestOwner, RequestState } from "./request-state";

const toJson = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
export const asPoints = (v: unknown): Point[] => Array.isArray(v) ? v as Point[] : [];

export async function dailyRecord(symbol: string, date: string) {
  const row = await db().dailySignal.upsert({
    where: { symbol_tradeDate: { symbol, tradeDate: date } }, update: {},
    create: { symbol, tradeDate: date, strategy: toJson({ version: STRATEGY_VERSION, parameters: PARAMETERS }), coverage: toJson({ monitorStartedAt: Date.now() }) },
  });
  const legacy = ["causal-v1.0", "causal-minute-v2.0", "causal-realtime-v3.0", "causal-realtime-v4.0"];
  if (date === tradeDate() && legacy.includes((row.strategy as { version?: string }).version ?? "")) {
    return db().$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "DailySignal" WHERE id = ${row.id} FOR UPDATE`;
      const fresh = await tx.dailySignal.findUniqueOrThrow({ where: { id: row.id } });
      if (!legacy.includes((fresh.strategy as { version?: string }).version ?? "")) return fresh;
      const { monitor: _monitor, leases, ...runtime } = fresh.runtime as RequestState;
      const { signal: _signal, ...otherLeases } = leases ?? {};
      const { replay: _replay, gaps: _gaps, lastAiVeto: _veto, ...coverage } = fresh.coverage as SignalState["coverage"];
      return tx.dailySignal.update({ where: { id: row.id }, data: {
        strategy: toJson({ version: STRATEGY_VERSION, parameters: PARAMETERS, activatedAt: Date.now(), legacyStrategy: fresh.strategy, note: "原策略已确认点保持原样并占用当日配额；当前策略因果补算剩余机会" }),
        runtime: toJson({ ...runtime, leases: otherLeases }), coverage: toJson(coverage),
      } });
    });
  }
  return row;
}

export function validPointEvidence(point: Point): boolean {
  const e = point.inputSnapshot;
  if (!Number.isFinite(point.ruleScore) || point.ruleScore < PARAMETERS.scoreThreshold || point.ruleScore > 100 || e.cutoffAt !== point.pivotAt || !e.bars?.length || [...e.bars, ...(e.marketBars ?? [])].some(b => b.completedAt > point.pivotAt)) return false;
  if (e.sourceKind === "quote") {
    const latest = e.samples.at(-1);
    if (point.mode !== "live" || !latest || latest.availableAt !== point.pivotAt || latest.price.toFixed(2) !== point.pivotPrice || e.samples.some(s => s.at > point.pivotAt || s.availableAt > point.pivotAt || s.at > s.availableAt)) return false;
    if (!e.marketSample || e.marketSample.at > point.pivotAt || e.marketSample.availableAt > point.pivotAt) return false;
  } else if (e.bars.at(-1)!.completedAt !== point.pivotAt || e.bars.at(-1)!.close.toFixed(2) !== point.pivotPrice) return false;
  if (point.ai && (point.ai.status === "rejected" || point.ai.snapshotAt !== point.pivotAt || point.mode === "live" && (point.ai.finishedAt > point.confirmedAt || point.ai.startedAt < point.pivotAt))) return false;
  return true;
}

export async function mergeCoverage(symbol: string, date: string, patch: SignalState["coverage"]) {
  return db().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "DailySignal" WHERE symbol = ${symbol} AND "tradeDate" = ${date} FOR UPDATE`;
    const row = await tx.dailySignal.findUniqueOrThrow({ where: { symbol_tradeDate: { symbol, tradeDate: date } } });
    const coverage = { ...row.coverage as SignalState["coverage"], ...patch };
    await tx.dailySignal.update({ where: { id: row.id }, data: { coverage: toJson(coverage) } });
    return coverage;
  });
}

export async function appendPoint(symbol: string, date: string, point: Point, request?: RequestOwner): Promise<{ high: Point[]; low: Point[]; accepted: boolean }> {
  await dailyRecord(symbol, date);
  return db().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "DailySignal" WHERE symbol = ${symbol} AND "tradeDate" = ${date} FOR UPDATE`;
    const row = await tx.dailySignal.findUniqueOrThrow({ where: { symbol_tradeDate: { symbol, tradeDate: date } } });
    const high = asPoints(row.highPoints), low = asPoints(row.lowPoints);
    const lease = (row.runtime as RequestState | undefined)?.leases?.[request?.scope ?? ""];
    if (request && (!lease || lease.owner !== request.owner || lease.until <= Date.now())) return { high, low, accepted: false };
    const list = point.type === "HIGH" ? high : low;
    const now = Date.now();
    const strategy = row.strategy as { version?: string };
    if (strategy.version !== STRATEGY_VERSION || point.strategyVersion !== strategy.version || point.confirmedAt < point.pivotAt || point.confirmedAt > now) return { high, low, accepted: false };
    const historical = point.mode === "historical";
    if (!["historical", "live"].includes(point.mode ?? "") || !validPointEvidence(point)) return { high, low, accepted: false };
    if (historical && point.confirmedAt !== point.pivotAt || !historical && now - point.pivotAt > PARAMETERS.deadlineMs || point.confirmedAt - point.pivotAt > PARAMETERS.deadlineMs) return { high, low, accepted: false };
    if (now < point.pivotAt || list.length >= 3 || [...high, ...low].some(p => p.id === point.id || (p.type === point.type && p.pivotAt === point.pivotAt))) return { high, low, accepted: false };
    const frozen: Point = { ...point, sequenceNo: list.length + 1, confirmedAt: historical ? point.pivotAt : now, recordedAt: now };
    const opposite = (point.type === "HIGH" ? low : high).filter(p => !p.pairWithPointId && !p.riskEvents.some(e => e.type === "invalidated")).at(-1);
    if (opposite) {
      const highPrice = point.type === "HIGH" ? Number(point.quoteAtConfirmation) : Number(opposite.quoteAtConfirmation);
      const lowPrice = point.type === "LOW" ? Number(point.quoteAtConfirmation) : Number(opposite.quoteAtConfirmation);
      if (opposite.pivotAt < point.pivotAt && highPrice > lowPrice) { frozen.pairWithPointId = opposite.id; opposite.pairWithPointId = frozen.id; }
    }
    list.push(frozen);
    await tx.dailySignal.update({ where: { id: row.id }, data: { highPoints: toJson(high), lowPoints: toJson(low) } });
    if (!historical && Date.now() - point.pivotAt > PARAMETERS.deadlineMs) throw new Error("点位写入超过 30 秒截止，已回滚本次确认。");
    return { high, low, accepted: true };
  }, { timeout: 4000 });
}

export async function invalidateFromBars(symbol: string, date: string, bars: MinuteBar[]) {
  const row = await db().dailySignal.findUnique({ where: { symbol_tradeDate: { symbol, tradeDate: date } } });
  if (!row) return;
  const breakAt = (point: Point) => {
    let consecutive = 0;
    let previous: MinuteBar | null = null;
    for (const bar of bars) {
      if (bar.completedAt <= point.confirmedAt || bar.completedAt > Date.now()) continue;
      if (previous && !consecutiveBars(previous, bar)) consecutive = 0;
      const broken = point.invalidationRule.direction === "above" ? bar.close > point.invalidationRule.price : bar.close < point.invalidationRule.price;
      consecutive = broken ? consecutive + 1 : 0;
      if (consecutive >= 3) return bar;
      previous = bar;
    }
    return null;
  };
  if (![...asPoints(row.highPoints), ...asPoints(row.lowPoints)].some(p => !p.riskEvents.length && breakAt(p))) return;
  await db().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "DailySignal" WHERE id = ${row.id} FOR UPDATE`;
    const fresh = await tx.dailySignal.findUniqueOrThrow({ where: { id: row.id } });
    const high = asPoints(fresh.highPoints), low = asPoints(fresh.lowPoints);
    for (const p of [...high, ...low]) {
      if (p.riskEvents.length) continue;
      const bar = breakAt(p);
      if (bar) p.riskEvents.push({ type: "invalidated", at: bar.completedAt, price: bar.close, reason: "后续连续三个已完成分钟收盘突破结构失效阈值；保留原点位与评分" });
    }
    await tx.dailySignal.update({ where: { id: row.id }, data: { highPoints: toJson(high), lowPoints: toJson(low) } });
  });
}

export function sustainedBreak(point: Point, observations: Observation[]): boolean {
  const recent = observations.slice(-3);
  return recent.length === 3 && recent[2].at - recent[0].at >= 6000 && recent.every((s, i) => s.at > point.confirmedAt && (i === 0 || s.at > recent[i - 1].at) && (point.invalidationRule.direction === "above" ? s.price > point.invalidationRule.price : s.price < point.invalidationRule.price));
}

export async function invalidatePoints(symbol: string, date: string, observations: Observation[]): Promise<{ high: Point[]; low: Point[] } | null> {
  const latest = observations.at(-1);
  if (!latest || Date.now() - latest.at > PARAMETERS.freshnessMs) return null;
  const { price, at } = latest;
  const row = await db().dailySignal.findUnique({ where: { symbol_tradeDate: { symbol, tradeDate: date } } });
  if (!row) return null;
  const should = [...asPoints(row.highPoints), ...asPoints(row.lowPoints)].some(p => !p.riskEvents.length && sustainedBreak(p, observations));
  if (!should) return null;
  return db().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "DailySignal" WHERE id = ${row.id} FOR UPDATE`;
    const fresh = await tx.dailySignal.findUniqueOrThrow({ where: { id: row.id } });
    const high = asPoints(fresh.highPoints), low = asPoints(fresh.lowPoints);
    for (const p of [...high, ...low]) if (!p.riskEvents.length && sustainedBreak(p, observations)) {
      p.riskEvents.push({ type: "invalidated", at, price, reason: p.type === "HIGH" ? "价格突破原阻力观察阈值，保留原点并标记失效" : "价格跌破原支撑观察阈值，保留原点并标记失效" });
    }
    await tx.dailySignal.update({ where: { id: fresh.id }, data: { highPoints: toJson(high), lowPoints: toJson(low) } });
    return { high, low };
  });
}
