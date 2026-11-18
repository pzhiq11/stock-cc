import type { MinuteBar, PointType, ReplayAssessment, SignalAssessment } from "@/lib/types";

export function emptyReplayAssessments(): Record<PointType, ReplayAssessment> {
  const empty = (): ReplayAssessment => ({ evaluated: 0, armed: 0, scorePassed: 0, filtersPassed: 0, qualified: 0, warming: 0, dataLimited: 0, blocked: {}, closest: null, bestUnblocked: null });
  return { HIGH: empty(), LOW: empty() };
}

export function recordReplayAssessment(stats: ReplayAssessment, bar: MinuteBar, assessment: SignalAssessment | undefined, threshold: number, missingMarket: boolean) {
  stats.evaluated++;
  if (bar.open === null || missingMarket) stats.dataLimited++;
  if (!assessment) { stats.warming++; return; }
  if (!assessment.armed) return;
  stats.armed++;
  const candidate = { at: bar.completedAt, price: bar.close, score: assessment.score, blockers: [...assessment.blockers], template: assessment.template };
  if (!stats.closest || candidate.score > stats.closest.score) stats.closest = candidate;
  if (candidate.score >= threshold) stats.scorePassed++;
  if (!candidate.blockers.length) {
    stats.filtersPassed++;
    if (!stats.bestUnblocked || candidate.score > stats.bestUnblocked.score) stats.bestUnblocked = candidate;
    if (candidate.score >= threshold) stats.qualified++;
  }
  for (const reason of candidate.blockers) stats.blocked[reason] = (stats.blocked[reason] ?? 0) + 1;
}

// 先按事件时刻截断，再逐条交给同一个引擎。绝不把历史窗口后的指数快照传入。
export function replayFrames(bars: MinuteBar[], marketBars: MinuteBar[], cutoff: number) {
  const indices = new Map(marketBars.filter(b => b.completedAt <= cutoff).map(b => [b.at, b]));
  const seen = new Set<number>();
  return bars.filter(b => b.completedAt <= cutoff).sort((a, b) => a.at - b.at).flatMap(bar => {
    if (seen.has(bar.at)) return [];
    seen.add(bar.at);
    const market = indices.get(bar.at) ?? null;
    return [{ bar, market: market && market.completedAt <= bar.completedAt ? market : null }];
  });
}
