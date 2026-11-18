"use client";
import { useEffect, useState } from "react";
import { request } from "@/lib/format";
import { nextMarketPoll, type MarketCalendar } from "@/lib/market/schedule";

let calendar: MarketCalendar | null = null;
const calendarListeners = new Set<() => void>();
function rememberCalendar(data: unknown) {
  const value = (data as { calendar?: MarketCalendar } | null)?.calendar;
  if (!value?.date || JSON.stringify(value) === JSON.stringify(calendar)) return;
  calendar = value;
  calendarListeners.forEach(listener => listener());
}

export function usePoll<T>(url: string, interval: number, revision = 0, postCloseReports = false) {
  const [state, setState] = useState<{ url: string; data: T | null; error: string; loading: boolean }>({ url, data: null, error: "", loading: true });
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>, inFlight = false, generating = false;
    setState(old => old.url === url ? { ...old, error: "", loading: !old.data } : { url, data: null, error: "", loading: true });
    const schedule = () => {
      clearTimeout(timer);
      if (controller.signal.aborted || interval <= 0 || inFlight || document.hidden) return;
      const delay = nextMarketPoll(Date.now(), interval, calendar, postCloseReports, generating) - Date.now();
      // setTimeout 超过 32 位上限会立即触发；长假仅继续等待。
      timer = setTimeout(delay > 2147483647 ? schedule : load, Math.max(1, Math.min(delay, 2147483647)));
    };
    const load = async () => {
      if (controller.signal.aborted || document.hidden || inFlight) return;
      inFlight = true;
      try {
        const data = await request<T>(url, { signal: controller.signal });
        if (!controller.signal.aborted) { generating = postCloseReports && (data as { generating?: boolean })?.generating === true; setState({ url, data, error: "", loading: false }); rememberCalendar(data); }
      } catch (e) {
        generating = false;
        if (!controller.signal.aborted) setState(old => ({ ...old, loading: false, error: e instanceof Error ? e.message : "数据暂不可用" }));
      }
      inFlight = false; schedule();
    };
    const visible = () => { clearTimeout(timer); if (!document.hidden) void load(); };
    calendarListeners.add(schedule);
    document.addEventListener("visibilitychange", visible);
    void load(); return () => { controller.abort(); clearTimeout(timer); calendarListeners.delete(schedule); document.removeEventListener("visibilitychange", visible); };
  }, [url, interval, revision, postCloseReports]);
  return state.url === url ? state : { data: null, error: "", loading: true };
}
