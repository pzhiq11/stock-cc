"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Building2,
  ChevronRight,
  CircleHelp,
  Clock3,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import { Frame, Empty, Stat, type Watch } from "./frame";
import { StockChart } from "./stock-chart";
import { ReplayScores, ScoreBreakdown, SignalScores } from "./signal-scores";
import { Modal } from "./modal";
import { ReportView } from "./report-view";
import { usePoll } from "./use-poll";
import { compact, percent, price, request, time } from "@/lib/format";
import {
  minuteOfDay,
  SESSION_LABELS,
  tradeDate,
  type Session,
} from "@/lib/time";
import {
  REGIME_LABELS,
  REPORT_LABELS,
  REPORT_TYPES,
  type Bar,
  type Company,
  type Context,
  type Evidence,
  type Intraday,
  type Point,
  type Quote,
  type ReportType,
  type SignalState,
  type StoredReport,
} from "@/lib/types";

type QuoteData = {
  quote: Quote;
  session: Session;
  calendar: { date: string; isTradingDay: boolean | null; next: string | null };
};
const reportHint: Record<ReportType, string> = {
  COMPANY_RESEARCH:
    "结合公司资料、估值、公告索引和价格背景，形成有来源的研究摘要。",
  AUCTION_OUTLOOK:
    "可随时触发，只使用早盘竞价历史及当时的相关板块、指数数据，缺失数据会明确标注。",
  POST_CLOSE_REVIEW:
    "收盘后结合完整分时、市场环境和当天实时确认记录，复盘走势与风险。",
  NEXT_SESSION_OUTLOOK:
    "收盘后给出偏强、震荡、偏弱三种条件情景，并标明下一交易日。",
};

export function Dashboard({ symbol }: { symbol: string }) {
  const [revision, setRevision] = useState(0),
    [watchRevision, setWatchRevision] = useState(0);
  const [view, setView] = useState<"intraday" | "daily">("intraday"),
    [days, setDays] = useState(60);
  const [selected, setSelected] = useState<Point | null>(null),
    [help, setHelp] = useState(false);
  const [reportType, setReportType] = useState<ReportType>("COMPANY_RESEARCH");
  const [working, setWorking] = useState(false),
    [actionError, setActionError] = useState(""),
    [notice, setNotice] = useState("");
  const [reportErrors, setReportErrors] = useState<Partial<Record<ReportType, string>>>({}),
    [autoWorking, setAutoWorking] = useState(false),
    [generatingType, setGeneratingType] = useState<ReportType | null>(null);
  const [starred, setStarred] = useState(false);
  const quoteData = usePoll<QuoteData>(
    `/api/stocks/${symbol}?view=quote`,
    3000,
    revision,
  );
  const minutes = usePoll<Intraday>(
    `/api/stocks/${symbol}?view=intraday`,
    5000,
    revision,
  );
  const daily = usePoll<{ bars: Bar[] }>(
    `/api/stocks/${symbol}?view=daily`,
    60000,
    revision,
  );
  const environment = usePoll<Context>(
    `/api/stocks/${symbol}?view=context`,
    20000,
    revision,
  );
  const companyData = usePoll<{
    company: Company | null;
    news: Evidence[];
    missing: string[];
  }>(`/api/stocks/${symbol}?view=company`, 300000, revision);
  const signals = usePoll<SignalState>(
    `/api/signals/${symbol}`,
    3000,
    revision,
  );
  const reports = usePoll<{ reports: StoredReport[]; generating: boolean }>(
    `/api/reports?symbol=${symbol}`,
    30000,
    revision,
    true,
  );
  const settings = usePoll<{
    prefs: { sound?: boolean };
    llm: { configured: boolean };
  }>("/api/settings", 0, revision);
  const seen = useRef<Set<string> | null>(null);
  const reportAttempts = useRef(new Set<string>()),
    reportInFlight = useRef(false),
    manualReportInFlight = useRef(false),
    reportAbort = useRef<AbortController | null>(null);
  const q = quoteData.data?.quote,
    state = signals.data,
    company = companyData.data?.company;
  const points = [
    ...(state?.highPoints ?? []),
    ...(state?.lowPoints ?? []),
  ].sort((a, b) => a.confirmedAt - b.confirmedAt);
  const currentReport = reports.data?.reports.find(
    (r) => r.type === reportType,
  );
  const reportBusy = working || autoWorking || reports.data?.generating === true;
  const reportBlocked = (() => {
    if (reportType === "COMPANY_RESEARCH" || reportType === "AUCTION_OUTLOOK") return "";
    const day = quoteData.data?.calendar, date = tradeDate(), minute = minuteOfDay();
    if (!day || day.date !== date) return "正在核验今日交易日历，请稍候。";
    if (day.isTradingDay !== true) return "今日不是已核验的交易日，暂不能生成当日走势分析。";
    if (minute < 900) return "收盘复盘和下一交易日计划需在今日 15:00 收盘后生成。";
    if (!minutes.data?.complete || minutes.data.date !== date) return "正在等待今日完整收盘分时数据，请稍后刷新。";
    if (!q?.sourceAt || tradeDate(q.sourceAt) !== date) return "当前报价尚未核验为今日数据，暂不能生成当日报告。";
    if (reportType === "NEXT_SESSION_OUTLOOK" && !day.next) return "下一交易日日历尚未核验，暂不能生成日期敏感预测。";
    return "";
  })();
  const validChartPoints = minutes.data
    ? points.filter(
        (p) =>
          new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Shanghai",
          }).format(new Date(p.pivotAt)) === minutes.data!.date,
      )
    : [];

  useEffect(() => {
    const c = new AbortController();
    void request("/api/monitoring", {
      method: "PUT",
      body: JSON.stringify({ symbol }),
      signal: c.signal,
    }).catch((e) => {
      if (!c.signal.aborted) setActionError(e.message);
    });
    return () => c.abort();
  }, [symbol]);
  useEffect(
    () => () => {
      reportAbort.current?.abort();
    },
    [symbol],
  );
  useEffect(() => {
    if (
      document.hidden ||
      !settings.data?.llm.configured ||
      !reports.data ||
      quoteData.data?.calendar.isTradingDay !== true ||
      reportInFlight.current ||
      working
    )
      return;
    const minute = minuteOfDay(),
      date = tradeDate();
    const types: ReportType[] =
      minute >= 910
        ? ["AUCTION_OUTLOOK", "POST_CLOSE_REVIEW", "NEXT_SESSION_OUTLOOK"]
        : minute >= 565 ? ["AUCTION_OUTLOOK"] : [];
    const tasks = types.filter(
      (type) =>
        !reports.data!.reports.some(
          (r) => r.type === type && r.tradeDate === date,
        ) && !reportAttempts.current.has(`${symbol}:${date}:${type}`),
    );
    if (!tasks.length) return;
    const controller = new AbortController();
    reportAbort.current = controller;
    reportInFlight.current = true;
    setAutoWorking(true);
    void (async () => {
      try {
        for (const type of tasks) {
          if (controller.signal.aborted || document.hidden) break;
          reportAttempts.current.add(`${symbol}:${date}:${type}`);
          setGeneratingType(type);
          setReportErrors(old => ({ ...old, [type]: "" }));
          try {
            await request("/api/reports", {
              method: "POST",
              body: JSON.stringify({ symbol, type }),
              signal: controller.signal,
            });
          } catch (e) {
            if (!controller.signal.aborted)
              setReportErrors(old => ({ ...old, [type]: e instanceof Error ? e.message : "页面分析未完成，可手动重试" }));
          }
        }
        if (!controller.signal.aborted) setRevision((i) => i + 1);
      } finally {
        reportInFlight.current = false;
        setAutoWorking(false);
        setGeneratingType(null);
      }
    })();
    // 行情刷新不会中断已发出的请求；页面关闭后不再启动下一项分析。
  }, [
    symbol,
    reports.data,
    quoteData.data,
    settings.data?.llm.configured,
    working,
  ]);
  useEffect(() => {
    if (!signals.data) return;
    const all = [...signals.data.highPoints, ...signals.data.lowPoints];
    if (!seen.current) {
      seen.current = new Set(all.map((p) => p.id));
      return;
    }
    const fresh = all.filter(
      (p) =>
        !seen.current!.has(p.id) &&
        p.mode === "live" &&
        Date.now() - (p.recordedAt ?? p.confirmedAt) <= 30000,
    );
    all.forEach((p) => seen.current!.add(p.id));
    if (!fresh.length) return;
    const p = fresh.at(-1)!;
    setNotice(
      `${p.type === "HIGH" ? "阻力" : "支撑"}观察点已确认 · ${p.pivotPrice} · ${time(p.confirmedAt, true)}`,
    );
    if (settings.data?.prefs.sound) {
      try {
        const ctx = new AudioContext();
        const oscillator = ctx.createOscillator(),
          gain = ctx.createGain();
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0.06, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        oscillator.frequency.value = 660;
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.35);
        oscillator.onended = () => {
          void ctx.close();
        };
      } catch {
        /* 浏览器尚未允许播放时保留视觉提醒。 */
      }
    }
  }, [signals.data, settings.data?.prefs.sound]);

  async function toggleWatch() {
    try {
      await request("/api/watchlist", {
        method: "PUT",
        body: JSON.stringify({
          action: starred ? "remove" : "add",
          symbol,
          name: q?.name,
        }),
      });
      setStarred(!starred);
      setWatchRevision((i) => i + 1);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "保存失败");
    }
  }
  async function generate() {
    if (manualReportInFlight.current || reportInFlight.current || reportBusy || reportBlocked) return;
    const type = reportType;
    manualReportInFlight.current = true;
    setWorking(true);
    setGeneratingType(type);
    setReportErrors(old => ({ ...old, [type]: "" }));
    try {
      await request<StoredReport>("/api/reports", {
        method: "POST",
        body: JSON.stringify({
          symbol,
          type,
          force: true,
          requestId: crypto.randomUUID(),
        }),
        signal: AbortSignal.timeout(185000),
      });
      setRevision((i) => i + 1);
    } catch (e) {
      const message = e instanceof Error && ["TimeoutError", "AbortError"].includes(e.name) ? "报告请求超时，请稍后重试。" : e instanceof Error ? e.message : "报告未生成";
      setReportErrors(old => ({ ...old, [type]: message }));
    } finally {
      manualReportInFlight.current = false;
      setWorking(false);
      setGeneratingType(null);
    }
  }
  const watchChange = useRef((items: Watch[]) =>
    setStarred(items.some((w) => w.symbol === symbol)),
  ).current;
  function refresh() {
    void request("/api/monitoring", {
      method: "PUT",
      body: JSON.stringify({ symbol }),
    }).catch((e) => setActionError(e.message));
    setRevision((i) => i + 1);
    setWatchRevision((i) => i + 1);
  }

  return (
    <Frame
      symbol={symbol}
      refreshKey={watchRevision}
      onWatchlistChange={watchChange}
    >
      <div className="page-heading">
        <div>
          <div className="eyebrow">A-SHARE / STOCK WORKSPACE</div>
          <h1>专注一只股票，看清每次机会</h1>
          <p>从实时走势到公司研究，把观察依据放在一起。</p>
        </div>
        <button className="button subtle" onClick={refresh}>
          <RefreshCw size={15} />
          刷新数据
        </button>
      </div>
      {(actionError || quoteData.error) && (
        <div className="error-banner" role="alert">
          {actionError || quoteData.error}
          <button
            className="icon-button"
            onClick={() => {
              setActionError("");
              setRevision((i) => i + 1);
            }}
            aria-label="重试"
          >
            <RefreshCw size={15} />
          </button>
        </div>
      )}
      {notice && (
        <div className="info-banner toast" role="status">
          <ShieldCheck size={16} />
          {notice}
          <button
            className="icon-button"
            aria-label="关闭提醒"
            onClick={() => setNotice("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <div className="market-strip">
        {environment.data?.indices.map((index) => (
          <div className="market-item" key={index.symbol}>
            <span>{index.name}</span>
            <strong className={index.change >= 0 ? "up" : "down"}>
              {price(index.price)}
            </strong>
            <small className={index.change >= 0 ? "up" : "down"}>
              {percent(index.changePercent)}
            </small>
          </div>
        ))}
        {!environment.data?.indices.length && (
          <div className="market-item muted">
            {environment.loading
              ? "正在读取市场指数…"
              : environment.error || "市场指数暂不可用"}
          </div>
        )}
        <div className="market-industry">
          <span>{environment.data?.industry?.name || "行业背景"}</span>
          <small>
            {environment.data?.industry?.changePercent != null
              ? `${percent(environment.data.industry.changePercent)} · 时间未核验`
              : "板块行情暂缺"}
          </small>
        </div>
      </div>
      <section className="card quote-card">
        <div className="quote-main">
          <div>
            <div className="stock-name">
              <h2>{q?.name || symbol}</h2>
              <span className="tag neutral">
                {symbol.endsWith("SH")
                  ? "沪市"
                  : symbol.endsWith("BJ")
                    ? "北交所"
                    : "深市"}{" "}
                A 股
              </span>
              <button
                className={`icon-button star-button ${starred ? "starred" : ""}`}
                onClick={() => void toggleWatch()}
                title={starred ? "移出常看" : "加入常看"}
                aria-label={starred ? "移出常看" : "加入常看"}
              >
                <Star size={19} fill={starred ? "currentColor" : "none"} />
              </button>
            </div>
            <span className="stock-code">
              {symbol} <i />
              {company?.industry || "公司资料加载中"}
            </span>
          </div>
          <span className="session-tag">
            <i />
            {quoteData.data
              ? SESSION_LABELS[quoteData.data.session]
              : "正在读取行情"}
          </span>
        </div>
        <div className="quote-bottom">
          <div className={`price-block ${q && q.change >= 0 ? "up" : "down"}`}>
            <strong>{price(q?.price)}</strong>
            <span>
              {q && q.change > 0 ? "+" : ""}
              {price(q?.change)} <b>{percent(q?.changePercent)}</b>
            </span>
            <small>
              <Clock3 size={11} />
              行情时间 {time(q?.sourceAt, true)}
            </small>
          </div>
          <div className="quote-stats">
            <Stat label="今开" value={price(q?.open)} />
            <Stat label="最高" value={price(q?.high)} className="up" />
            <Stat label="最低" value={price(q?.low)} className="down" />
            <Stat label="昨收" value={price(q?.previousClose)} />
            <Stat label="成交额" value={compact(q?.amount)} />
            <Stat
              label="换手率"
              value={q?.turnover != null ? `${q.turnover.toFixed(2)}%` : "—"}
            />
            <Stat label="市盈率 TTM" value={price(q?.pe)} />
            <Stat label="总市值" value={compact(q?.marketCap)} />
          </div>
        </div>
      </section>
      <div className="workspace-grid">
        <section className="card chart-card">
          <div className="card-heading">
            <div className="tab-group">
              <button
                className={view === "intraday" ? "selected" : ""}
                onClick={() => setView("intraday")}
              >
                分时走势
              </button>
              <button
                className={view === "daily" ? "selected" : ""}
                onClick={() => setView("daily")}
              >
                日 K 线
              </button>
            </div>
            {view === "daily" ? (
              <div className="segmented">
                {[20, 60, 120].map((n) => (
                  <button
                    key={n}
                    className={days === n ? "selected" : ""}
                    onClick={() => setDays(n)}
                  >
                    {n} 日
                  </button>
                ))}
              </div>
            ) : (
              <div className="chart-legend">
                <span>
                  <i />
                  价格
                </span>
                <span>
                  <i className="gold" />
                  均价
                </span>
                <span className="muted">{minutes.data?.date}</span>
              </div>
            )}
          </div>
          {(view === "intraday" && !minutes.data) ||
          (view === "daily" && !daily.data?.bars.length) ? (
            <Empty
              title={
                view === "intraday"
                  ? minutes.loading
                    ? "正在读取分时"
                    : "分时暂不可用"
                  : daily.loading
                    ? "正在读取日 K"
                    : "日 K 暂不可用"
              }
              description={
                (view === "intraday" ? minutes.error : daily.error) ||
                "等待公开接口返回真实行情。"
              }
              icon="activity"
            />
          ) : (
            <StockChart
              view={view}
              intraday={minutes.data}
              bars={daily.data?.bars ?? []}
              previousClose={q?.previousClose ?? 0}
              signals={view === "intraday" ? validChartPoints : points}
              onPoint={setSelected}
              days={days}
            />
          )}
          <div className="chart-footnote">
            <span>
              <i className="legend-dot red-dot" />H 相对阻力{" "}
              <i className="legend-dot green-dot" />L 相对支撑
            </span>
            <span>
              {view === "intraday"
                ? "实时报价即时评估 · 历史分钟近似回放"
                : "前复权日 K · MA5 · 成交量"}
            </span>
          </div>
          {((minutes.error && view === "intraday") ||
            (daily.error && view === "daily")) && (
            <p className="inline-warning">
              {view === "intraday" ? minutes.error : daily.error} ·
              正在保留最近一次数据。
            </p>
          )}
        </section>
        <aside className="card signal-card">
          <div className="card-heading">
            <h2>
              <Activity size={17} />
              日内机会观察
            </h2>
            <button
              className="icon-button"
              aria-label="查看点位规则"
              onClick={() => setHelp(true)}
            >
              <CircleHelp size={16} />
            </button>
          </div>
          <div className="strategy-status">
            <span
              className={`tag ${state?.quality === "ready" ? "green" : "neutral"}`}
            >
              {state ? REGIME_LABELS[state.regime] : "监控连接中"}
            </span>
            <p>{signals.error || state?.message || "等待实时采样连接"}</p>
            <small>
              {state?.samples ?? 0} 根已完成分钟 K 线 ·{" "}
              {state?.quality === "ready"
                ? "指标就绪"
                : state?.quality === "stale"
                  ? "数据延迟"
                  : state?.quality === "unsupported"
                    ? "仅行情展示"
                    : "观察中"}
            </small>
          </div>
          <SignalScores assessments={state?.assessment ?? []} />
          {state?.coverage.lastAiVeto && (
            <p className="inline-warning">
              最近 AI 否决 · {time(state.coverage.lastAiVeto.triggerAt)} ·{" "}
              {state.coverage.lastAiVeto.summary}
            </p>
          )}
          <div className="signal-counts">
            <div>
              <ArrowUpRight size={15} />
              <span>相对阻力</span>
              <strong>
                {state?.highPoints.length ?? 0}
                <small> / 3</small>
              </strong>
            </div>
            <div>
              <ArrowDownLeft size={15} />
              <span>相对支撑</span>
              <strong>
                {state?.lowPoints.length ?? 0}
                <small> / 3</small>
              </strong>
            </div>
          </div>
          <div className="signal-list">
            {points.length ? (
              points.map((p) => (
                <button
                  className="signal-row"
                  key={p.id}
                  onClick={() => setSelected(p)}
                >
                  <span
                    className={`point-badge ${p.type === "HIGH" ? "red" : "green"}`}
                  >
                    {p.type === "HIGH" ? "H" : "L"}
                    {p.sequenceNo}
                  </span>
                  <span>
                    <strong>
                      {p.pivotPrice}
                      <small>
                        {p.riskEvents.length
                          ? "已失效"
                          : p.type === "HIGH"
                            ? "减仓观察"
                            : "建仓观察"}
                      </small>
                    </strong>
                    <small>
                      {time(p.pivotAt)} ·{" "}
                      {p.strategyVersion !== state?.strategyVersion
                        ? "旧策略保留"
                        : p.mode === "historical"
                          ? "历史因果回放"
                          : p.inputSnapshot.sourceKind === "minute-close" ? "分钟收盘触发" : "实时报价触发"}{" "}
                      · {p.ruleScore} 分
                    </small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              ))
            ) : (
              <div className="no-signals">
                <ShieldCheck size={26} />
                <strong>等待值得关注的拐点</strong>
                <p>
                  条件不足时保持空白。
                  <br />
                  每天每侧最多 3 个，允许没有信号。
                </p>
              </div>
            )}
          </div>
          <ReplayScores assessments={state?.coverage.replay?.assessments} />
          <div className="signal-disclaimer">
            当日回放至 {time(state?.coverage.replay?.to)} ·{" "}
            {state?.coverage.replay?.bars ?? 0} 根分钟线
            <br />
            85 分及全部过滤条件 · 不强制打满 3+3。
            <br />
            质量分数不是胜率；历史点不触发实时提醒。
          </div>
        </aside>
      </div>
      <section className="card ai-card">
        <div className="card-heading">
          <h2>
            <span className="ai-mark">
              <Sparkles size={16} />
            </span>
            AI 研究与决策背景
          </h2>
          <Link className="text-link" href={`/reports?symbol=${symbol}`}>
            报告历史 <ChevronRight size={14} />
          </Link>
        </div>
        <div className="report-tabs">
          {REPORT_TYPES.map((t) => (
            <button
              className={reportType === t ? "active" : ""}
              onClick={() => {
                setReportType(t);
              }}
              key={t}
            >
              {REPORT_LABELS[t]}
            </button>
          ))}
        </div>
        <div className="ai-body" aria-busy={reportBusy}>
          {(reportErrors[reportType] || reports.error) && <div className="error-banner" role="alert">{reportErrors[reportType] || reports.error}</div>}
          {currentReport ? (
            <ReportView report={currentReport} compact />
          ) : (
            <div className="ai-empty">
              <span className="ai-empty-icon">
                <Sparkles size={24} />
              </span>
              <div>
                <h3>
                  {settings.data?.llm.configured
                    ? "把当前信息整理成有依据的分析"
                    : "连接你的模型，开启 AI 研究"}
                </h3>
                <p>{reportHint[reportType]}</p>
                {settings.data && !settings.data.llm.configured && (
                  <Link className="text-link" href="/settings">
                    前往配置模型 <ArrowUpRight size={14} />
                  </Link>
                )}
              </div>
            </div>
          )}
          {reportBlocked && <div className="info-banner" role="status">{reportBlocked}</div>}
          <div className="ai-action">
            <span className="muted" role="status" aria-live="polite">
              {reportBusy
                ? `正在生成${generatingType ? REPORT_LABELS[generatingType] : "分析"}，准备证据并校验模型输出，通常需要几十秒…`
                : currentReport
                  ? "重新分析将保存一个新版本。"
                  : "每项结论都附带来源；缺失信息明确标注。"}
            </span>
            <button
              className="button primary"
              onClick={() => void generate()}
              disabled={reportBusy || !!reportBlocked || !settings.data?.llm.configured}
            >
              {reportBusy ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Sparkles size={15} />
              )}
              {reportBusy ? "正在生成" : reportBlocked ? "暂不可生成" : currentReport ? "生成新版本" : "生成分析"}
            </button>
          </div>
        </div>
      </section>
      <div className="company-grid">
        <section className="card company-card">
          <div className="card-heading">
            <h2>
              <Building2 size={17} />
              公司速览
            </h2>
            {company && (
              <a
                className="text-link"
                href={company.url}
                target="_blank"
                rel="noreferrer"
              >
                资料来源 <ExternalLink size={13} />
              </a>
            )}
          </div>
          {company ? (
            <div className="company-body">
              <h3>{company.name}</h3>
              <div className="company-tags">
                <span className="tag neutral">
                  {company.industry || "行业未提供"}
                </span>
                <span className="tag neutral">
                  {company.region || "地区未提供"}
                </span>
                {company.listedAt && (
                  <span className="tag neutral">上市 {company.listedAt}</span>
                )}
              </div>
              <p>
                {company.business || company.introduction || "暂无公司简介"}
              </p>
              {company.introduction && company.business && (
                <details>
                  <summary>公司简介</summary>
                  <p>{company.introduction}</p>
                </details>
              )}
              <small className="muted">
                {company.provider} · 采集 {time(company.fetchedAt)}
              </small>
            </div>
          ) : (
            <Empty
              title={
                companyData.loading ? "正在读取公司资料" : "公司资料暂不可用"
              }
              description={companyData.error || "公开接口暂未返回有效资料。"}
            />
          )}
        </section>
        <section className="card news-card">
          <div className="card-heading">
            <h2>近期公告</h2>
            <span className="muted">公开公告索引</span>
          </div>
          {companyData.data?.news.length ? (
            <div className="news-list">
              {companyData.data.news.slice(0, 5).map((n) => (
                <a href={n.url} target="_blank" rel="noreferrer" key={n.id}>
                  <span>
                    <b>{n.title}</b>
                    <small>
                      {n.publishedAt || "日期未提供"} · {n.publisher}
                    </small>
                  </span>
                  <ExternalLink size={13} />
                </a>
              ))}
            </div>
          ) : (
            <Empty
              title="暂无可读公告索引"
              description="公告接口不可用时不会生成替代新闻。"
            />
          )}
          <p className="news-note">
            当前仅展示公告标题；AI 报告会注明未读取公告全文。
          </p>
        </section>
      </div>
      {selected && (
        <Modal
          title={`${selected.type === "HIGH" ? "相对阻力" : "相对支撑"} ${selected.sequenceNo} · 确认依据`}
          onClose={() => setSelected(null)}
        >
          <div className="point-detail">
            <div className="point-detail-price">
              <strong className={selected.type === "HIGH" ? "up" : "down"}>
                {selected.pivotPrice}
              </strong>
              <span>
                {selected.riskEvents.length ? "已追加失效事件" : "已确认观察点"}
              </span>
            </div>
            <dl className="detail-grid">
              <dt>判断时刻</dt>
              <dd>{time(selected.pivotAt, true)}</dd>
              <dt>点位来源</dt>
              <dd>
                {selected.mode === "historical"
                  ? "历史因果回放"
                  : selected.mode === "live"
                    ? "实时报价即时评估"
                    : "旧策略保留"}
              </dd>
              <dt>实际保存时间</dt>
              <dd>{time(selected.recordedAt ?? selected.confirmedAt, true)}</dd>
              <dt>触发时的实际报价</dt>
              <dd>{selected.quoteAtConfirmation}</dd>
              <dt>触发到最终确认</dt>
              <dd>
                {selected.mode === "historical"
                  ? "历史实际到达延迟无法复原"
                  : `${((selected.confirmedAt - selected.pivotAt) / 1000).toFixed(1)} 秒`}
              </dd>
              <dt>规则分数</dt>
              <dd>{selected.ruleScore} / 100（非胜率）</dd>
              <dt>当时结构</dt>
              <dd>{REGIME_LABELS[selected.regime]}</dd>
            </dl>
            {selected.inputSnapshot.groups && (
              <ScoreBreakdown groups={selected.inputSnapshot.groups} />
            )}
            <h3>确认依据</h3>
            {selected.ai && (
              <div className="info-banner">
                <Sparkles size={16} />
                <div>
                  <strong>
                    {selected.ai.status === "approved"
                      ? "AI 复核通过"
                      : selected.ai.status === "historical_skipped"
                        ? "历史分钟近似回放"
                        : "量化结果确认"}
                  </strong>
                  <p>{selected.ai.summary}</p>
                  {selected.ai.risks.map((risk, i) => (
                    <p key={i}>{risk}</p>
                  ))}
                  {selected.mode === "live" && (
                    <small>
                      AI 耗时{" "}
                      {(
                        (selected.ai.finishedAt - selected.ai.startedAt) /
                        1000
                      ).toFixed(1)}{" "}
                      秒 · {selected.ai.model || "未配置模型"}
                    </small>
                  )}
                </div>
              </div>
            )}
            <ul>
              {selected.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            <div className="info-banner">
              {selected.type === "HIGH" ? "持续突破" : "持续跌破"}{" "}
              {selected.invalidationRule.price.toFixed(2)}{" "}
              时追加失效提示，原点保留。
              {selected.pairWithPointId
                ? "已与在线确认的反向观察点配对。"
                : "尚无可关联的反向观察点。"}
            </div>
            {selected.riskEvents.map((e, i) => (
              <p className="inline-warning" key={i}>
                {time(e.at, true)} · {e.price} · {e.reason}
              </p>
            ))}
            <details>
              <summary>指标证据与缺失项</summary>
              <p>
                {selected.dataProfile} · {selected.strategyVersion}
              </p>
              <p>{selected.inputSnapshot.missing.join("；")}</p>
              <pre>
                {JSON.stringify(
                  selected.inputSnapshot.features ??
                    selected.inputSnapshot.samples.slice(-12),
                  null,
                  2,
                )}
              </pre>
            </details>
          </div>
        </Modal>
      )}
      {help && (
        <Modal title="日内点位如何确认" onClose={() => setHelp(false)}>
          <div className="help-content">
            <p>
              每次取得新报价，立即结合当时价格、盘口、布林、KDJ、MACD、VWAP、已知支撑阻力和五分钟趋势评估。不等待下一根分钟线收盘，不设置反转等待窗口。
            </p>
            <p>
              质量分至少
              85，并通过波段规模、剩余空间、即时承接或抛压、趋势和数据新鲜度等全部过滤后，立即请求
              AI 快速复核。最多等待 5 秒；AI
              明确否决则不打点，超时、异常或未配置时使用量化结果。期间报价采样持续运行；若机会已过期或发生明显变化则跳过。
            </p>
            <p>
              图上记录触发时刻与当时报价，详情另列最终确认时间和 AI
              耗时。只使用触发时已取得的数据，不把后来的反转回画到先前极值。历史补点仅按分钟收盘近似回放，不调用当前
              AI 或补造历史秒级盘口。
            </p>
            <p>
              强上涨保护逆势阻力点，强下跌保护逆势支撑点。每侧每天最多 3
              个，允许为
              0；旧点继续占用当日配额。没有固定价差或冷却时间，同一结构机会仅触发一次，离开价格偏离区后再评估。
            </p>
            <p>
              免费行情自身的更新频率和网络耗时仍会影响提醒速度。85
              分是规则证据分，需要持续验证效果。
            </p>
          </div>
        </Modal>
      )}
    </Frame>
  );
}
