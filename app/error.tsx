"use client";
export default function ErrorPage({ reset }: { reset: () => void }) { return <main className="standalone-empty"><h1>页面暂时未能读取</h1><p>请检查数据库连接和服务状态，然后重试。</p><button className="button primary" onClick={reset}>重新读取</button></main>; }
