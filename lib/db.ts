import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { Pool } from "pg";
import { attachDatabasePool } from "@vercel/functions";

const globalDb = globalThis as unknown as { stocklensDb?: PrismaClient; stocklensDbVersion?: string };

export function db(): PrismaClient {
  if (!process.env.DATABASE_URL) throw new Error("尚未配置 DATABASE_URL，请设置当前环境的 PostgreSQL 连接。");
  if (!globalDb.stocklensDb || globalDb.stocklensDbVersion !== "request-state-pool-v1") {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 10000, idleTimeoutMillis: 5000, allowExitOnIdle: true });
    if (process.env.VERCEL) attachDatabasePool(pool);
    globalDb.stocklensDb = new PrismaClient({
      adapter: new PrismaPg(pool),
    });
    globalDb.stocklensDbVersion = "request-state-pool-v1";
  }
  return globalDb.stocklensDb;
}
