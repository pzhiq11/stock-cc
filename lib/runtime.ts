import { db } from "@/lib/db";
import { appSettings } from "@/lib/settings";
import { calendar } from "@/lib/market/calendar";
import { getDaily, getMinuteHistory, getQuotes } from "@/lib/market/provider";
import { isEquity, normalizeSymbol } from "@/lib/market/symbol";
import { minuteOfDay, sessionAt, tradeDate } from "@/lib/time";
import type { Observation, Point, PointType, Quote, ReplayAssessment, SignalState } from "@/lib/types";
import { backgroundUsable, CausalEngine, consecutiveBars, PARAMETERS, signalMinute, STRATEGY_VERSION, type EngineState } from "@/lib/analysis/engine";
import { emptyReplayAssessments, recordReplayAssessment, replayFrames } from "@/lib/analysis/replay";
import { appendPoint, asPoints, invalidateFromBars, invalidatePoints } from "@/lib/analysis/store";
import { acquireRequest, releaseRequest, requestRefresh, saveMonitor, type RequestOwner, type RequestState } from "@/lib/analysis/request-state";
import { reviewPoint } from "@/lib/analysis/signal-ai";

type HandledPoint = Pick<Point, "id" | "type" | "pivotAt">;
type Snapshot = { version: "request-db-v1"; engine: EngineState; minuteEngine: EngineState; replayAssessments: Record<PointType, ReplayAssessment>; handled: HandledPoint[]; quality: SignalState["quality"]; monitoredSince: number; latest: Quote | null; lastObservedAt: number | null; historyChecked: boolean; bootstrapped: boolean; offHoursRefreshKey: string | null; lastQuoteAttempt: number; lastMinuteAttempt: number; refreshSeenAt: number; pendingAi: SignalState["pendingAi"]; pendingPoint: HandledPoint | null; marketSamples: Observation[]; missing: string[] };
type Live = Omit<Snapshot, "version" | "engine" | "minuteEngine" | "handled"> & { symbol: string; date: string; request: RequestOwner; engine: CausalEngine; minuteEngine: CausalEngine; handled: Map<string, HandledPoint>; replayReset: boolean; strategyMatches: boolean; coverage: SignalState["coverage"] };
type DayRow = { highPoints: unknown; lowPoints: unknown; strategy: unknown; coverage: unknown; runtime: unknown };
// 只清除开发热更新遗留的旧定时器；业务状态不再挂在 globalThis。
const legacy = globalThis as unknown as { stocklensRuntime?: { timer?: ReturnType<typeof setInterval> } };
if (legacy.stocklensRuntime?.timer) clearInterval(legacy.stocklensRuntime.timer);
delete legacy.stocklensRuntime;
const indexFor = (symbol: string) => symbol.startsWith("30") ? "399006.SZ" : symbol.endsWith("SZ") ? "399001.SZ" : "000001.SH";
function observation(q: Quote): Observation { return { at: q.sourceAt ?? 0, availableAt: q.observedAt, price: q.price, volume: q.volume, amount: q.amount, bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize, marketReturn: q.changePercent, dayHigh: q.high, dayLow: q.low }; }
function holdPoint(live: Live, p: HandledPoint) { const saved = { id: p.id, type: p.type, pivotAt: p.pivotAt }; live.handled.set(p.id, saved); live.engine.hold(saved); live.minuteEngine.hold(saved); }
function releasePoint(live: Live, p: HandledPoint) { live.handled.delete(p.id); live.engine.release(p); live.minuteEngine.release(p); }
function restorePoints(live: Live, high: Point[], low: Point[]) { live.engine.restore(high, low); live.minuteEngine.restore(high, low); }
function pointAlreadySaved(p: HandledPoint, saved: { high: Point[]; low: Point[] }) { return [...saved.high, ...saved.low].some(s => s.id === p.id || s.type === p.type && s.pivotAt === p.pivotAt); }
function snapshot(live: Live): Snapshot {
  return { version: "request-db-v1", engine: live.engine.snapshot(), minuteEngine: live.minuteEngine.snapshot(false), replayAssessments: live.replayAssessments, handled: [...live.handled.values()], quality: live.quality, monitoredSince: live.monitoredSince, latest: live.latest, lastObservedAt: live.lastObservedAt, historyChecked: live.historyChecked, bootstrapped: live.bootstrapped, offHoursRefreshKey: live.offHoursRefreshKey, lastQuoteAttempt: live.lastQuoteAttempt, lastMinuteAttempt: live.lastMinuteAttempt, refreshSeenAt: live.refreshSeenAt, pendingAi: live.pendingAi, pendingPoint: live.pendingPoint, marketSamples: live.marketSamples.slice(-20), missing: live.missing };
}
async function persist(live: Live, coverage?: SignalState["coverage"]) { await saveMonitor(live.symbol, live.date, live.request, snapshot(live), coverage); }
function resume(live: Live) { live.monitoredSince = Date.now(); live.replayReset = true; live.engine.reset("页面恢复，补取因果分钟背景后继续观察"); }
function createLive(symbol: string, date: string, row: DayRow, request: RequestOwner): Live {
  const runtime = row.runtime as RequestState, saved = runtime.monitor as Snapshot | undefined;
  const engine = new CausalEngine(symbol), minuteEngine = new CausalEngine(symbol);
  const restored = saved?.version === "request-db-v1" && engine.hydrate(saved.engine) && minuteEngine.hydrate(saved.minuteEngine, saved.engine);
  const live: Live = { symbol, date, request, engine, minuteEngine, replayReset: false, replayAssessments: emptyReplayAssessments(), handled: new Map(), strategyMatches: (row.strategy as { version?: string }).version === STRATEGY_VERSION, quality: "warming", monitoredSince: Date.now(), latest: null, lastObservedAt: null, historyChecked: false, bootstrapped: false, offHoursRefreshKey: null, lastQuoteAttempt: 0, lastMinuteAttempt: 0, refreshSeenAt: 0, pendingAi: null, pendingPoint: null, marketSamples: [], coverage: row.coverage as SignalState["coverage"], missing: ["板块实时因子时间未核验，未参与评分"] };
  if (restored && saved) {
    const { version: _version, engine: _engine, minuteEngine: _minute, handled, ...metadata } = saved;
    Object.assign(live, metadata); live.handled = new Map(handled.map(p => [p.id, p]));
  }
  const points = { high: asPoints(row.highPoints), low: asPoints(row.lowPoints) };
  restorePoints(live, points.high, points.low);
  // 前一个请求中断后，未保存且未知 AI 结果的预留不能永久占用机会。
  if (live.pendingPoint && !pointAlreadySaved(live.pendingPoint, points)) releasePoint(live, live.pendingPoint);
  live.pendingAi = null; live.pendingPoint = null;
  const veto = live.coverage.lastAiVeto;
  if (veto) holdPoint(live, { id: `veto:${veto.type}:${veto.triggerAt}`, type: veto.type, pivotAt: veto.triggerAt });
  if (live.bootstrapped && Date.now() - live.lastQuoteAttempt > PARAMETERS.freshnessMs) resume(live);
  if ((runtime.refreshRequestedAt ?? 0) > live.refreshSeenAt) { live.refreshSeenAt = runtime.refreshRequestedAt!; live.offHoursRefreshKey = null; live.lastMinuteAttempt = 0; }
  return live;
}

export async function monitor(symbol: string) {
  const s = normalizeSymbol(symbol);
  if (!isEquity(s)) throw new Error("仅支持 A 股股票，不支持指数或 ETF 作为分析对象。");
  const settings = await appSettings();
  if (settings.lastStock !== s) await db().appSetting.update({ where: { id: 1 }, data: { lastStock: s } });
  await requestRefresh(s, tradeDate());
}
export async function currentSymbol() { return (await appSettings()).lastStock; }
export async function currentQuote(symbol: string): Promise<Quote | null> {
  const row = await db().dailySignal.findUnique({ where: { symbol_tradeDate: { symbol, tradeDate: tradeDate() } } });
  return ((row?.runtime as RequestState | undefined)?.monitor as Snapshot | undefined)?.latest ?? null;
}
export async function signalState(symbol: string, date = tradeDate()): Promise<SignalState> {
  if (!isEquity(symbol)) throw new Error("仅支持 A 股股票分析。");
  if (date === tradeDate()) {
    const acquired = await acquireRequest(symbol, date, "signal", 90000);
    if (acquired.acquired) {
      const live = createLive(symbol, date, acquired.row, acquired.request);
      try {
        if (Date.now() - live.lastQuoteAttempt >= 800 || !live.bootstrapped) { await poll(live); await persist(live); }
      } finally { await releaseRequest(symbol, date, acquired.request); }
    }
  }
  const row = await db().dailySignal.findUnique({ where: { symbol_tradeDate: { symbol, tradeDate: date } } });
  const runtime = row?.runtime as RequestState | undefined, saved = runtime?.monitor as Snapshot | undefined;
  const busy = (runtime?.leases?.signal?.until ?? 0) > Date.now();
  const decision = saved?.engine.assessment.length ? saved.engine : saved?.minuteEngine;
  return { symbol, date, highPoints: asPoints(row?.highPoints), lowPoints: asPoints(row?.lowPoints), quality: saved?.quality ?? "warming", regime: decision?.regime ?? "UNCERTAIN", message: busy ? saved?.pendingAi ? `量化 ${saved.pendingAi.score} 分，AI 正在复核，最多5秒` : "当前请求正在计算，下一轮读取结果" : saved?.engine.message ?? decision?.message ?? "打开页面后加载行情背景", samples: saved?.engine.bars?.length ?? 0, monitoredSince: saved?.monitoredSince ?? null, lastObservedAt: saved?.lastObservedAt ?? null, missing: saved?.missing ?? [], assessment: decision?.assessment ?? [], strategyVersion: (row?.strategy as { version?: string } | undefined)?.version, pendingAi: busy ? saved?.pendingAi ?? null : null, coverage: row?.coverage as SignalState["coverage"] ?? {} };
}

async function refreshBackground(live: Live) {
  if (Date.now() - live.lastMinuteAttempt < 10000) return;
  live.lastMinuteAttempt = Date.now();
  try {
    const [history, index, daily] = await Promise.allSettled([getMinuteHistory(live.symbol), getMinuteHistory(indexFor(live.symbol)), live.historyChecked ? Promise.resolve(null) : getDaily(live.symbol)]);
    if (!live.historyChecked) {
      if (daily.status === "rejected" || !daily.value || daily.value.filter(b => b.time < live.date).length < 20) { live.quality = "unsupported"; live.engine.message = "新上市、日K缺失或历史不足，暂不启用点位"; return; }
      live.historyChecked = true;
    }
    if (history.status === "rejected") throw history.reason;
    const now = Date.now(), frames = replayFrames(history.value.bars, index.status === "fulfilled" ? index.value.bars : [], now);
    const today = frames.filter(f => f.bar.time.slice(0, 10) === live.date);
    live.missing = ["板块实时因子时间未核验，未参与评分", ...history.value.missing, ...(index.status === "rejected" ? ["历史指数缺失，暂停新点位"] : [])];
    const firstLoad = !live.bootstrapped;
    if (live.replayReset) {
      live.minuteEngine = new CausalEngine(live.symbol); live.minuteEngine.restore(live.engine.highPoints, live.engine.lowPoints);
      for (const point of live.handled.values()) live.minuteEngine.hold(point);
      live.replayAssessments = emptyReplayAssessments(); live.replayReset = false;
    }
    for (let i = 0; i < frames.length; i++) {
      if (tradeDate() !== live.date) return;
      const frame = frames[i];
      live.engine.process(frame.bar, frame.market, { mode: "historical", now, emit: false, missing: live.missing });
      if (live.minuteEngine.bars.at(-1) && frame.bar.at <= live.minuteEngine.bars.at(-1)!.at) continue;
      const replay = frame.bar.time.startsWith(live.date) && (firstLoad || frame.bar.completedAt <= live.monitoredSince);
      const proposals = live.minuteEngine.process(frame.bar, frame.market, { mode: replay ? "historical" : "live", now, emit: frame.bar.time.startsWith(live.date), missing: live.missing });
      if (frame.bar.time.startsWith(live.date) && signalMinute(frame.bar)) for (const type of ["HIGH", "LOW"] as const) recordReplayAssessment(live.replayAssessments[type], frame.bar, live.minuteEngine.assessment.find(a => a.type === type), PARAMETERS.scoreThreshold, !frame.market);
      for (const point of proposals) {
        if (!live.strategyMatches || !live.historyChecked) { live.minuteEngine.release(point); continue; }
        holdPoint(live, point);
        if (!replay) { await finishPoint(live, point); continue; }
        try {
          const advice = await reviewPoint(point, live.symbol);
          const saved = await appendPoint(live.symbol, live.date, { ...point, ai: advice.ai }, live.request); restorePoints(live, saved.high, saved.low);
          if (!saved.accepted && !pointAlreadySaved(point, saved)) releasePoint(live, point);
        } catch (e) { releasePoint(live, point); throw e; }
      }
      if (i % 20 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    await invalidateFromBars(live.symbol, live.date, today.map(f => f.bar));
    const latest = await db().dailySignal.findUniqueOrThrow({ where: { symbol_tradeDate: { symbol: live.symbol, tradeDate: live.date } } });
    restorePoints(live, asPoints(latest.highPoints), asPoints(latest.lowPoints));
    const gaps = today.slice(1).flatMap((frame, i) => consecutiveBars(today[i].bar, frame.bar) ? [] : [{ from: today[i].bar.completedAt, to: frame.bar.at }]);
    const partial = !today.length || gaps.length > 0 || index.status === "rejected" || today.some(f => !f.market || f.bar.open === null) || live.replayAssessments.HIGH.warming > 0;
    live.coverage = { ...live.coverage, gaps, replay: { status: partial ? "partial" : "complete", bars: today.length, from: today[0]?.bar.completedAt ?? null, to: today.at(-1)?.bar.completedAt ?? null, fetchedAt: history.value.fetchedAt, message: "按当前策略顺序补算已完成分钟；只用当时及之前数据，不调用当前AI，不按全天结果挑选点位。缺失或预热不足见评估统计", assessments: live.replayAssessments } };
    live.bootstrapped = true; live.quality = live.engine.ready ? "ready" : "warming";
    await persist(live, { gaps: live.coverage.gaps, replay: live.coverage.replay });
  } catch (e) { live.quality = "stale"; live.engine.message = e instanceof Error ? e.message : "分钟背景接口暂不可用"; }
}

async function finishPoint(live: Live, proposal: Point) {
  live.pendingAi = { type: proposal.type, score: proposal.ruleScore, startedAt: Date.now() }; live.pendingPoint = { id: proposal.id, type: proposal.type, pivotAt: proposal.pivotAt };
  let vetoed = false;
  try {
    await persist(live);
    const advice = await reviewPoint(proposal, live.symbol);
    if (tradeDate() !== live.date) { releasePoint(live, proposal); return; }
    if (!advice.accepted) {
      vetoed = true;
      live.engine.message = `AI 否决该${proposal.type === "HIGH" ? "阻力" : "支撑"}机会：${advice.ai.summary}`;
      const lastAiVeto = { type: proposal.type, score: proposal.ruleScore, triggerAt: proposal.pivotAt, reviewedAt: advice.ai.finishedAt, summary: advice.ai.summary, model: advice.ai.model };
      live.coverage = { ...live.coverage, lastAiVeto };
      live.pendingAi = null; live.pendingPoint = null;
      await persist(live, { lastAiVeto }); return;
    }
    // 同一请求在 AI 后重新核对行情，避免依赖另一个实例的报价采样。
    const q = (await getQuotes([live.symbol])).find(q => q.symbol === live.symbol); live.latest = q ?? live.latest;
    const scale = Number(proposal.inputSnapshot.features?.waveScale ?? 0), price = Number(proposal.pivotPrice), direction = proposal.type === "HIGH" ? -1 : 1;
    if (!q?.sourceAt || Date.now() - q.sourceAt > PARAMETERS.freshnessMs || Date.now() - proposal.pivotAt > PARAMETERS.deadlineMs || direction * (q.price - price) > scale * .35 || (proposal.type === "HIGH" ? q.price > proposal.invalidationRule.price : q.price < proposal.invalidationRule.price)) { releasePoint(live, proposal); live.engine.message = "AI 返回时行情已过期或机会空间变化，本次跳过；下一有效事件重新评估"; return; }
    const saved = await appendPoint(live.symbol, live.date, { ...proposal, ai: advice.ai, confirmedAt: Date.now() }, live.request);
    restorePoints(live, saved.high, saved.low);
    if (!saved.accepted && !pointAlreadySaved(proposal, saved)) releasePoint(live, proposal);
    live.engine.message = saved.accepted ? advice.ai.status === "approved" ? `AI 复核通过，已即时标记${proposal.type === "HIGH" ? "阻力" : "支撑"}机会` : "AI 本次不可用，已按量化结果标点" : "配额或事件时序不满足，本次不标点";
  } catch (e) { if (!vetoed) releasePoint(live, proposal); live.engine.message = e instanceof Error ? e.message : "点位保存未完成"; }
  finally { live.pendingAi = null; live.pendingPoint = null; }
}

async function poll(live: Live) {
  try {
    const day = await calendar(), session = sessionAt(Date.now(), day.isTradingDay === true);
    if (day.isTradingDay === null) { live.quality = "unsupported"; live.engine.message = "交易日历未核验，正式点位暂停"; return; }
    if (day.isTradingDay === false) { live.engine.message = "非交易日，保留原点位与行情展示"; return; }
    if (session === "lunch" || session === "closed") {
      const minute = minuteOfDay(), settled = session === "lunch" ? minute >= 691 : minute >= 901;
      const refreshKey = `${session}:${settled ? "settled" : "initial"}`;
      if (live.offHoursRefreshKey !== refreshKey && Date.now() - live.lastMinuteAttempt >= 10000) { live.offHoursRefreshKey = refreshKey; await refreshBackground(live); }
      live.engine.message = session === "lunch" ? "午间休市，定时行情请求已暂停，13:00自动继续" : "非交易时段，定时行情请求已暂停，可手动刷新"; return;
    }
    await refreshBackground(live);
    live.lastQuoteAttempt = Date.now();
    const quotes = await getQuotes([live.symbol, "000001.SH", "399001.SZ", "399006.SZ"]), quote = quotes.find(q => q.symbol === live.symbol);
    if (!quote) throw new Error("未取得当前股票报价");
    live.latest = quote;
    if (!live.strategyMatches) { live.quality = "unsupported"; live.engine.message = "今日策略版本不匹配，保留已有点位"; return; }
    if (/ST|退市|^N|^C/.test(quote.name) || quote.exchange === "BJ") { live.quality = "unsupported"; live.engine.message = "该证券状态的策略尚未验证，保留行情展示"; return; }
    const index = quotes.find(q => q.symbol === indexFor(live.symbol));
    if (index?.sourceAt) { const sample = observation(index); if (!live.marketSamples.at(-1) || sample.at > live.marketSamples.at(-1)!.at) live.marketSamples.push(sample); live.marketSamples = live.marketSamples.slice(-20); }
    if ((session === "morning" || session === "afternoon") && live.bootstrapped && live.historyChecked) {
      const now = Date.now(), sample = observation(quote), market = live.marketSamples.filter(s => s.at <= sample.availableAt && s.availableAt <= sample.availableAt).at(-1) ?? null;
      const proposals = live.engine.observe(sample, now, { market, missing: live.missing });
      live.lastObservedAt = sample.availableAt; live.quality = quote.sourceAt && now - quote.sourceAt <= PARAMETERS.freshnessMs && backgroundUsable(live.engine.bars.at(-1), now) ? "ready" : "stale";
      if (proposals.length) { holdPoint(live, proposals[0]); await finishPoint(live, proposals[0]); }
      const changes = await invalidatePoints(live.symbol, live.date, live.engine.samples); if (changes) restorePoints(live, changes.high, changes.low);
    } else if (live.bootstrapped) live.engine.message = "竞价期间采集报价，连续交易开始后即时评估点位";
  } catch (e) { live.quality = "stale"; live.engine.message = e instanceof Error ? e.message : "行情采集暂不可用"; }
}
