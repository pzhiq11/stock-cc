import { z } from "zod";
import { body, success, failure } from "@/lib/api";
import { monitor } from "@/lib/runtime";

export async function PUT(request: Request) {
  try { const input = z.object({ symbol: z.string() }).parse(await body(request)); await monitor(input.symbol); return success({ ok: true }); }
  catch (e) { return failure(e); }
}
