import { TEMPLATE_LABELS, type PointType, type ReplayAssessment, type ScoreGroup, type SignalAssessment } from "@/lib/types";
import { time } from "@/lib/format";

export function ReplayScores({ assessments }: { assessments?: Record<PointType, ReplayAssessment> }) {
  if (!assessments) return null;
  return <div className="signal-scores"><div className="score-caption">当日因果分钟评估 · 每侧检查 {assessments.HIGH.evaluated} 分钟 · 85 是规则分数</div>{(["HIGH", "LOW"] as const).map(type => {
    const stats = assessments[type], closest = stats.closest;
    const reasons = Object.entries(stats.blocked ?? {}).sort((a, b) => b[1] - a[1]);
    return <details key={type}>
      <summary><span>{type === "HIGH" ? "分钟阻力最高" : "分钟支撑最高"}</span><strong>{closest ? closest.score.toFixed(1) : "—"}<small> / 100</small></strong><span className="score-status">{stats.qualified ? `${stats.qualified}次量化达标` : !closest ? "无候选" : closest.blockers.length ? "已过滤" : "分数不足"}</span></summary>
      <div className="score-blockers">
        <div>候选 {stats.armed} 次 · 达到85分 {stats.scorePassed ?? 0} 次 · 通过过滤 {stats.filtersPassed ?? 0} 次 · 同时满足 {stats.qualified} 次</div>
        <small>候选次数按分钟统计，不代表独立波段或已保存点数；同一结构、AI否决和全天配额仍会限制标点。</small>
        {(stats.warming > 0 || stats.dataLimited > 0) && <p>预热不足 {stats.warming ?? 0} 分钟 · 数据受限 {stats.dataLimited ?? 0} 分钟。缺开盘价仅停用影线证据，缺指数则暂停该分钟标点。</p>}
        {closest ? <p>最高候选：{time(closest.at)} · {closest.price.toFixed(2)} · {closest.template ? TEMPLATE_LABELS[closest.template] : "规则评估"}。{closest.blockers.length ? closest.blockers.join("；") : closest.score < 85 ? "过滤通过，分数未达85" : "量化条件满足"}</p> : <p>尚无有效价格偏离候选。</p>}
        {stats.bestUnblocked && stats.bestUnblocked.at !== closest?.at && <p>通过过滤的最高候选：{time(stats.bestUnblocked.at)} · {stats.bestUnblocked.price.toFixed(2)} · {stats.bestUnblocked.score.toFixed(1)} 分</p>}
        {reasons.length > 0 && <><b>候选被过滤的原因（可重叠）</b><ul>{reasons.map(([reason, count]) => <li key={reason}>{reason}：{count} 次</li>)}</ul></>}
      </div>
    </details>;
  })}</div>;
}

export function SignalScores({ assessments }: { assessments: SignalAssessment[] }) {
  if (!assessments.length) return null;
  return <div className="signal-scores"><div className="score-caption">最近一次因果评估 · 85 分门槛</div>{assessments.map(a => <details key={a.type}>
    <summary><span>{a.type === "HIGH" ? "阻力条件" : "支撑条件"}</span><strong className={a.score >= 85 ? "score-passed" : ""}>{a.score.toFixed(1)}<small> / 100</small></strong><span className="score-status">{a.blockers.length ? "已过滤" : a.score >= 85 ? "条件达标" : "分数不足"}</span></summary>
    <ScoreBreakdown groups={a.groups} />
    {!!a.missing?.length && <div className="score-blockers">{a.missing.join("；")}</div>}
    {a.blockers.length > 0 && <div className="score-blockers"><b>未打点原因</b><ul>{a.blockers.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
  </details>)}</div>;
}

export function ScoreBreakdown({ groups }: { groups: ScoreGroup[] }) {
  return <div className="score-breakdown">{groups.map(g => <div className="score-factor" key={g.name}><div><span>{g.name}</span><b>{g.score.toFixed(1)} / {g.max}</b></div><div className="score-track"><i style={{ width: `${Math.min(100, g.score / g.max * 100)}%` }} /></div><small>{g.detail}</small></div>)}</div>;
}
