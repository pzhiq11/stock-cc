import type { StockRef } from "@/lib/types";

export function normalizeSymbol(input: string): string {
  const v = input.trim().toUpperCase();
  let match = v.match(/^(\d{6})\.(SH|SZ|BJ)$/);
  if (match) return `${match[1]}.${match[2]}`;
  match = v.match(/^(SH|SZ|BJ)(\d{6})$/);
  if (match) return `${match[2]}.${match[1]}`;
  if (/^\d{6}$/.test(v)) {
    if (/^[56]/.test(v)) return `${v}.SH`;
    if (/^[489]/.test(v)) return `${v}.BJ`;
    return `${v}.SZ`;
  }
  throw new Error("请输入有效的六位 A 股代码。");
}

export function providerSymbol(symbol: string): string {
  const [code, exchange] = normalizeSymbol(symbol).split(".");
  return `${exchange.toLowerCase()}${code}`;
}

export function isEquity(symbol: string): boolean {
  const s = normalizeSymbol(symbol);
  return /^(60[013589]\d{3}|688\d{3})\.SH$/.test(s) || /^(00[0123]\d{3}|30[01]\d{3})\.SZ$/.test(s) || /^[489]\d{5}\.BJ$/.test(s);
}

export function ref(symbol: string, name = ""): StockRef {
  const s = normalizeSymbol(symbol);
  const [code, exchange] = s.split(".");
  return { symbol: s, code, name: name || code, exchange: exchange as StockRef["exchange"] };
}
