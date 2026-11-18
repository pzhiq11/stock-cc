import { notFound } from "next/navigation";
import { Dashboard } from "@/components/dashboard";
import { isEquity, normalizeSymbol } from "@/lib/market/symbol";
export default async function StockPage({ params }: { params: Promise<{ symbol: string }> }) { let symbol: string; try { symbol = normalizeSymbol((await params).symbol); if (!isEquity(symbol)) notFound(); } catch { notFound(); } return <Dashboard key={symbol} symbol={symbol} />; }
