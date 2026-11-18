import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { db } from "@/lib/db";
import { serializeReport } from "@/lib/analysis/reports";
import { Frame } from "@/components/frame";
import { ReportView } from "@/components/report-view";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const r = await db().analysisReport.findUnique({ where: { id: (await params).id } }); if (!r) notFound(); return <Frame active="reports" symbol={r.symbol}><div className="detail-page-heading"><Link className="text-link" href={`/reports?symbol=${r.symbol}`}><ArrowLeft size={15} />返回报告列表</Link><Link className="button subtle" href={`/stocks/${r.symbol}`}>打开股票 {r.symbol}</Link></div><section className="card full-report"><ReportView report={serializeReport(r)} /></section></Frame>; }
