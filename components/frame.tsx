"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Activity, ArrowUpRight, Bell, BookOpen, ChevronRight, FileText, LayoutDashboard, Loader2, Plus, Search, Settings2, Sparkles, X } from "lucide-react";
import { compact, percent, price, request } from "@/lib/format";
import type { Quote, StockRef } from "@/lib/types";
import { usePoll } from "./use-poll";
import { marketPollingActive, type MarketCalendar } from "@/lib/market/schedule";

export type Watch = { symbol: string; name: string; sort: number };
type List = { stocks: Watch[]; quotes: Quote[]; current: string; sourceError: string | null; calendar?: MarketCalendar };

export function Logo() {
  return <span className="brand-mark"><svg viewBox="0 0 28 28" aria-hidden="true"><path d="m4 20 6-12 5 8 9-12M4 25l6-5 5 4 9-9" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" /></svg></span>;
}

export function Frame({ children, active = "workbench", symbol, refreshKey = 0, onWatchlistChange }: { children: React.ReactNode; active?: "workbench" | "reports" | "settings"; symbol?: string; refreshKey?: number; onWatchlistChange?: (w: Watch[]) => void }) {
  const [list, setList] = useState<List>({ stocks: [], quotes: [], current: "", sourceError: null });
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockRef[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [focused, setFocused] = useState(0);
  const [status, setStatus] = useState("正在连接");
  const [now, setNow] = useState<Date | null>(null);
  const [notice, setNotice] = useState(false);
  const router = useRouter();
  const searchRef = useRef<HTMLDivElement>(null);
  const watchlist = usePoll<List>("/api/watchlist", 15000, refreshKey);

  useEffect(() => {
    if (watchlist.data) { setList(watchlist.data); onWatchlistChange?.(watchlist.data.stocks); }
    setStatus(watchlist.error ? "连接暂不可用" : watchlist.data?.sourceError ? "行情暂时延迟" : watchlist.data ? "公开行情已连接" : "正在连接");
  }, [watchlist.data, watchlist.error, onWatchlistChange]);

  useEffect(() => { setNow(new Date()); const timer = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!query.trim()) { setResults([]); setSearching(false); return; }
    const controller = new AbortController();
    setSearching(true); setSearchError("");
    const timer = setTimeout(async () => {
      try { const data = await request<{ stocks: StockRef[] }>(`/api/stocks/search?q=${encodeURIComponent(query)}`, { signal: controller.signal }); setResults(data.stocks); setFocused(0); }
      catch (e) { if (!controller.signal.aborted) setSearchError(e instanceof Error ? e.message : "搜索失败"); }
      finally { if (!controller.signal.aborted) setSearching(false); }
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!searchRef.current?.contains(e.target as Node)) setSearchOpen(false); };
    document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close);
  }, []);

  function select(stock: StockRef) { setQuery(""); setSearchOpen(false); router.push(`/stocks/${stock.symbol}`); }
  async function remove(stock: Watch) {
    try { await request("/api/watchlist", { method: "PUT", body: JSON.stringify({ action: "remove", symbol: stock.symbol }) }); setList(old => ({ ...old, stocks: old.stocks.filter(s => s.symbol !== stock.symbol) })); onWatchlistChange?.(list.stocks.filter(s => s.symbol !== stock.symbol)); }
    catch { setStatus("列表保存失败，请重试"); }
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <Link href="/" className="brand"><Logo /><span>StockLens<small>看见走势，理性决策</small></span></Link>
      <div className="sidebar-section-label">个人投资工作台</div>
      <nav className="main-nav">
        <Link className={active === "workbench" ? "nav-item active" : "nav-item"} href={symbol ? `/stocks/${symbol}` : "/"}><LayoutDashboard size={18} /><span>股票工作台</span><ChevronRight size={14} /></Link>
        <Link className={active === "reports" ? "nav-item active" : "nav-item"} href="/reports"><FileText size={18} /><span>分析与复盘</span></Link>
        <Link className={active === "settings" ? "nav-item active" : "nav-item"} href="/settings"><Settings2 size={18} /><span>偏好设置</span></Link>
      </nav>
      <div className="watchlist-heading"><span>常看股票 <b>{list.stocks.length}</b></span><button className="sidebar-icon" title="搜索并添加股票" aria-label="搜索并添加股票" onClick={() => { document.getElementById("stock-search")?.focus(); setSearchOpen(true); }}><Plus size={17} /></button></div>
      <div className="watchlist">
        {list.stocks.map(stock => { const quote = list.quotes.find(q => q.symbol === stock.symbol); return <div className={`watch-row ${symbol === stock.symbol ? "selected" : ""}`} key={stock.symbol}>
          <Link href={`/stocks/${stock.symbol}`}><span className="watch-name">{stock.name}<small>{stock.symbol.replace(".", " · ")}</small></span><span className={`watch-value ${quote && quote.change >= 0 ? "up" : "down"}`}>{price(quote?.price)}<small>{percent(quote?.changePercent)}</small></span></Link>
          <button className="watch-remove" title={`移除${stock.name}`} aria-label={`移除${stock.name}`} onClick={() => void remove(stock)}><X size={12} /></button>
        </div>; })}
        {!list.stocks.length && <div className="sidebar-empty">搜索股票，建立你的常看列表。</div>}
      </div>
      <div className="sidebar-bottom"><div className="sidebar-note"><BookOpen size={17} /><div>少一点噪声，多一点依据<small>条件式分析 · 手动交易</small></div></div><div className="connection-status"><i className={status === "公开行情已连接" && now && marketPollingActive(now.getTime(), list.calendar) ? "live" : ""} />{now && !marketPollingActive(now.getTime(), list.calendar) && watchlist.data ? "休市 · 定时刷新已暂停" : status}</div></div>
    </aside>
    <div className="app-main">
      <header className="topbar">
        <div className="breadcrumb">市场观察 <ChevronRight size={13} /><span>{active === "settings" ? "偏好设置" : active === "reports" ? "分析与复盘" : "股票工作台"}</span></div>
        <div className="search-box" ref={searchRef}>
          <Search size={17} /><input id="stock-search" value={query} onChange={e => { setQuery(e.target.value); setSearchOpen(true); }} onFocus={() => setSearchOpen(true)} placeholder="搜索股票名称 / 代码 / 拼音" autoComplete="off" role="combobox" aria-expanded={searchOpen} aria-controls="stock-results" onKeyDown={e => { if (e.key === "Escape") setSearchOpen(false); if (e.key === "ArrowDown") { e.preventDefault(); setFocused(i => Math.min(results.length - 1, i + 1)); } if (e.key === "ArrowUp") { e.preventDefault(); setFocused(i => Math.max(0, i - 1)); } if (e.key === "Enter" && results[focused]) select(results[focused]); }} />
          {searching ? <Loader2 className="spin" size={14} /> : <kbd>/</kbd>}
          {searchOpen && query && <div id="stock-results" className="search-results" role="listbox">{results.map((r, i) => <button role="option" aria-selected={i === focused} className={i === focused ? "focused" : ""} key={r.symbol} onClick={() => select(r)}><span>{r.name}<small>{r.symbol}</small></span><ArrowUpRight size={15} /></button>)}{!searching && !results.length && <p>{searchError || "未找到对应 A 股，请尝试六位代码。"}</p>}</div>}
        </div>
        <div className="topbar-right"><span className="clock">{now ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now) : "—"}</span><div className="notification-anchor"><button className="icon-button" aria-label="查看提醒说明" onClick={() => setNotice(!notice)}><Bell size={18} /></button>{notice && <div className="notice-popover"><strong>日内点位提醒</strong><p>正式点位确认后显示在当前股票页面。历史点位不会随行情变化移动或删除。</p><Link href="/settings">设置声音提醒 <ChevronRight size={12} /></Link></div>}</div><span className="avatar">我</span></div>
      </header>
      <main className="main-content">{children}</main>
      <footer className="app-footer"><span><Activity size={12} />公开数据与条件式分析</span><span>点位以确认时信息为准 · 无账户交易接入</span></footer>
    </div>
  </div>;
}

export function Empty({ title, description, icon = "sparkles" }: { title: string; description: string; icon?: "sparkles" | "activity" }) { return <div className="empty-state"><span className="empty-icon">{icon === "activity" ? <Activity size={25} /> : <Sparkles size={25} />}</span><strong>{title}</strong><p>{description}</p></div>; }

export function Stat({ label, value, className = "" }: { label: string; value: React.ReactNode; className?: string }) { return <div className={`stat ${className}`}><span>{label}</span><strong>{value}</strong></div>; }
