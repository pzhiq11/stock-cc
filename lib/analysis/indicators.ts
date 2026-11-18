import { ADX, ATR, BollingerBands, EMA, MACD, RSI, Stochastic } from "technicalindicators";
import type { MinuteBar, Observation } from "@/lib/types";

const last = <T>(array: T[]) => array.at(-1);
export type Features = {
  atr: number; rsi: number; previousRsi: number; k: number; d: number; j: number; previousK: number;
  macd: number; histogram: number; previousHistogram: number; z: number; middle: number;
  vwap: number; resistance: number; support: number; volumeRatio: number; adx: number;
  efficiency: number; slope: number; fastSlope: number; fastEfficiency: number; higherSlope: number; higherNet: number; higherEfficiency: number; ema: number; ready: boolean;
};

export function aggregateFive(bars: MinuteBar[]): MinuteBar[] {
  const groups = new Map<number, MinuteBar[]>();
  for (const bar of bars) {
    const bucket = Math.floor(bar.at / 300000) * 300000;
    const group = groups.get(bucket) ?? []; group.push(bar); groups.set(bucket, group);
  }
  return [...groups.values()].filter(g => g.length === 5 && g.every((b, i) => b.at === g[0].at + i * 60000)).map(g => ({
    time: g[0].time, at: g[0].at, completedAt: g[4].completedAt, open: g[0].open, close: g[4].close,
    high: Math.max(...g.map(b => b.high)), low: Math.min(...g.map(b => b.low)),
    volume: g.reduce((s, b) => s + b.volume, 0), amount: g.reduce((s, b) => s + b.amount, 0), average: g[4].average,
  }));
}

export function trendStrength(bars: MinuteBar[], length = 12): { efficiency: number; slope: number } {
  const window = bars.slice(-length);
  const distance = window.slice(1).reduce((sum, b, i) => sum + Math.abs(b.close - window[i].close), 0);
  const net = window.length ? window.at(-1)!.close - window[0].close : 0;
  return { efficiency: distance > 0 ? Math.abs(net) / distance : 0, slope: net };
}

export function calculateFeatures(bars: MinuteBar[]): Features | null {
  if (bars.length < 35) return null;
  const values = bars.map(b => b.close), high = bars.map(b => b.high), low = bars.map(b => b.low);
  const input = { high, low, close: values, period: 14 };
  const atr = last(ATR.calculate(input)), adx = last(ADX.calculate(input));
  const band = last(BollingerBands.calculate({ values, period: 20, stdDev: 2 }));
  const rsi = RSI.calculate({ values, period: 14 });
  const macd = MACD.calculate({ values, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
  // 国内 KDJ(9,3,3)：框架计算 RSV，再按 1/3 递推平滑；不是把随机指标的 SMA 信号线当 KDJ。
  const rsv = Stochastic.calculate({ high, low, close: values, period: 9, signalPeriod: 1 });
  let k = 50, d = 50, previousK = 50;
  for (const point of rsv) { previousK = k; k = 2 * k / 3 + point.k / 3; d = 2 * d / 3 + k / 3; }
  const five = aggregateFive(bars);
  const higher = EMA.calculate({ values: five.map(b => b.close), period: 5 });
  const ema = last(EMA.calculate({ values, period: 20 }));
  const current = bars.at(-1)!;
  const day = bars.filter(b => b.time.slice(0, 10) === current.time.slice(0, 10));
  const volume = day.reduce((sum, b) => sum + b.volume, 0), amount = day.reduce((sum, b) => sum + b.amount, 0);
  const vwap = current.average !== null && current.average > 0 ? current.average : volume > 0 && amount > 0 ? amount / volume : null;
  const previous = bars.slice(-21, -1), averageVolume = previous.reduce((sum, b) => sum + b.volume, 0) / previous.length;
  const latestMacd = last(macd), previousMacd = macd.at(-2);
  const deviation = band ? (band.upper - band.lower) / 4 : 0;
  if (!atr || !adx || !band || !ema || vwap === null || latestMacd?.histogram === undefined || previousMacd?.histogram === undefined || latestMacd.MACD === undefined || rsi.at(-2) === undefined || higher.length < 2) return null;
  const trend = trendStrength(bars);
  const features: Features = {
    atr, adx: adx.adx, rsi: rsi.at(-1)!, previousRsi: rsi.at(-2)!, k, d, j: 3 * k - 2 * d, previousK,
    macd: latestMacd.MACD, histogram: latestMacd.histogram, previousHistogram: previousMacd.histogram,
    z: deviation > 0 ? (current.close - band.middle) / deviation : 0, middle: band.middle, vwap,
    resistance: Math.max(...previous.map(b => b.high)), support: Math.min(...previous.map(b => b.low)),
    volumeRatio: averageVolume > 0 ? current.volume / averageVolume : 0,
    ...trend, fastSlope: trendStrength(bars, 4).slope, fastEfficiency: trendStrength(bars, 4).efficiency,
    higherSlope: higher.at(-1)! - higher.at(-2)!, higherNet: trendStrength(five, 6).slope, higherEfficiency: trendStrength(five, 6).efficiency, ema, ready: true,
  };
  return Object.values(features).every(v => typeof v !== "number" || Number.isFinite(v)) ? features : null;
}

// 每次只用一个当前价格更新尚未结束的周期；不会把每条报价冒充一根已完成 K 线。
export function liveFeatures(bars: MinuteBar[], base: Features, sample: Observation, samples: Observation[]): Features | null {
  const values = [...bars.map(b => b.close), sample.price];
  const band = last(BollingerBands.calculate({ values, period: 20, stdDev: 2 }));
  const rsi = last(RSI.calculate({ values, period: 14 }));
  const macd = last(MACD.calculate({ values, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }));
  const ema = last(EMA.calculate({ values, period: 20 }));
  if (!band || rsi === undefined || macd?.histogram === undefined || macd.MACD === undefined || ema === undefined) return null;
  const observed = samples.filter(s => s.at > bars.at(-1)!.completedAt && s.at <= sample.at);
  const h = Math.max(...bars.slice(-8).map(b => b.high), sample.price, ...observed.map(s => s.price));
  const l = Math.min(...bars.slice(-8).map(b => b.low), sample.price, ...observed.map(s => s.price));
  const rsv = h > l ? (sample.price - l) / (h - l) * 100 : 50;
  const k = 2 * base.k / 3 + rsv / 3, d = 2 * base.d / 3 + k / 3;
  const recent = samples.filter(s => sample.at - s.at <= 15000), first = recent[0];
  const elapsed = first ? (sample.at - first.at) / 1000 : 0;
  const averageVolume = bars.slice(-20).reduce((sum, b) => sum + b.volume, 0) / Math.min(20, bars.length);
  const rate = first && elapsed > 0 && sample.volume >= first.volume ? (sample.volume - first.volume) / elapsed : 0;
  const closes = [...bars.slice(-11).map(b => b.close), sample.price];
  const distance = closes.slice(1).reduce((sum, p, i) => sum + Math.abs(p - closes[i]), 0);
  const slope = sample.price - closes[0], deviation = (band.upper - band.lower) / 4;
  const fast = [...bars.slice(-3).map(b => b.close), sample.price];
  const fastDistance = fast.slice(1).reduce((sum, p, i) => sum + Math.abs(p - fast[i]), 0), fastSlope = sample.price - fast[0];
  const f: Features = { ...base, rsi, previousRsi: base.rsi, k, d, j: 3 * k - 2 * d, previousK: base.k,
    macd: macd.MACD, histogram: macd.histogram, previousHistogram: base.histogram,
    z: deviation > 0 ? (sample.price - band.middle) / deviation : 0, middle: band.middle, ema,
    vwap: sample.volume > 0 && sample.amount > 0 ? sample.amount / sample.volume : base.vwap,
    resistance: Math.max(...bars.slice(-20).map(b => b.high)), support: Math.min(...bars.slice(-20).map(b => b.low)),
    volumeRatio: averageVolume > 0 ? rate / (averageVolume / 60) : 0,
    efficiency: distance > 0 ? Math.abs(slope) / distance : 0, slope, fastSlope, fastEfficiency: fastDistance > 0 ? Math.abs(fastSlope) / fastDistance : 0,
  };
  return Object.values(f).every(v => typeof v !== "number" || Number.isFinite(v)) ? f : null;
}

export function waveStructure(bars: MinuteBar[], atr: number, day: string, sample?: Observation) {
  const recent = bars.slice(-60), today = recent.filter(b => b.time.startsWith(day));
  const levels = today.length ? today : recent;
  const five = aggregateFive(recent).map(b => b.high - b.low).filter(n => n > 0).sort((a, b) => a - b);
  const typicalFive = five.length ? five[Math.floor(five.length / 2)] : atr * 2;
  const support = Math.min(...levels.map(b => b.low), sample?.dayLow && sample.dayLow > 0 ? sample.dayLow : Infinity);
  const resistance = Math.max(...levels.map(b => b.high), sample?.dayHigh && sample.dayHigh > 0 ? sample.dayHigh : -Infinity);
  return { support, resistance, scale: Math.max(atr * 1.5, typicalFive * .75) };
}
