import { describe, expect, it } from "vitest";
import { CausalEngine, STRATEGY_VERSION } from "@/lib/analysis/engine";
import { opportunityEvidence, opportunityGeometry, localWaveOrigin } from "@/lib/analysis/opportunity";
import { minuteCloseIntraday, parseMinuteBars } from "@/lib/market/provider";
import { validPointEvidence } from "@/lib/analysis/store";
import { emptyReplayAssessments, recordReplayAssessment } from "@/lib/analysis/replay";
import type { MinuteBar, Observation, Point } from "@/lib/types";

function seed(shape = (i: number) => i < 79 ? 100 + Math.sin(i * Math.PI / 5) * .05 : 102, wick = .05, replay = false) {
  const engine = new CausalEngine("REALTIME.TEST"), start = Date.parse("2026-11-17T09:31:00+08:00");
  for (let i = 0; i < 80; i++) {
    const at = start + i * 60000, open = shape(i - 1), close = shape(i);
    const bar: MinuteBar = { time: new Date(at + 8 * 3600000).toISOString().slice(0, 16).replace("T", " "), at, completedAt: at + 60000, open, close, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, volume: 10000, amount: close * 10000, average: 100 };
    const value = 3000 + Math.sin(i * Math.PI / 4) * .05;
    engine.process(bar, { ...bar, open: value, close: value, high: value + .02, low: value - .02 }, { mode: "historical", now: bar.completedAt, emit: replay });
  }
  return engine;
}
function sample(engine: CausalEngine, price = 101.9, extra: Partial<Observation> = {}): Observation {
  const at = engine.bars.at(-1)!.completedAt + 12000;
  return { at, availableAt: at + 25, price, volume: 2000000, amount: 200000000, bid: price - .01, ask: price + .01, bidSize: 100, askSize: 10000, marketReturn: 0, dayHigh: Math.max(price, 100.6), dayLow: Math.min(price, 99.4), ...extra };
}
function market(s: Observation): Observation { return { ...s, price: 3000, amount: s.volume * 3000, bid: 2999.99, ask: 3000.01, bidSize: 1000, askSize: 1000 }; }

describe("immediate quote decisions", () => {
  it("rejects a new breakout even when the visible ask queue is large", () => {
    const engine = seed(i => 100 + Math.sin(i * Math.PI / 5) * .5), q = sample(engine, 102);
    expect(engine.observe(q, q.availableAt, { market: market(q) })).toEqual([]);
    const assessment = engine.assessment.find(a => a.type === "HIGH")!;
    expect(assessment.blockers.some(b => b.includes("反转证据不足"))).toBe(true);
    expect(assessment.score).toBeLessThan(85);
  });
  it("does not treat accelerating downward prices as absorption just because bids are large", () => {
    const engine = seed(i => 100 + Math.sin(i * Math.PI / 5) * .5), q = sample(engine, 98, { bidSize: 10000, askSize: 100 });
    expect(engine.observe(q, q.availableAt, { market: market(q) })).toEqual([]);
    expect(engine.assessment.find(a => a.type === "LOW")!.blockers.some(b => b.includes("反转证据不足"))).toBe(true);
  });
  it("can propose on the first received quote before the next minute finishes, with no future confirmation sample", () => {
    const engine = seed(), q = sample(engine), count = engine.bars.length;
    const points = engine.observe(q, q.availableAt, { market: market(q) });
    expect(points.length).toBe(1);
    const point = points[0]; expect(point.type).toBe("HIGH"); expect(point.ruleScore).toBeGreaterThanOrEqual(85);
    expect(point.pivotAt).toBe(q.availableAt); expect(point.pivotPrice).toBe(q.price.toFixed(2));
    expect(point.pivotAt).toBeLessThan(engine.bars.at(-1)!.completedAt + 60000);
    expect(point.inputSnapshot.samples.length).toBe(1); expect(engine.bars.length).toBe(count);
    expect(validPointEvidence(point)).toBe(true);
    expect(Number(point.inputSnapshot.features!.rsi)).toBeLessThan(Number(point.inputSnapshot.features!.previousRsi));
  });
  it("restores quote history and vetoed candidates in a new engine instance", () => {
    const engine = seed(), q = sample(engine), [point] = engine.observe(q, q.availableAt, { market: market(q) });
    engine.hold(point);
    const restored = new CausalEngine("REALTIME.TEST");
    expect(restored.hydrate(JSON.parse(JSON.stringify(engine.snapshot())))).toBe(true);
    const next = { ...q, at: q.at + 3000, availableAt: q.availableAt + 3000, volume: q.volume + 100, amount: q.amount + 10190 };
    expect(restored.observe(next, next.availableAt, { market: market(next) })).toEqual([]);
    expect(restored.samples).toHaveLength(2);
    expect(restored.assessment.find(a => a.type === "HIGH")!.blockers.some(b => b.includes("已触发"))).toBe(true);
    expect(restored.snapshot().bars).toHaveLength(engine.bars.length);
    expect(new CausalEngine("OTHER.TEST").hydrate(engine.snapshot())).toBe(false);
  });
  it("supports immediate absorption evidence already visible in the first quote", () => {
    const engine = seed(i => i < 79 ? 100 + Math.sin(i * Math.PI / 5) * .05 : 98), q = sample(engine, 98.1, { bidSize: 10000, askSize: 100 });
    expect(engine.observe(q, q.availableAt, { market: market(q) }).map(p => p.type)).toEqual(["LOW"]);
  });
  it("can decide at a completed minute close without using later quotes", () => {
    const engine = seed(i => i < 75 ? 100 + Math.sin(i * Math.PI / 5) * 2 : 106 + Math.sin((i - 75) * Math.PI / 3) * .15, .05, true), previous = engine.bars.at(-1)!, index = engine.marketBars.at(-1)!;
    const close = previous.close - .2;
    const bar = { ...previous, at: previous.at + 60000, completedAt: previous.completedAt + 60000, time: "2026-11-17 10:51", open: previous.close, high: previous.close + .05, low: close - .05, close, volume: 40000, amount: close * 40000 };
    const [point] = engine.process(bar, { ...index, at: bar.at, completedAt: bar.completedAt, time: bar.time }, { mode: "live", now: bar.completedAt + 2000 });
    expect(point, JSON.stringify(engine.assessment)).toBeDefined(); expect(point.mode).toBe("live"); expect(point.type).toBe("HIGH");
    expect(point.inputSnapshot.sourceKind).toBe("minute-close"); expect(point.inputSnapshot.samples).toEqual([]);
    expect(point.pivotAt).toBe(bar.completedAt); expect(point.pivotPrice).toBe("105.67"); expect(validPointEvidence(point)).toBe(true);
  });
  it("does not let a later stream reservation change an earlier causal decision", () => {
    const a = seed(), b = seed(), q = sample(a);
    b.hold({ id: "later-point", type: "HIGH", pivotAt: q.availableAt + 60000 });
    const expected = a.observe(q, q.availableAt, { market: market(q) });
    const actual = b.observe(q, q.availableAt, { market: market(q) });
    expect(actual.map(p => [p.pivotAt, p.pivotPrice, p.ruleScore])).toEqual(expected.map(p => [p.pivotAt, p.pivotPrice, p.ruleScore]));
    expect(actual).toHaveLength(1);
  });
  it("does not use a future background exit to clear a veto on an earlier quote", () => {
    const engine = seed(), q = sample(engine), last = engine.bars.at(-1)!;
    engine.hold({ id: "known-veto", type: "HIGH", pivotAt: q.availableAt });
    engine.process({ ...last, at: last.at + 60000, completedAt: last.completedAt + 60000, close: 100, high: 102.05, low: 99.95 }, null, { mode: "historical", now: last.completedAt + 60000, emit: false });
    expect(engine.observe(q, q.availableAt, { market: market(q) })).toEqual([]);
    expect(engine.assessment.find(a => a.type === "HIGH")!.blockers.some(b => b.includes("已触发"))).toBe(true);
  });
  it("releases an unsaved opportunity for a new event, while a held veto remains suppressed", () => {
    const released = seed(), vetoed = seed(), q = sample(released);
    const [point] = released.observe(q, q.availableAt, { market: market(q) });
    vetoed.hold(point); released.release(point);
    const next = { ...q, at: q.at + 1000, availableAt: q.availableAt + 1000, price: 101.85, volume: q.volume + 200, amount: q.amount + 20370 };
    const result = released.observe(next, next.availableAt, { market: market(next) });
    expect(result).toEqual([]);
    const assessment = released.assessment.find(a => a.type === "HIGH")!;
    expect(assessment.armed).toBe(true); expect(assessment.blockers.some(b => b.includes("已触发"))).toBe(false);
    expect(vetoed.observe(next, next.availableAt, { market: market(next) })).toEqual([]);
    expect(vetoed.assessment.find(a => a.type === "HIGH")!.blockers.some(b => b.includes("已触发"))).toBe(true);
  });
  it("keeps earlier decisions unchanged even if later bars have already been loaded", () => {
    const a = seed(), b = seed(), q = sample(a), last = b.bars.at(-1)!;
    b.process({ ...last, at: last.at + 60000, completedAt: last.completedAt + 60000, close: 120, high: 120 }, null, { mode: "historical", now: last.completedAt + 60000, emit: false });
    const first = a.observe(q, q.availableAt, { market: market(q) }), second = b.observe(q, q.availableAt, { market: market(q) });
    expect(first.length).toBe(1); expect(second.map(p => [p.id, p.ruleScore, p.pivotPrice])).toEqual(first.map(p => [p.id, p.ruleScore, p.pivotPrice]));
    expect(second[0].inputSnapshot.bars!.every(bar => bar.completedAt <= q.availableAt)).toBe(true);
  });
  it("does not repeat one opportunity, and does not turn quote samples into completed bars", () => {
    const engine = seed(), q = sample(engine), count = engine.bars.length;
    expect(engine.observe(q, q.availableAt, { market: market(q) }).length).toBe(1);
    expect(engine.observe({ ...q, availableAt: q.availableAt + 100 }, q.availableAt + 100, { market: market(q) }).length).toBe(0);
    for (let i = 1; i < 10; i++) {
      const next = { ...q, at: q.at + i * 1000, availableAt: q.availableAt + i * 1000, volume: q.volume + i * 100, amount: q.amount + i * 10200 };
      expect(engine.observe(next, next.availableAt, { market: market(next) }).length).toBe(0);
    }
    expect(engine.bars.length).toBe(count);
  });
  it("filters noise-scale waves and opportunities with insufficient remaining space", () => {
    const noisy = seed(i => 100 + Math.sin(i) * .001, 1), noise = sample(noisy, 100.5);
    expect(noisy.observe(noise, noise.availableAt, { market: market(noise) }).length).toBe(0);
    expect(noisy.assessment.find(a => a.type === "HIGH")!.blockers.some(b => b.includes("波段规模不足"))).toBe(true);
    const engine = seed(), q = sample(engine, 100.1);
    expect(engine.observe(q, q.availableAt, { market: market(q) }).length).toBe(0);
    expect(engine.assessment.find(a => a.type === "HIGH")!.blockers.some(b => b.includes("剩余空间"))).toBe(true);
  });
  it("rejects stale, future and missing market snapshots", () => {
    for (const kind of ["stale", "future", "no-market", "future-market"] as const) {
      const engine = seed(), q = sample(engine);
      const now = kind === "stale" ? q.at + 11000 : q.availableAt;
      const quote = kind === "future" ? { ...q, at: now + 100 } : q;
      const index = kind === "no-market" ? null : kind === "future-market" ? { ...market(q), availableAt: now + 100 } : market(q);
      expect(engine.observe(quote, now, { market: index }).length).toBe(0);
    }
  });
  it("keeps strong trend protection for live snapshots", () => {
    for (const direction of [-1, 1]) {
      const engine = seed(i => 100 + direction * i * .02), q = sample(engine, 100 + direction * 2, direction < 0 ? { bidSize: 10000, askSize: 100 } : {});
      expect(engine.observe(q, q.availableAt, { market: market(q) }).length).toBe(0);
      expect(engine.regime).toBe(direction > 0 ? "STRONG_UP" : "STRONG_DOWN");
    }
  });
  it("uses known pre-break context immediately at the afternoon open, without waiting for its first minute", () => {
    const engine = seed(), shift = 39 * 60000;
    for (const bars of [engine.bars, engine.marketBars]) for (const b of bars) { b.at += shift; b.completedAt += shift; b.time = new Date(b.at + 8 * 3600000).toISOString().slice(0, 16).replace("T", " "); }
    const at = Date.parse("2026-11-17T13:00:10+08:00"), q = sample(engine, 101.9, { at, availableAt: at + 25 });
    expect(engine.observe(q, q.availableAt, { market: market(q) }).length).toBe(1);
  });
  it("rejects persisted snapshots containing data after the decision", () => {
    const engine = seed(), q = sample(engine), [point] = engine.observe(q, q.availableAt, { market: market(q) });
    expect(validPointEvidence({ ...point, inputSnapshot: { ...point.inputSnapshot, marketSample: { ...market(q), availableAt: point.pivotAt + 1 } } })).toBe(false);
    expect(validPointEvidence({ ...point, inputSnapshot: { ...point.inputSnapshot, samples: [{ ...q, availableAt: point.pivotAt + 1 }] } })).toBe(false);
  });
  it("respects occupied daily quotas without replacing already confirmed points", () => {
    const first = seed(), q = sample(first), [point] = first.observe(q, q.availableAt, { market: market(q) });
    const engine = seed(), saved = [1, 2, 3].map(sequenceNo => ({ ...point, id: `saved-${sequenceNo}`, sequenceNo }));
    const frozen = JSON.stringify(saved); engine.restore(saved, []);
    expect(engine.observe(q, q.availableAt, { market: market(q) })).toEqual([]);
    expect(engine.assessment.find(a => a.type === "HIGH")!.blockers.some(b => b.includes("配额"))).toBe(true);
    expect(JSON.stringify(saved)).toBe(frozen);
  });
});

describe("causal reversal evidence and time alignment", () => {
  it("separates score, hard filters, missing data and warmup in replay diagnostics", () => {
    const stats = emptyReplayAssessments().HIGH, bar = seed().bars.at(-1)!;
    const candidate = { type: "HIGH" as const, armed: true, score: 92, groups: [], blockers: ["空间不足", "趋势保护"] };
    recordReplayAssessment(stats, bar, candidate, 85, false);
    recordReplayAssessment(stats, bar, { ...candidate, score: 84, blockers: [] }, 85, false);
    recordReplayAssessment(stats, bar, { ...candidate, score: 86, blockers: [] }, 85, false);
    recordReplayAssessment(stats, { ...bar, open: null }, undefined, 85, true);
    expect(stats).toMatchObject({ evaluated: 4, armed: 3, scorePassed: 2, filtersPassed: 2, qualified: 1, warming: 1, dataLimited: 1, blocked: { "空间不足": 1, "趋势保护": 1 }, closest: { score: 92 }, bestUnblocked: { score: 86 } });
  });
  it("rejects a future index bar even when historical index warmup is already available", () => {
    const engine = seed(i => i < 75 ? 100 + Math.sin(i * Math.PI / 5) * 2 : 106 + Math.sin((i - 75) * Math.PI / 3) * .15), last = engine.bars.at(-1)!, index = engine.marketBars.at(-1)!;
    const close = last.close - .2, bar = { ...last, at: last.at + 60000, completedAt: last.completedAt + 60000, time: "2026-11-17 10:51", open: last.close, close, high: last.close + .05, low: close - .05, volume: 40000 };
    expect(engine.process(bar, { ...index, completedAt: bar.completedAt + 1 }, { mode: "historical", now: bar.completedAt + 60000 })).toEqual([]);
    expect(engine.assessment.find(a => a.type === "HIGH")!.blockers.some(b => b.includes("指数背景"))).toBe(true);
  });
  it("allows a failed breakout to supply immediate turn evidence while oscillators still lag", () => {
    const engine = seed(), bar = { ...engine.bars.at(-1)!, open: 101.4, high: 102, low: 101, close: 101.3 };
    const f = { ...engine.features!, atr: .5, resistance: 101.5, rsi: 66, previousRsi: 65, k: 76, previousK: 75, histogram: .1, previousHistogram: .09 };
    const evidence = opportunityEvidence("HIGH", f, [{ ...bar, close: 101.2 }, bar], { price: bar.close, extreme: bar.high, bar });
    expect(evidence.momentum).toBe(0); expect(evidence.failedBreak).toBe(1); expect(evidence.turnEvidence).toBe(1); expect(evidence.breakout).toBe(false);
  });
  it("ignores an untested nearby average but respects a demonstrated nearer VWAP obstacle", () => {
    const template = seed().bars.at(-1)!;
    const bars = [100, 100, 102, 104].map(close => ({ ...template, close, high: close + .1, low: close - .1 }));
    const f = { ...seed().features!, atr: .5, middle: 102.99, vwap: 102.99 };
    const distant = opportunityGeometry("HIGH", f, bars, 103, 103.1, 1, "2026-11-17");
    expect(distant.target).toBe(100); expect(distant.targetKind).toBe("本波起点");
    const nearer = opportunityGeometry("HIGH", { ...f, vwap: 102 }, bars, 103, 103.1, 1, "2026-11-17");
    expect(nearer.target).toBe(102); expect(nearer.space).toBe(1); expect(nearer.targetKind).toContain("已验证VWAP");
  });
  it("does not let three saved future points consume an earlier event's causal quota", () => {
    const original = seed(), q = sample(original), [point] = original.observe(q, q.availableAt, { market: market(q) });
    const engine = seed(), later = [1, 2, 3].map(i => ({ ...point, id: `later-${i}`, pivotAt: point.pivotAt + i * 60000 }));
    engine.restore(later, []);
    const [replayed] = engine.observe(q, q.availableAt, { market: market(q) });
    expect(replayed).toBeDefined(); expect(replayed.ruleScore).toBe(point.ruleScore); expect(replayed.sequenceNo).toBe(1);
    expect(engine.assessment.find(a => a.type === "HIGH")!.blockers).toEqual([]);
  });
  it("invalidates an old-version engine snapshot instead of reusing its candidates", () => {
    const engine = seed(), snapshot = engine.snapshot();
    expect(new CausalEngine("REALTIME.TEST").hydrate({ ...snapshot, strategy: "causal-realtime-v4.0" })).toBe(false);
    expect(snapshot.strategy).toBe(STRATEGY_VERSION);
  });
  it("causally replays a nonempty prefix identically after a restart and after appending future bars", () => {
    const seeded = seed(i => i < 75 ? 100 + Math.sin(i * Math.PI / 5) * 2 : 106 + Math.sin((i - 75) * Math.PI / 3) * .15);
    const last = seeded.bars.at(-1)!, close = last.close - .2;
    const trigger = { ...last, at: last.at + 60000, completedAt: last.completedAt + 60000, time: "2026-11-17 10:51", open: last.close, high: last.close + .05, low: close - .05, close, volume: 40000, amount: close * 40000 };
    const prefix = [...seeded.bars, trigger], suffix = Array.from({ length: 30 }, (_, i) => {
      const at = trigger.at + (i + 1) * 60000, price = 104 - Math.sin(i) * 2;
      return { ...trigger, at, completedAt: at + 60000, time: new Date(at + 8 * 3600000).toISOString().slice(0, 16).replace("T", " "), open: price, close: price, high: price + .1, low: price - .1 };
    });
    const run = (bars: MinuteBar[], restart = false) => {
      let engine = new CausalEngine("REPLAY.TEST"); const points: Point[] = [];
      bars.forEach((bar, i) => {
        const index = seeded.marketBars[i] ?? { ...seeded.marketBars.at(-1)!, at: bar.at, completedAt: bar.completedAt, time: bar.time };
        for (const p of engine.process(bar, index, { mode: "historical", now: bars.at(-1)!.completedAt })) { points.push(p); (p.type === "HIGH" ? engine.highPoints : engine.lowPoints).push(p); }
        if (restart && i === 79) { const snapshot = JSON.parse(JSON.stringify(engine.snapshot())); engine = new CausalEngine("REPLAY.TEST"); expect(engine.hydrate(snapshot)).toBe(true); engine.restore(points.filter(p => p.type === "HIGH"), points.filter(p => p.type === "LOW")); }
      });
      return points.filter(p => p.pivotAt <= trigger.completedAt).map(p => ({ id: p.id, at: p.pivotAt, price: p.pivotPrice, score: p.ruleScore, snapshot: p.inputSnapshot }));
    };
    const expected = run(prefix); expect(expected.length).toBeGreaterThan(0);
    expect(run([...prefix, ...suffix])).toEqual(expected); expect(run([...prefix, ...suffix], true)).toEqual(expected);
    const withoutOpen = prefix.map(b => ({ ...b, open: null }));
    const degraded = run(withoutOpen); expect(degraded.length).toBeGreaterThan(0);
    expect(degraded[0].snapshot.bars!.every(b => b.open === null)).toBe(true);
    expect(degraded[0].snapshot.missing.join(" ")).toContain("影线证据停用");
  });
  it("rejects the tiny lower shadow present in the reported L2 snapshot", () => {
    const engine = seed(), base = engine.features!;
    const bar = { ...engine.bars.at(-1)!, open: 84.51, close: 84.51, high: 84.56, low: 84.50 };
    const previous = { ...bar, close: 84.54 };
    const f = { ...base, atr: .186809, rsi: 32.9, previousRsi: 33.53, k: 7.35, previousK: 10.23, histogram: -.044899, previousHistogram: -.042478, support: 84.54 };
    const evidence = opportunityEvidence("LOW", f, [previous, bar], { price: 84.51, extreme: 84.50, bar });
    expect(evidence.near).toBe(true); expect(evidence.momentum).toBe(0);
    expect(evidence.rejection).toBeLessThan(.1); expect(evidence.priceEvidence).toBeLessThan(.45);
  });
  it("recognizes the reported H2 breakout instead of rewarding it as a resistance touch", () => {
    const engine = seed(), bar = { ...engine.bars.at(-1)!, open: 85.86, close: 86.37, high: 86.47, low: 85.86 };
    const f = { ...engine.features!, atr: .328153, resistance: 86.03, rsi: 64.65, previousRsi: 56.05, k: 72.43, previousK: 62.46, histogram: .084402, previousHistogram: .040494 };
    const evidence = opportunityEvidence("HIGH", f, [{ ...bar, close: 85.86 }, bar], { price: 86.37, extreme: 86.47, bar });
    expect(evidence.near).toBe(false); expect(evidence.breakout).toBe(true); expect(evidence.momentum).toBe(0);
  });
  it("measures the current decline from its latest observed wave origin", () => {
    const template = seed().bars.at(-1)!;
    const bars = [105, 104, 103, 102, 102.6, 102, 101.4, 101, 101.6, 101.1, 100.7].map(close => ({ ...template, close }));
    expect(localWaveOrigin(bars, "LOW", .8, "2026-11-17")).toBe(101.6);
  });
  it("plots minute closes at the same conservative completion time as the decision", () => {
    const bars = parseMinuteBars(["2026-11-17 09:58,85.00,85.74,85.89,85.00,100,857400,85.10", "2026-11-17 09:59,85.74,86.53,86.75,85.74,100,865300,85.20"]);
    const cutoff = Date.parse("2026-11-17T09:59:00+08:00");
    const chart = minuteCloseIntraday({ bars, provider: "test", fetchedAt: cutoff, missing: [] }, cutoff);
    expect(chart.points).toHaveLength(1); expect(chart.points[0]).toMatchObject({ time: "09:59", sourceTime: "09:58", price: 85.74 });
    expect(bars[0].completedAt).toBe(cutoff);
  });
});
