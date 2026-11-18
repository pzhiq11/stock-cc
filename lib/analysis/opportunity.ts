import type { MinuteBar, Observation, PointType } from "@/lib/types";
import type { Features } from "./indicators";

const clamp = (n: number) => Math.max(0, Math.min(1, n));

// 回放中只确认已经发生的波段转换；当前候选永远不会利用后续价格选取起点。
function observedWaves(bars: MinuteBar[], scale: number, day: string) {
  const prices = bars.filter(b => b.time.startsWith(day)).map(b => b.close);
  if (!prices.length) return null;
  let high = prices[0], low = prices[0], peak = high, trough = low, direction = 0;
  const pivots: { type: PointType; price: number; confirmedIndex: number; departure: number }[] = [];
  const reversal = scale * .5;
  for (let i = 1; i < prices.length; i++) {
    const price = prices[i];
    if (direction === 0) {
      high = Math.max(high, price); low = Math.min(low, price);
      if (price - low >= reversal) { direction = 1; trough = low; high = price; }
      else if (high - price >= reversal) { direction = -1; peak = high; low = price; }
    } else if (direction > 0) {
      high = Math.max(high, price);
      if (high - price >= reversal) { peak = high; pivots.push({ type: "HIGH", price: high, confirmedIndex: i, departure: high - trough }); direction = -1; low = price; }
    } else {
      low = Math.min(low, price);
      if (price - low >= reversal) { trough = low; pivots.push({ type: "LOW", price: low, confirmedIndex: i, departure: peak - low }); direction = 1; high = price; }
    }
  }
  return { peak, trough, pivots, prices };
}

export function localWaveOrigin(bars: MinuteBar[], type: PointType, scale: number, day: string): number | null {
  const wave = observedWaves(bars, scale, day);
  return wave ? type === "HIGH" ? wave.trough : wave.peak : null;
}

// 目标只能来自当时已经形成的结构。均线穿过现价不等于有效支撑/阻力；
// 但已验证且尚未被破坏的近端转折必须优先于较远的波段起点。
export function opportunityGeometry(type: PointType, f: Features, bars: MinuteBar[], price: number, extreme: number, scale: number, day: string) {
  const side = type === "HIGH" ? 1 : -1, direction = -side;
  const context = observedWaves(bars, scale, day);
  const origin = context ? type === "HIGH" ? context.trough : context.peak : null;
  const levels: { price: number; name: string }[] = origin === null ? [] : [{ price: origin, name: "本波起点" }];
  if (context) for (const pivot of context.pivots) {
    if (pivot.type === type || pivot.departure < scale || context.prices.length - pivot.confirmedIndex > 60) continue;
    const later = context.prices.slice(pivot.confirmedIndex);
    if (later.some(p => direction * (p - pivot.price) > f.atr * .3)) continue;
    levels.push({ price: pivot.price, name: "已验证近端结构" });
  }
  // VWAP只有出现过足够幅度的实际承接/拒绝才成为空间障碍，布林中轨只参与位置评价。
  const recent = bars.filter(b => b.time.startsWith(day)).slice(-20);
  const respectedVwap = recent.some((bar, i) => {
    const touched = type === "HIGH" ? bar.low : bar.high;
    return Math.abs(touched - f.vwap) <= f.atr * .25
      && recent.slice(i).some(b => side * (b.close - f.vwap) >= scale * .5)
      && recent.slice(i).every(b => direction * (b.close - f.vwap) <= f.atr * .3);
  });
  if (respectedVwap) levels.push({ price: f.vwap, name: "已验证VWAP承接/压力" });
  const target = levels.filter(level => direction * (level.price - price) > 0).sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))[0];
  const space = target ? Math.abs(target.price - price) : 0, risk = Math.max(0, side * (extreme - price)) + f.atr * .5;
  const wave = origin === null ? 0 : Math.max(0, side * (extreme - origin));
  return { origin, target: target?.price ?? price, targetKind: target?.name ?? "无有效结构目标", wave, prominence: wave / scale, space, risk, rr: risk > 0 ? space / risk : 0, retreat: Math.max(0, side * (extreme - price)) };
}

export function opportunityEvidence(type: PointType, f: Features, known: MinuteBar[], event: {
  price: number; extreme: number; bar?: MinuteBar; sample?: Observation; priorQuote?: Observation;
}) {
  const side = type === "HIGH" ? 1 : -1, direction = -side;
  const boundary = type === "HIGH" ? f.resistance : f.support;
  const boundaryDistance = side * (event.price - boundary) / f.atr;
  const near = Math.abs(boundaryDistance) <= .75;
  // RSI、KDJ、MACD来自同一价格序列，合并为一个证据组，不当作三种独立证据。
  const momentum = (clamp(direction * (f.rsi - f.previousRsi) / 2)
    + clamp(direction * (f.k - f.previousK) / 3)
    + clamp(direction * (f.histogram - f.previousHistogram) / f.atr / .03)) / 3;
  const priorPrice = event.sample ? event.priorQuote?.price ?? known.at(-1)?.close : known.at(-2)?.close;
  const response = priorPrice === undefined ? 0 : clamp(direction * (event.price - priorPrice) / (f.atr * .25));
  const range = event.bar ? event.bar.high - event.bar.low : 0;
  const shadow = event.bar?.open === null || event.bar?.open === undefined ? 0 : type === "HIGH"
    ? event.bar.high - Math.max(event.bar.open, event.bar.close)
    : Math.min(event.bar.open, event.bar.close) - event.bar.low;
  const closeAway = event.bar ? type === "HIGH" ? event.bar.high - event.bar.close : event.bar.close - event.bar.low : 0;
  // 同时要求影线有波动率尺度和收盘拒绝力度，微小十字星不会因为比例较大获得满分。
  const rejection = range > 0 ? clamp(shadow / (f.atr * .4)) * clamp(shadow / range / .35) * clamp(closeAway / range / .5) : 0;
  const reclaimed = side * (event.extreme - boundary) > f.atr * .2 && boundaryDistance <= 0
    ? clamp(side * (event.extreme - event.price) / (f.atr * .3)) : 0;
  const priceEvidence = Math.max(response, rejection, reclaimed);
  // 突破失败/破位收复可当场成立，不强求三个滞后振荡指标也同时转向。
  // 必须既穿越过边界又退回，且有实质价格响应或有效影线，不能仅靠超买超卖。
  const failedBreak = Math.min(reclaimed, Math.max(rejection, response));
  const turnEvidence = Math.max(momentum, failedBreak);
  const s = event.sample;
  const validBook = !!s && s.bid !== null && s.ask !== null && s.bid > 0 && s.ask >= s.bid && s.bidSize !== null && s.askSize !== null && s.bidSize >= 0 && s.askSize >= 0 && s.bidSize + s.askSize > 0;
  const pressure = validBook ? (type === "HIGH" ? s!.askSize! : s!.bidSize!) / (s!.bidSize! + s!.askSize!) : .5;
  // 一档挂单不是成交订单流；只有同时出现价格响应时才支持反转。
  const book = validBook && priceEvidence >= .45 ? clamp((pressure - .5) / .35) : 0;
  const volumeEvidence = priceEvidence >= .45 ? clamp((f.volumeRatio - .5) / 1.5) : 0;
  const pushing = side * (f.rsi - f.previousRsi) > .5 && side * (f.histogram - f.previousHistogram) > 0;
  const breakout = boundaryDistance > .25 && pushing && priceEvidence < .7;
  return { boundaryDistance, near, momentum, response, rejection, reclaimed, failedBreak, turnEvidence, priceEvidence, book, validBook, volumeEvidence, breakout };
}
