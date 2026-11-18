import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { dailyRecord } from "./store";

export type Lease = { owner: string; until: number; startedAt: number; key?: string };
export type RequestState = { monitor?: unknown; refreshRequestedAt?: number; leases?: Record<string, Lease> };
export type RequestOwner = { scope: string; owner: string };
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export function owns(state: unknown, request: RequestOwner): boolean {
  const lease = (state as RequestState | null)?.leases?.[request.scope];
  return !!lease && lease.owner === request.owner && lease.until > Date.now();
}

// 租约只保护同一股票/交易日/任务；网络和模型请求不占用数据库事务。
export async function acquireRequest(symbol: string, date: string, scope: string, duration: number, key?: string) {
  await dailyRecord(symbol, date);
  return db().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "DailySignal" WHERE symbol = ${symbol} AND "tradeDate" = ${date} FOR UPDATE`;
    const row = await tx.dailySignal.findUniqueOrThrow({ where: { symbol_tradeDate: { symbol, tradeDate: date } } });
    const runtime = row.runtime as RequestState;
    if ((runtime.leases?.[scope]?.until ?? 0) > Date.now()) return { acquired: false as const, row };
    const request = { scope, owner: randomUUID() };
    const lease: Lease = { owner: request.owner, startedAt: Date.now(), until: Date.now() + duration, ...(key ? { key } : {}) };
    const updated = await tx.dailySignal.update({ where: { id: row.id }, data: { runtime: json({ ...runtime, leases: { ...runtime.leases, [scope]: lease } }) } });
    return { acquired: true as const, request, row: updated };
  }, { timeout: 4000 });
}

export async function saveMonitor(symbol: string, date: string, request: RequestOwner, monitor: unknown, coverage?: Record<string, unknown>) {
  return db().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "DailySignal" WHERE symbol = ${symbol} AND "tradeDate" = ${date} FOR UPDATE`;
    const row = await tx.dailySignal.findUniqueOrThrow({ where: { symbol_tradeDate: { symbol, tradeDate: date } } });
    if (!owns(row.runtime, request)) throw new Error("当前计算请求已过期，结果未覆盖新状态，请刷新。");
    await tx.dailySignal.update({ where: { id: row.id }, data: { runtime: json({ ...row.runtime as RequestState, monitor }), ...(coverage ? { coverage: json({ ...row.coverage as object, ...coverage }) } : {}) } });
  }, { timeout: 4000 });
}

export async function releaseRequest(symbol: string, date: string, request: RequestOwner) {
  await db().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "DailySignal" WHERE symbol = ${symbol} AND "tradeDate" = ${date} FOR UPDATE`;
    const row = await tx.dailySignal.findUniqueOrThrow({ where: { symbol_tradeDate: { symbol, tradeDate: date } } });
    const runtime = row.runtime as RequestState, leases = { ...runtime.leases };
    if (leases[request.scope]?.owner !== request.owner) return;
    delete leases[request.scope];
    await tx.dailySignal.update({ where: { id: row.id }, data: { runtime: json({ ...runtime, leases }) } });
  }, { timeout: 4000 });
}

export async function requestRefresh(symbol: string, date: string) {
  await dailyRecord(symbol, date);
  await db().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "DailySignal" WHERE symbol = ${symbol} AND "tradeDate" = ${date} FOR UPDATE`;
    const row = await tx.dailySignal.findUniqueOrThrow({ where: { symbol_tradeDate: { symbol, tradeDate: date } } });
    await tx.dailySignal.update({ where: { id: row.id }, data: { runtime: json({ ...row.runtime as RequestState, refreshRequestedAt: Date.now() }) } });
  }, { timeout: 4000 });
}
