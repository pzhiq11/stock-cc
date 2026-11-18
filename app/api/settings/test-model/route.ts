import { z } from "zod";
import { body, success, failure } from "@/lib/api";
import { configFromInput } from "@/lib/settings";
import { testModel } from "@/lib/analysis/reports";
export const maxDuration = 60;

export async function POST(request: Request) {
  try { const input = z.object({ baseUrl: z.string(), model: z.string(), apiKey: z.string().optional() }).parse(await body(request)); return success(await testModel(await configFromInput(input))); }
  catch (e) { return failure(e); }
}
