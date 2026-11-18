import { success, failure } from "@/lib/api";
import { searchStocks } from "@/lib/market/provider";

export async function GET(request: Request) {
  try { return success({ stocks: await searchStocks(new URL(request.url).searchParams.get("q") || "") }); }
  catch (e) { return failure(e); }
}
