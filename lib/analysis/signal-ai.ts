import { z } from "zod";
import { resolveLlm } from "@/lib/settings";
import type { Point, PointAi } from "@/lib/types";
import { PARAMETERS } from "./engine";
import { requestModel } from "./model";

const verdict = z.object({ decision: z.enum(["approve", "reject"]), summary: z.string().trim().min(1).max(600), risks: z.array(z.string().trim().min(1).max(200)).max(5) }).strict();
export function parseSignalAdvice(text: string) {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return verdict.parse(JSON.parse(raw)); }
  catch { throw new Error("AI 点位建议格式不可用，本次按量化结果处理。"); }
}

export async function reviewPoint(point: Point, symbol = "当前股票"): Promise<{ accepted: boolean; ai: PointAi }> {
  const startedAt = Date.now();
  const result = (status: PointAi["status"], summary: string, risks: string[] = []): { accepted: boolean; ai: PointAi } => ({ accepted: status !== "rejected", ai: { status, summary, risks, model, snapshotAt: point.pivotAt, startedAt, finishedAt: Date.now() } });
  let model: string | null = null, timer: ReturnType<typeof setTimeout> | undefined;
  if (point.mode === "historical") return result("historical_skipped", "分钟近似回放不调用当前 AI，不补造历史模型决策。");
  const work = async () => {
    const config = await resolveLlm();
    if (!config) return result("not_configured", "未配置可用模型，本次按量化结果处理。");
    model = config.model;
    const remaining = PARAMETERS.aiTimeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) throw new Error("AI 点位分析超时，本次按量化结果处理。");
    const snapshot = { symbol, type: point.type, triggerAt: new Date(point.pivotAt).toISOString(), triggerPrice: point.pivotPrice,
      score: point.ruleScore, regime: point.regime, features: point.inputSnapshot.features, groups: point.inputSnapshot.groups,
      bars: point.inputSnapshot.bars?.slice(-15), quotes: point.inputSnapshot.samples.slice(-8), index: point.inputSnapshot.marketSample ?? point.inputSnapshot.market,
      missing: point.inputSnapshot.missing };
    const response = await requestModel(config, [
      { role: "system", content: "你是 A 股日内高抛低吸的快速复核员。只使用提供的冻结数据，不能引用当前新闻、未提供的盘口、未来价格或自有行情。规则分不是胜率，请独立审查证据。区分趋势延续与反转：放量创新高、动量继续增强不能当作阻力；破位、低点继续下移不能当作支撑。检查价格响应、ATR尺度影线、已观察的边界收复、当前波段起点和趋势；一档挂单与多个同源振荡指标不能独自证明转向。重点否决弱承接、强趋势逆势和迟到机会。不保证精确极值，不改变价格和时间。只输出JSON：{\"decision\":\"approve\"或\"reject\",\"summary\":\"简短依据\",\"risks\":[\"风险\"]}。明确不建议才reject，正文简洁。" },
      { role: "user", content: JSON.stringify(snapshot) },
    ], 512, remaining, "signal");
    const advice = parseSignalAdvice(response.text);
    return result(advice.decision === "approve" ? "approved" : "rejected", advice.summary, advice.risks);
  };
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("AI 点位分析超过5秒，本次按量化结果处理。")), PARAMETERS.aiTimeoutMs); })]);
  } catch (error) {
    return result("unavailable", error instanceof Error ? error.message : "AI 点位分析不可用，本次按量化结果处理。");
  } finally { if (timer) clearTimeout(timer); }
}
