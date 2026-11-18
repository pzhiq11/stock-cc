import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "StockLens · A 股智能工作台", description: "单股行情、因果日内点位与 AI 研究工作台" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="zh-CN"><body>{children}</body></html>; }
