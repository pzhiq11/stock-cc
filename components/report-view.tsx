"use client";
import Link from "next/link";
import { ExternalLink, FileCheck2 } from "lucide-react";
import { REPORT_LABELS, type StoredReport } from "@/lib/types";
import { time } from "@/lib/format";

export function ReportView({ report, compact = false }: { report: StoredReport; compact?: boolean }) {
  function source(ids: string[]) { return <div className="citation-list">{ids.map(id => { const e = report.sources.find(s => s.id === id); return e ? <a href={safeUrl(e.url)} key={id} target={e.url.startsWith("/") ? undefined : "_blank"} rel="noreferrer">{e.title}<ExternalLink size={10} /></a> : null; })}</div>; }
  return <article className="report-content">
    <div className="report-meta"><span><FileCheck2 size={13} />{REPORT_LABELS[report.type]} · V{report.version}</span><span>{report.tradeDate} {time(report.createdAt)} · {report.model}</span></div>
    <h2>{report.content.title}</h2><p className="report-summary">{report.content.summary}</p>
    {report.type === "AUCTION_OUTLOOK" && report.inputSummary.analysisBasis === "auction-snapshot" && <div className="info-banner">竞价快照截止：{report.tradeDate} {time(String(report.inputSummary.dataCutoffAt))}。生成于 {time(report.createdAt)}，仅依据开盘前竞价及同一时段的板块、指数数据研判。</div>}
    {report.targetDate && <div className="info-banner">情景适用日期：{report.targetDate}（已核验交易日历）</div>}
    {(compact ? report.content.sections.slice(0, 2) : report.content.sections).map((s, i) => <section className="research-section" key={i}><h3>{s.title}</h3><p>{s.body}</p>{source(s.evidenceIds)}</section>)}
    {!compact && report.content.scenarios.length > 0 && <div className="scenario-grid">{report.content.scenarios.map((s, i) => <section className="scenario" key={i}><span className={`tag ${s.direction === "偏强" ? "red" : s.direction === "偏弱" ? "green" : "neutral"}`}>{s.direction}</span><p>{s.description}</p><dl><dt>触发条件</dt><dd>{s.trigger}</dd><dt>失效条件</dt><dd>{s.invalidation}</dd>{s.levels.length > 0 && <><dt>观察价格</dt><dd>{s.levels.join("；")}</dd></>}</dl>{source(s.evidenceIds)}</section>)}</div>}
    {!compact && <div className="report-notes"><div><h3>风险与边界</h3><ul>{report.content.risks.map((r, i) => <li key={i}>{r}</li>)}</ul></div><div><h3>缺失信息</h3><ul>{report.content.missing.map((r, i) => <li key={i}>{r}</li>)}</ul></div></div>}
    {compact ? <Link className="text-link" href={`/reports/${report.id}`}>查看完整报告与来源 <ExternalLink size={13} /></Link> : <details className="source-details"><summary>证据快照与生成信息 · {report.sources.length} 项来源</summary><p className="muted">数据截止：{String(report.inputSummary.dataCutoffAt ?? "—")}。报告保存后不覆盖，新的分析生成独立版本。</p>{report.sources.map(e => <div className="source-item" key={e.id}><a href={safeUrl(e.url)} target="_blank" rel="noreferrer">{e.title} <ExternalLink size={12} /></a><small>{e.publisher} · 发布 {e.publishedAt ?? "未提供"} · 采集 {e.fetchedAt}</small><p>{e.summary}</p></div>)}</details>}
  </article>;
}
function safeUrl(url: string) { return url.startsWith("/") && !url.startsWith("//") || /^https?:\/\//.test(url) ? url : "#"; }
