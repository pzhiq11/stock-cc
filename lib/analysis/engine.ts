import { createHash } from "node:crypto";
import { ATR } from "technicalindicators";
import { minuteOfDay } from "@/lib/time";
import { TEMPLATE_LABELS, type MinuteBar, type Observation, type OpportunityTemplate, type Point, type PointType, type Regime, type SignalAssessment } from "@/lib/types";
import { calculateFeatures, liveFeatures, trendStrength, waveStructure, type Features } from "./indicators";
import { opportunityEvidence, opportunityGeometry } from "./opportunity";

export const STRATEGY_VERSION = "causal-realtime-v5.0";
export const PARAMETERS = { scoreThreshold: 85, deadlineMs: 30000, freshnessMs: 10000, backgroundFreshnessMs: 180000, aiTimeoutMs: 5000, indicatorWindow: 240, rsiPeriod: 14, bollingerPeriod: 20, kdjPeriod: 9, macd: [12, 26, 9], atrPeriod: 14, minRewardRisk: 1.5 };
type Excursion = { at: number; extreme: number; fired: boolean };
type HeldPoint = Pick<Point, "id" | "type" | "pivotAt"> & { exitedAt?: number };
export type EngineState = { version: 1; strategy: string; symbol: string; bars?: MinuteBar[]; marketBars?: MinuteBar[]; samples: Observation[]; candidates: Partial<Record<PointType, Excursion>>; regime: Regime; assessment: SignalAssessment[]; message: string; decisionAt: number; handled: string[]; holds: HeldPoint[] };
type Event = { at: number; price: number; now: number; mode: "historical" | "live"; bar?: MinuteBar; sample?: Observation; market: MinuteBar | null; marketSample?: Observation; missing: string[] };
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const round = (n: number) => Math.round(n * 10) / 10;
export function signalMinute(bar: MinuteBar) { return signalAt(bar.at); }
function signalAt(at: number) { const m = minuteOfDay(at); return (m >= 570 && m < 690) || (m >= 780 && m < 897); }
export function backgroundUsable(last: MinuteBar | undefined, at: number): boolean {
  if (!last || last.completedAt > at) return false;
  if (at - last.completedAt <= PARAMETERS.backgroundFreshnessMs) return true;
  const minute = minuteOfDay(at), day = new Date(at + 8 * 3600000).toISOString().slice(0, 10);
  if (minute >= 570 && minute < 575 && last.time.slice(0, 10) < day) return true;
  return minute >= 780 && minute < 785 && last.time.slice(0, 10) === day && minuteOfDay(last.at) >= 689 && minuteOfDay(last.at) <= 690;
}
export function consecutiveBars(a: MinuteBar, b: MinuteBar) {
  if (b.at - a.at === 60000) return true;
  if (a.time.slice(0, 10) !== b.time.slice(0, 10)) return true;
  return minuteOfDay(a.at) === 690 && [780, 781].includes(minuteOfDay(b.at));
}

export class CausalEngine {
  constructor(private symbol = "TEST") {}
  bars: MinuteBar[] = [];
  marketBars: MinuteBar[] = [];
  samples: Observation[] = [];
  candidates: Partial<Record<PointType, Excursion>> = {};
  highPoints: Point[] = [];
  lowPoints: Point[] = [];
  regime: Regime = "UNCERTAIN";
  features: Features | null = null;
  assessment: SignalAssessment[] = [];
  message = "正在加载趋势背景，随后由新报价即时评估";
  private decisionAt = 0;
  private handled = new Set<string>();
  private holds = new Map<string, HeldPoint>();
  snapshot(background = true): EngineState {
    return { version: 1, strategy: STRATEGY_VERSION, symbol: this.symbol, ...(background ? { bars: this.bars, marketBars: this.marketBars } : {}), samples: this.samples.slice(-100), candidates: this.candidates, regime: this.regime, assessment: this.assessment, message: this.message, decisionAt: this.decisionAt, handled: [...this.handled], holds: [...this.holds.values()] };
  }
  hydrate(state: EngineState, background?: EngineState): boolean {
    if (state.version !== 1 || state.strategy !== STRATEGY_VERSION || state.symbol !== this.symbol) return false;
    this.bars = (state.bars ?? background?.bars ?? []).slice(-PARAMETERS.indicatorWindow);
    this.marketBars = (state.marketBars ?? background?.marketBars ?? []).slice(-PARAMETERS.indicatorWindow);
    this.samples = state.samples.slice(-100); this.candidates = { ...state.candidates };
    this.regime = state.regime; this.assessment = state.assessment; this.message = state.message; this.decisionAt = state.decisionAt;
    this.handled = new Set(state.handled); this.holds = new Map(state.holds.map(p => [p.id, { ...p }]));
    this.features = calculateFeatures(this.bars); return true;
  }
  get ready() { return this.features !== null; }
  restore(high: Point[], low: Point[]) { this.highPoints = high; this.lowPoints = low; for (const point of [...high, ...low]) this.hold(point); }
  // 报价与分钟两条因果事件流共享已处理机会；较晚事件不能提前抑制历史事件。
  hold(point: Pick<Point, "id" | "type" | "pivotAt">) {
    if (this.handled.has(point.id)) return;
    this.handled.add(point.id); this.holds.set(point.id, { ...point });
    const candidate = this.candidates[point.type];
    if (point.pivotAt <= this.decisionAt && candidate && candidate.at <= point.pivotAt) candidate.fired = true;
  }
  release(point: Pick<Point, "id" | "type" | "pivotAt">) {
    const held = this.holds.delete(point.id); this.handled.delete(point.id);
    const candidate = this.candidates[point.type];
    if (held && candidate && candidate.at <= point.pivotAt) candidate.fired = [...this.holds.values()].some(p => p.type === point.type && p.pivotAt <= this.decisionAt);
  }
  reset(message: string) { this.candidates = {}; this.samples = []; this.message = message; }

  observe(sample: Observation, now = sample.availableAt, context: { market?: Observation | null; missing?: string[]; emit?: boolean } = {}): Point[] {
    if (sample.at <= 0 || sample.at > now || sample.availableAt > now || now - sample.at > PARAMETERS.freshnessMs || sample.price <= 0 || sample.volume <= 0 || sample.amount <= 0) { this.samples = []; return []; }
    const previous = this.samples.at(-1);
    if (previous && sample.at <= previous.at) return [];
    if (previous && (sample.volume < previous.volume || sample.amount < previous.amount)) { this.reset("累计成交数据回退，等待有效报价"); return []; }
    this.samples.push({ ...sample }); this.samples = this.samples.slice(-100);
    if (!signalAt(sample.at)) return [];
    const known = this.bars.filter(b => b.completedAt <= sample.availableAt);
    const base = calculateFeatures(known);
    if (!base || !backgroundUsable(known.at(-1), sample.availableAt)) { this.message = "分钟趋势背景缺失或过期，当前报价暂不打点"; return []; }
    const f = liveFeatures(known, base, sample, this.samples);
    if (!f) return [];
    this.regime = this.classify(f, sample.price);
    if (context.emit === false) return [];
    const marketSample = context.market && context.market.at <= sample.availableAt && context.market.availableAt <= sample.availableAt && sample.availableAt - context.market.at <= PARAMETERS.freshnessMs ? context.market : undefined;
    const market = this.marketBars.filter(b => b.completedAt <= sample.availableAt).at(-1) ?? null;
    return this.decide({ at: sample.availableAt, price: sample.price, now, mode: "live", sample, market, marketSample, missing: context.missing ?? [] }, f, known);
  }

  process(bar: MinuteBar, market: MinuteBar | null, options: { mode: "historical" | "live"; now: number; emit?: boolean; missing?: string[] }): Point[] {
    if (bar.completedAt > options.now || this.bars.at(-1) && bar.at <= this.bars.at(-1)!.at) return [];
    if (market && market.completedAt > bar.completedAt) market = null;
    if (this.bars.at(-1) && !consecutiveBars(this.bars.at(-1)!, bar)) { this.bars = []; this.marketBars = []; this.candidates = {}; }
    this.bars.push({ ...bar }); this.bars = this.bars.slice(-PARAMETERS.indicatorWindow);
    if (market && market.completedAt <= bar.completedAt && (!this.marketBars.at(-1) || market.at > this.marketBars.at(-1)!.at)) { this.marketBars.push({ ...market }); this.marketBars = this.marketBars.slice(-PARAMETERS.indicatorWindow); }
    this.features = calculateFeatures(this.bars);
    if (!this.features) { this.regime = "UNCERTAIN"; this.assessment = []; this.message = "正在预热布林、KDJ、MACD 与波段背景"; return []; }
    // 记录已知偏离退出的事件时刻；较晚背景不能提前解除较早决策的抑制。
    for (const point of this.holds.values()) if (!point.exitedAt && point.pivotAt <= bar.completedAt && (point.type === "HIGH" ? 1 : -1) * this.features.z < .35) point.exitedAt = bar.completedAt;
    // 背景刷新不改变实时候选、即时评分或实时趋势；历史回放才按分钟事件判断。
    if (options.emit === false || !signalMinute(bar)) return [];
    this.regime = this.classify(this.features, bar.close);
    return this.decide({ at: bar.completedAt, price: bar.close, now: options.now, mode: options.mode, bar, market, missing: options.missing ?? [] }, this.features, this.bars);
  }

  private decide(event: Event, f: Features, known: MinuteBar[]): Point[] {
    this.decisionAt = event.at;
    for (const [id, point] of this.holds) if (point.exitedAt && point.exitedAt <= event.at) {
      const candidate = this.candidates[point.type];
      if (candidate && candidate.at <= point.pivotAt) delete this.candidates[point.type];
      this.holds.delete(id);
    }
    const day = new Date(event.at + 8 * 3600000).toISOString().slice(0, 10);
    const structure = waveStructure(event.bar ? known.slice(0, -1) : known, f.atr, day, event.sample);
    for (const type of ["HIGH", "LOW"] as const) {
      const side = type === "HIGH" ? 1 : -1;
      // 只有退出价格偏离区才能开始下一次机会，不用固定冷却，也不按振荡指标的小回摆重置。
      if (side * f.z < .35) {
        delete this.candidates[type];
        for (const [id, point] of this.holds) if (point.type === type && point.pivotAt <= event.at) this.holds.delete(id);
      }
      const stretch = side * f.z >= 1.1 && (type === "HIGH" ? f.rsi >= 58 || f.k >= 70 : f.rsi <= 42 || f.k <= 30);
      const extreme = event.bar ? type === "HIGH" ? event.bar.high : event.bar.low : event.price;
      const prior = this.candidates[type];
      if (stretch && (!prior || !prior.fired && side * extreme > side * prior.extreme)) this.candidates[type] = { at: prior?.at ?? event.at, extreme, fired: false };
      if (this.candidates[type] && [...this.holds.values()].some(p => p.type === type && p.pivotAt <= event.at)) this.candidates[type]!.fired = true;
    }
    this.assessment = (["HIGH", "LOW"] as const).map(type => this.evaluate(type, event, f, structure));
    this.message = this.regime === "STRONG_UP" ? "强上涨保护：观察回踩承接" : this.regime === "STRONG_DOWN" ? "强下跌保护：等待有效承接" : "新报价即时评估：85 分及全部过滤通过后立即请求 AI";
    const eligible = this.assessment.filter(a => !a.blockers.length && a.score >= PARAMETERS.scoreThreshold);
    if (eligible.length !== 1) return [];
    const a = eligible[0], type = a.type, excursion = this.candidates[type]!;
    const id = createHash("sha256").update(`${this.symbol}:${type}:${event.sample ? `quote:${event.sample.at}` : `minute:${event.at}`}:${STRATEGY_VERSION}`).digest("hex").slice(0, 24);
    if ([...this.highPoints, ...this.lowPoints].some(p => p.id === id || p.type === type && p.pivotAt === event.at)) { excursion.fired = true; return []; }
    const stop = type === "HIGH" ? Math.max(excursion.extreme, event.price) + f.atr * .5 : Math.min(excursion.extreme, event.price) - f.atr * .5;
    const point: Point = {
      id, type,
      sequenceNo: (type === "HIGH" ? this.highPoints : this.lowPoints).filter(p => p.pivotAt <= event.at).length + 1,
      pivotAt: event.at, pivotPrice: event.price.toFixed(2), confirmedAt: event.mode === "historical" ? event.at : event.now, recordedAt: event.now, mode: event.mode, quoteAtConfirmation: event.price.toFixed(2),
      ruleScore: a.score, regime: this.regime, reasons: a.groups.map(g => `${g.name} ${g.score}/${g.max}：${g.detail}`),
      invalidationRule: { price: Number(stop.toFixed(2)), direction: type === "HIGH" ? "above" : "below" }, strategyVersion: STRATEGY_VERSION,
      dataProfile: event.sample ? "实时报价触发 · 接收时刻与当时报价锚点 · 无反转等待窗口" : event.mode === "live" ? "已完成分钟收盘触发 · 当时收盘锚点 · AI 最多5秒复核" : "分钟历史近似回放 · 收盘锚点 · 无历史秒级盘口与 AI 决策",
      inputSnapshot: { samples: event.sample ? this.samples.filter(s => s.at <= event.at && s.availableAt <= event.at).map(s => ({ ...s })) : [],
        provider: event.sample ? "腾讯实时报价 / 东方财富分钟背景 / technicalindicators" : "东方财富分钟 OHLC / technicalindicators", sourceKind: event.sample ? "quote" : "minute-close",
        market: event.marketSample?.price ?? event.market?.close ?? null, ...(event.marketSample ? { marketSample: { ...event.marketSample } } : {}), missing: [...new Set([...event.missing, ...(a.missing ?? [])])],
        cutoffAt: event.at, bars: known.filter(b => b.completedAt <= event.at).map(b => ({ ...b })), marketBars: this.marketBars.filter(b => b.completedAt <= event.at).map(b => ({ ...b })),
        features: { ...f, ready: "就绪", template: a.template ?? "RANGE_REVERSION", waveScale: structure.scale, structuralSupport: structure.support, structuralResistance: structure.resistance,
          ...opportunityGeometry(type, f, event.bar ? known.slice(0, -1) : known, event.price, excursion.extreme, structure.scale, day),
          ...opportunityEvidence(type, f, known, { ...event, extreme: excursion.extreme, priorQuote: this.samples.filter(s => s.at < (event.sample?.at ?? 0)).at(-1) }) }, groups: a.groups,
        hardFilters: ["已知数据与新鲜度", "当前波段规模", "已知目标与剩余空间", "独立价格拒绝或承接证据", "突破与破位过滤", "趋势及指数保护", "单次偏离一次机会", "每侧每天最多3点"], excursionAt: excursion.at }, riskEvents: [],
    };
    // 预留本次机会；AI 否决也不循环重复请求，同一偏离退出后才重新评估。
    excursion.fired = true; this.hold(point);
    return [point];
  }

  private classify(f: Features, price: number): Regime {
    // 较大周期定义主趋势，短周期用于寻找该趋势内的回踩/反弹，避免回踩本身被误判为逆势。
    const broadUp = f.higherSlope > f.atr * .1 && f.higherNet > f.atr;
    const broadDown = f.higherSlope < -f.atr * .1 && f.higherNet < -f.atr;
    const upward = broadUp || f.slope > f.atr * .75 && price > f.ema && f.higherSlope >= 0;
    const downward = broadDown || f.slope < -f.atr * .75 && price < f.ema && f.higherSlope <= 0;
    const efficient = f.higherEfficiency >= .55 && (f.efficiency >= .55 || f.fastEfficiency >= .7);
    if (f.adx >= 25 && efficient && upward) return "STRONG_UP";
    if (f.adx >= 25 && efficient && downward) return "STRONG_DOWN";
    if (upward) return "UPTREND";
    if (downward) return "DOWNTREND";
    return "RANGE";
  }

  private evaluate(type: PointType, event: Event, f: Features, structure: ReturnType<typeof waveStructure>): SignalAssessment {
    const side = type === "HIGH" ? 1 : -1, direction = -side, excursion = this.candidates[type], blockers: string[] = [];
    if (!excursion) blockers.push("尚无有效价格偏离");
    if (excursion?.fired) blockers.push("该结构机会已触发或被 AI 否决，等待退出偏离区");
    if ((type === "HIGH" ? this.highPoints : this.lowPoints).filter(p => p.pivotAt <= event.at).length >= 3) blockers.push("该方向全天3点配额已用完");
    const missing = event.bar?.open === null ? ["该分钟缺少开盘价，影线证据停用；仅使用真实收盘、区间与量价"] : [];
    if (event.bar && (event.bar.volume <= 0 || event.bar.amount <= 0)) blockers.push("历史分钟成交无效");
    if (event.mode === "live" && event.now - event.at > PARAMETERS.deadlineMs) blockers.push("当前事件已过期");
    const known = this.bars.filter(b => b.completedAt <= event.at);
    const day = new Date(event.at + 8 * 3600000).toISOString().slice(0, 10);
    const geometry = opportunityGeometry(type, f, event.bar ? known.slice(0, -1) : known, event.price, excursion?.extreme ?? event.price, structure.scale, day);
    const { origin, prominence, target, space, rr, retreat } = geometry;
    if (prominence < 1) blockers.push("波段规模不足，过滤分钟小波动");
    if (space < structure.scale * .5 || rr < PARAMETERS.minRewardRisk) blockers.push("到已知目标的剩余空间或收益风险比不足");
    if (retreat > structure.scale * .6) blockers.push("离已知极值已走过较多空间，跳过迟到机会");
    const evidence = opportunityEvidence(type, f, known, { ...event, extreme: excursion?.extreme ?? event.price, priorQuote: this.samples.filter(s => s.at < (event.sample?.at ?? 0)).at(-1) });
    const { near, book, momentum, rejection, priceEvidence, validBook, breakout, volumeEvidence, turnEvidence, failedBreak } = evidence;
    if (!near && side * f.z < 1.8) blockers.push("当前位置缺少明确支撑或阻力依据");
    const sample = event.sample;
    if (breakout) blockers.push(type === "HIGH" ? "正在放量或动量增强突破阻力，缺少价格拒绝" : "正在动量增强跌破支撑，缺少有效承接");
    if (priceEvidence < .45 || turnEvidence < .35 && book < .6 && rejection < .6) blockers.push("独立反转证据不足，超买超卖或微小影线不能单独触发");
    const strongCountertrend = type === "HIGH" && this.regime === "STRONG_UP" || type === "LOW" && this.regime === "STRONG_DOWN";
    const countertrend = strongCountertrend || type === "HIGH" && this.regime === "UPTREND" || type === "LOW" && this.regime === "DOWNTREND";
    const template: OpportunityTemplate = countertrend ? "TREND_EXHAUSTION" : this.regime === "RANGE" || this.regime === "UNCERTAIN" ? "RANGE_REVERSION" : "TREND_PULLBACK";
    const participation = Math.max(book, volumeEvidence);
    if (countertrend && (priceEvidence < .7 || turnEvidence < .5 && !(book >= .8 && momentum >= .25))) blockers.push("逆势衰竭证据不足，需要充分价格拒绝/承接及转折证据");
    if (strongCountertrend && (failedBreak < .8 || momentum < .35 || participation < .5)) blockers.push("强趋势保护：尚无明确突破失败或破位收复及动量衰竭");
    if (validBook && sample!.ask! - sample!.bid! > space / 5) blockers.push("盘口价差占用过多剩余空间");
    const knownMarket = this.marketBars.filter(b => b.completedAt <= event.at);
    let marketScore = 0;
    const marketBackground = sample ? backgroundUsable(event.market ?? undefined, event.at) : event.market && event.at - event.market.completedAt <= 60000;
    if (!marketBackground || knownMarket.length < 15 || sample && !event.marketSample) blockers.push("缺少当时有效指数背景或新鲜指数报价");
    else {
      const trend = trendStrength(knownMarket);
      const atr = ATR.calculate({ high: knownMarket.map(b => b.high), low: knownMarket.map(b => b.low), close: knownMarket.map(b => b.close), period: 14 }).at(-1) ?? 0;
      const slope = event.marketSample ? event.marketSample.price - knownMarket.slice(-12)[0].close : trend.slope;
      const adverse = direction * slope < 0 && trend.efficiency >= .7;
      const marketFast = event.marketSample ? event.marketSample.price - knownMarket.slice(-3)[0].close : trendStrength(knownMarket, 4).slope;
      const relative = atr > 0 && direction * (f.fastSlope / f.atr - marketFast / atr) > .25;
      if (adverse && !relative) blockers.push("指数同向强推，个股缺少相对转弱或转强证据");
      marketScore = adverse ? relative ? 6 : 0 : 10;
    }
    const groups = [
      { name: "位置与偏离", max: 20, score: round(10 * clamp((side * f.z - .8) / 1.2) + (near || evidence.reclaimed >= .6 ? 5 : 0) + 5 * clamp(side * (event.price - (template === "TREND_PULLBACK" ? f.middle : f.vwap)) / f.atr)), detail: `布林 ${round(f.z)}σ；边界距离 ${round(evidence.boundaryDistance)} ATR；VWAP ${f.vwap.toFixed(2)}` },
      { name: "当前波段与空间", max: 20, score: round(8 * clamp(prominence / 1.5) + 6 * clamp(space / structure.scale) + 6 * clamp(rr / 2)), detail: `本波起点 ${origin?.toFixed(2) ?? "缺失"}；规模 ${round(prominence)}；${geometry.targetKind} ${target.toFixed(2)}；收益风险比 ${round(rr)}` },
      { name: "价格转折与量价", max: 40, score: round(22 * priceEvidence + 10 * turnEvidence + 8 * participation), detail: `价格响应 ${round(evidence.response)}；影线拒绝 ${round(rejection)}；边界收复 ${round(evidence.reclaimed)}；动量/突破失败择强 ${round(turnEvidence)}；盘口 ${round(book)}；量价 ${round(volumeEvidence)}` },
      { name: "趋势与机会类型", max: 10, score: strongCountertrend ? 5 : countertrend ? 8 : 10, detail: `${TEMPLATE_LABELS[template]}；ADX ${round(f.adx)}；短窗斜率 ${round(f.fastSlope / f.atr)} ATR；五分钟方向 ${round(f.higherSlope / f.atr)} ATR` },
      { name: "当时指数", max: 10, score: marketScore, detail: event.marketSample ? "新鲜指数报价与已知趋势联合判断" : "历史指数按事件时间匹配" },
    ];
    return { type, armed: !!excursion && !excursion.fired, score: round(groups.reduce((sum, g) => sum + g.score, 0)), groups, blockers, template, missing };
  }
}
