import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

async function seed() {
  const initialized = await prisma.appSetting.findUnique({ where: { id: 1 } });
  await prisma.appSetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  if (!initialized) {
    await prisma.watchlist.createMany({ data: [
      { symbol: "002281.SZ", name: "光迅科技", sort: 0 },
      { symbol: "002384.SZ", name: "东山精密", sort: 1 },
      { symbol: "300308.SZ", name: "中际旭创", sort: 2},
    ], skipDuplicates: true });
  }
  console.log("已初始化默认设置与常看列表；未生成任何行情、点位或报告。");
}

seed().finally(() => prisma.$disconnect());
