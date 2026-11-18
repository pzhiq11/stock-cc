"use client";

import { useEffect, useRef, useState } from "react";
import type { Bar, Intraday, Point } from "@/lib/types";
import { compact, price, time } from "@/lib/format";

function tradingMinute(t: string): number { const [h, m] = t.split(":").map(Number); const v = h * 60 + m; return Math.max(0, Math.min(240, v <= 690 ? v - 570 : v < 780 ? 120 : 120 + v - 780)); }

export function StockChart({ view, intraday, bars, previousClose, signals, onPoint, days = 60 }: { view: "intraday" | "daily"; intraday: Intraday | null; bars: Bar[]; previousClose: number; signals: Point[]; onPoint: (p: Point) => void; days?: number }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => { if (!container.current) return; const observer = new ResizeObserver(entries => setWidth(Math.max(300, entries[0].contentRect.width))); observer.observe(container.current); return () => observer.disconnect(); }, []);
  useEffect(() => setHover(null), [view, days]);
  const candles = bars.slice(-days);
  const minute = intraday?.points ?? [];
  const values = view === "intraday" ? minute.map(p => p.price) : candles.flatMap(b => [b.low, b.high]);
  const left = 45, right = width - 59, top = 24, bottom = 253, volumeTop = 282, volumeBottom = 332, height = 365;
  const anchors = view === "intraday" ? signals.map(p => Number(p.pivotPrice)) : [];
  const all = [...values, ...anchors, ...(view === "intraday" && previousClose > 0 ? [previousClose] : [])];
  const min = all.length ? Math.min(...all) : 0, max = all.length ? Math.max(...all) : 1;
  const padding = Math.max((max - min) * 0.13, max * 0.002), low = min - padding, high = max + padding;
  const y = (v: number) => bottom - (v - low) / Math.max(0.001, high - low) * (bottom - top);
  const x = (i: number) => view === "intraday" ? left + tradingMinute(minute[i]?.time ?? "09:30") / 240 * (right - left) : left + (i + 0.5) / Math.max(1, candles.length) * (right - left);
  const maxVolume = Math.max(1, ...(view === "intraday" ? minute.map(p => p.volume) : candles.map(b => b.volume)));
  const graph = minute.map((p, i) => `${x(i)},${y(p.price)}`).join(" ");
  const vwap = minute.filter(p => p.average !== null && p.average > 0).map(p => `${left + tradingMinute(p.time) / 240 * (right - left)},${y(p.average!)}`).join(" ");
  const count = view === "intraday" ? minute.length : candles.length;
  const selected = hover === null ? null : view === "intraday" ? minute[hover] : candles[hover];

  function move(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect(), px = (e.clientX - rect.left) * width / rect.width;
    let nearest = 0, distance = Infinity;
    for (let i = 0; i < count; i++) { const d = Math.abs(x(i) - px); if (d < distance) { nearest = i; distance = d; } }
    setHover(count ? nearest : null);
  }

  return <div className="chart-container" ref={container}>
    {selected && <div className="chart-tooltip"><strong>{selected.time}</strong>{"price" in selected ? <><span>价格 <b>{price(selected.price)}</b></span><span>均价 <b>{price(selected.average)}</b></span><span>增量成交 <b>{compact(selected.volume, "股")}</b></span></> : <><span>开 <b>{price(selected.open)}</b> 高 <b>{price(selected.high)}</b></span><span>收 <b>{price(selected.close)}</b> 低 <b>{price(selected.low)}</b></span></>}</div>}
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} onMouseMove={move} onMouseLeave={() => setHover(null)} aria-label={view === "intraday" ? "当日实际分时价格与成交量" : "实际前复权日 K 与成交量"} role="img">
      <defs><linearGradient id="chart-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#208a78" stopOpacity=".16" /><stop offset="100%" stopColor="#208a78" stopOpacity="0" /></linearGradient></defs>
      {Array.from({ length: 5 }, (_, i) => { const p = low + (high - low) * i / 4, yy = y(p); return <g key={i}><line x1={left} x2={right} y1={yy} y2={yy} stroke="#e9edf1" strokeDasharray="3 4" /><text x={right + 10} y={yy + 4} fill="#8b949f" fontSize="11" fontFamily="inherit">{price(p)}</text>{view === "intraday" && previousClose > 0 && <text x={left - 8} y={yy + 4} fill="#a2aab3" fontSize="10" textAnchor="end">{`${((p / previousClose - 1) * 100).toFixed(1)}%`}</text>}</g>; })}
      {view === "intraday" && previousClose > 0 && <line x1={left} x2={right} y1={y(previousClose)} y2={y(previousClose)} stroke="#aab4be" strokeDasharray="5 5" />}
      {view === "intraday" ? <>
        {minute.length > 1 && <><polygon points={`${x(0)},${bottom} ${graph} ${x(minute.length - 1)},${bottom}`} fill="url(#chart-area)" /><polyline points={graph} fill="none" stroke="#218a78" strokeWidth="1.8" strokeLinejoin="round" /><polyline points={vwap} fill="none" stroke="#d3a646" strokeWidth="1.2" /></>}
        {minute.map((p, i) => <rect key={p.time} x={x(i) - 1.2} y={volumeBottom - p.volume / maxVolume * (volumeBottom - volumeTop)} width={2.4} height={p.volume / maxVolume * (volumeBottom - volumeTop)} fill={i === 0 || p.price >= minute[i - 1].price ? "#e28482" : "#73b5a5"} opacity=".65" />)}
      </> : <>
        {candles.map((b, i) => { const w = Math.min(11, (right - left) / candles.length * 0.6), color = b.close >= b.open ? "#d96866" : "#319684"; return <g key={b.time}><line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} stroke={color} /><rect x={x(i) - w / 2} y={Math.min(y(b.open), y(b.close))} width={w} height={Math.max(1.2, Math.abs(y(b.open) - y(b.close)))} fill={color} /><rect x={x(i) - w / 2} y={volumeBottom - b.volume / maxVolume * (volumeBottom - volumeTop)} width={w} height={b.volume / maxVolume * (volumeBottom - volumeTop)} fill={color} opacity=".45" /></g>; })}
        <polyline points={candles.flatMap((_, i) => i < 4 ? [] : [`${x(i)},${y(candles.slice(i - 4, i + 1).reduce((a, b) => a + b.close, 0) / 5)}`]).join(" ")} fill="none" stroke="#c4a24f" strokeWidth="1.25" />
      </>}
      <line x1={left} x2={right} y1={270} y2={270} stroke="#edf0f3" />
      <text x={left} y={281} fontSize="9" fill="#a3abb5">成交量</text>
      {view === "intraday" ? ["09:30", "10:30", "11:30", "14:00", "15:00"].map(t => <text key={t} x={left + tradingMinute(t) / 240 * (right - left)} y={353} fontSize="10" fill="#939ca7" textAnchor={t === "09:30" ? "start" : t === "15:00" ? "end" : "middle"}>{t === "11:30" ? "11:30 / 13:00" : t}</text>) : [0, Math.floor(candles.length / 3), Math.floor(candles.length * 2 / 3), candles.length - 1].map((i, j) => candles[i] ? <text key={j} x={x(i)} y={353} fontSize="10" fill="#939ca7" textAnchor={j === 0 ? "start" : j === 3 ? "end" : "middle"}>{candles[i].time.slice(5)}</text> : null)}
      {signals.map(point => {
        let xx: number;
        if (view === "intraday") { const t = time(point.pivotAt, true).split(":").map(Number); xx = left + (tradingMinute(`${t[0]}:${t[1]}`) + t[2] / 60) / 240 * (right - left); }
        else { const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(point.pivotAt)); const idx = candles.findIndex(b => b.time === date); if (idx < 0) return null; xx = x(idx); }
        const yy = y(Number(point.pivotPrice)), color = point.type === "HIGH" ? "#d36d64" : "#218a78";
        return <g key={point.id} role="button" tabIndex={0} aria-label={`${point.type === "HIGH" ? "高点" : "低点"}${point.sequenceNo} ${point.pivotPrice}`} onClick={() => onPoint(point)} onKeyDown={e => { if (e.key === "Enter") onPoint(point); }} className="chart-point"><circle cx={xx} cy={yy} r="5.5" fill={color} stroke="white" strokeWidth="2" opacity={point.riskEvents.length ? 0.45 : 1} /><text x={xx} y={yy + (point.type === "HIGH" ? -12 : 20)} fill={color} fontSize="10" textAnchor="middle" fontWeight="600">{point.type === "HIGH" ? "H" : "L"}{point.sequenceNo}</text></g>;
      })}
      {hover !== null && selected && <><line x1={x(hover)} x2={x(hover)} y1={top} y2={volumeBottom} stroke="#aab5be" strokeDasharray="3 3" />{"price" in selected && <circle cx={x(hover)} cy={y(selected.price)} r="4" fill="#218a78" stroke="white" strokeWidth="2" />}</>}
    </svg>
  </div>;
}
