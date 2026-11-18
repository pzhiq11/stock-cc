"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { ArrowUpRight, FileText, RefreshCw } from "lucide-react";
import { Frame, Empty } from "./frame";
import { usePoll } from "./use-poll";
import { REPORT_LABELS, REPORT_TYPES, type ReportType, type StoredReport } from "@/lib/types";
import { time } from "@/lib/format";

export function ReportsPage() {
  const p = useSearchParams(); const symbol = p.get("symbol") || "";
  const [type, setType] = useState<ReportType | "">(""), [date, setDate] = useState(""), [revision, setRevision] = useState(0);
  const url = `/api/reports?${new URLSearchParams({ ...(symbol ? { symbol } : {}), ...(type ? { type } : {}), ...(date ? { date } : {}) })}`;
  const { data, loading, error } = usePoll<{ reports: StoredReport[] }>(url, 30000, revision, true);
  return <Frame active="reports" symbol={symbol || undefined}><div className="page-heading"><div><div className="eyebrow">RESEARCH / JOURNAL</div><h1>每一次判断，都留下依据</h1><p>回看公司研究、竞价研判和盘后复盘。新分析保存为独立版本。</p></div><button className="button subtle" onClick={() => setRevision(i => i + 1)}><RefreshCw size={15} />刷新报告</button></div><div className="report-filters"><div className="tab-group"><button className={!type ? "selected" : ""} onClick={() => setType("")}>全部报告</button>{REPORT_TYPES.map(t => <button key={t} className={type === t ? "selected" : ""} onClick={() => setType(t)}>{REPORT_LABELS[t]}</button>)}</div><label>交易日期 <input aria-label="筛选交易日期" type="date" value={date} onChange={e => setDate(e.target.value)} /></label></div>{symbol && <div className="filter-caption">当前股票：{symbol} <Link href="/reports">查看全部股票</Link></div>}{error && <div className="error-banner">{error}</div>}<section className="card report-list-card">{!data?.reports.length ? <Empty title={loading ? "正在读取报告" : "还没有保存的分析报告"} description={type || date ? "当前筛选条件下暂无记录。" : "配置模型后，在股票工作台生成研究；服务持续运行时会尝试生成竞价和盘后报告。"} /> : <div className="reports-list">{data.reports.map(r => <Link className="report-list-item" key={r.id} href={`/reports/${r.id}`}><span className="report-file"><FileText size={21} /></span><div><div className="report-row-meta"><span>{REPORT_LABELS[r.type]}</span><span>{r.symbol} · {r.tradeDate} · V{r.version}</span></div><h2>{r.content.title}</h2><p>{r.content.summary}</p><small>{r.model} · 生成 {time(r.createdAt)} · {r.sources.length} 项来源</small></div><ArrowUpRight size={18} /></Link>)}</div>}</section><p className="muted list-limit">展示最近 50 条匹配报告；可按股票、类型或交易日期筛选。</p></Frame>;
}
