import { redirect } from "next/navigation";
import { appSettings } from "@/lib/settings";
export const dynamic = "force-dynamic";
export default async function Home() { let symbol = "002281.SZ"; try { symbol = (await appSettings()).lastStock; } catch { /* 页面仍提供数据库连接说明。 */ } redirect(`/stocks/${symbol}`); }
