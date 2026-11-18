import { z } from "zod";
import { body, success, failure } from "@/lib/api";
import { db } from "@/lib/db";
import { configFromInput, publicSettings, saveModel } from "@/lib/settings";
import { testModel } from "@/lib/analysis/reports";
import type { Prisma } from "@/generated/prisma/client";
export const maxDuration = 60;

export async function GET() { try { return success(await publicSettings()); } catch (e) { return failure(e); } }
export async function PUT(request: Request) {
  try {
    const input = z.object({ prefs: z.object({ sound: z.boolean().optional() }).optional(), llm: z.object({ baseUrl: z.string().min(1), model: z.string().min(1), apiKey: z.string().optional() }).optional() }).parse(await body(request));
    if (input.llm) {
      const config = await configFromInput(input.llm);
      await testModel(config);
      await saveModel(config);
    }
    if (input.prefs) {
      const current = await db().appSetting.findUniqueOrThrow({ where: { id: 1 } });
      await db().appSetting.update({ where: { id: 1 }, data: { prefs: { ...current.prefs as Record<string, boolean>, ...input.prefs } as Prisma.InputJsonValue } });
    }
    return success(await publicSettings());
  } catch (e) { return failure(e); }
}
