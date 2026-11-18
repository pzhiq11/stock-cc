import { afterEach, expect, it, vi } from "vitest";
import { auctionReportInput, generateReport, ReportBusyError, requestReport, testModel, validateReport } from "@/lib/analysis/reports";
import { modelBaseUrl, parseModelResult, requestModel } from "@/lib/analysis/model";
import type { AuctionSnapshot, Evidence, ReportContent } from "@/lib/types";
import * as auctionData from "@/lib/market/auction";
import * as marketData from "@/lib/market/provider";
import * as database from "@/lib/db";
import * as settings from "@/lib/settings";

const cfg = { baseUrl: "https://unit-test.invalid/v1", model: "test-model", apiKey: "test-only-secret", source: "界面配置" as const };
const evidence: Evidence[] = [{ id: "quote", title: "行情", url: "/stocks/002281.SZ", publishedAt: null, fetchedAt: "2026-11-18T02:00:00Z", publisher: "test", summary: "价格 86.60" }];
const report: ReportContent = { title: "研究", summary: "基于所给行情分析", sections: [{ title: "价格背景", body: "仅基于当前快照", evidenceIds: ["quote"] }], scenarios: [{ direction: "震荡", description: "观察 20 日背景与 2% 波动", trigger: "等待", invalidation: "变化", levels: ["86.60"], evidenceIds: ["quote"] }], risks: ["数据有限"], missing: ["财务报表"] };
const reportMessages = [{ role: "system" as const, content: "仅使用原快照，返回完整 JSON。" }, { role: "user" as const, content: JSON.stringify({ dataCutoffAt: evidence[0].fetchedAt, allowedPriceLevels: ["86.60"], evidence }) }];
const modelResponse = (content: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 5 } });
function mockSuccess() {
  const fetch = vi.fn().mockImplementation(async () => Response.json({ choices: [{ message: { content: "OK" } }], usage: { total_tokens: 5 } }));
  vi.stubGlobal("fetch", fetch); return fetch;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const auctionDate = "2026-11-18", auctionSymbol = "002281.SZ";
const auctionPayload = { rc: 0, data: { code: "002281", name: "测试股票", preClose: 85, trends: [
  "2026-11-18 09:24,85.90,85.90,85.90,85.90,0,0,85.00",
  "2026-11-18 09:26,86.60,86.60,86.60,86.60,100,866000,86.60",
  "2026-11-18 09:29,86.60,86.60,86.60,86.60,0,0,86.60",
  "2026-11-18 09:30,99.00,99.00,99.00,99.00,500,4950000,99.00",
] } };
function auctionFixture(): AuctionSnapshot {
  const stock = auctionData.parseAuctionInstrument(auctionPayload, auctionSymbol, auctionDate, Date.now());
  const board = auctionData.parseAuctionInstrument({ ...auctionPayload, data: { ...auctionPayload.data, code: "BK0448", name: "通信设备" } }, "BK0448", auctionDate, Date.now());
  return { version: 1, symbol: auctionSymbol, tradeDate: auctionDate, stock, indices: [], industry: { code: "BK0448", name: "通信设备", quote: board }, cutoffAt: stock.availableAt, capturedAt: Date.now(), missing: ["部分指数竞价数据缺失"] };
}

it("uses the SDK with a custom endpoint and bearer credential", async () => {
  const fetch = mockSuccess();
  expect((await testModel(cfg)).model).toBe(cfg.model);
  expect(fetch.mock.calls[0][0]).toBe(`${cfg.baseUrl}/chat/completions`);
  const init = fetch.mock.calls[0][1];
  expect(JSON.parse(init.body).model).toBe(cfg.model);
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${cfg.apiKey}`);
});

it("does not reject a connection test while another request is active", async () => {
  const fetch = mockSuccess();
  await Promise.all([testModel(cfg), testModel(cfg)]);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(["https://api.openai.com", "https://api.openai.com/v1", "https://api.openai.com/v1/chat/completions/"])("normalizes GPT endpoint %s and uses compatible reasoning parameters", async baseUrl => {
  const fetch = mockSuccess();
  await requestModel({ ...cfg, baseUrl, model: "gpt-5" }, [{ role: "user", content: "OK" }], 512, 5000, "signal");
  expect(fetch.mock.calls[0][0]).toBe("https://api.openai.com/v1/chat/completions");
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  expect(body.max_completion_tokens).toBeGreaterThan(512);
  expect(body.max_tokens).toBeUndefined(); expect(body.thinking).toBeUndefined(); expect(body.reasoning_effort).toBe("low");
});

it.each(["connection", "signal", "report"] as const)("uses the DeepSeek %s parameter profile without changing the endpoint", async mode => {
  const fetch = mockSuccess();
  await requestModel({ ...cfg, baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" }, [], mode === "connection" ? 256 : 512, 5000, mode);
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  expect(fetch.mock.calls[0][0]).toBe("https://api.deepseek.com/chat/completions");
  expect(body.thinking).toEqual({ type: mode === "report" ? "enabled" : "disabled" });
  expect(body.max_tokens).toBe(mode === "report" ? 8192 : mode === "connection" ? 256 : 512);
  expect(body.stream).toBe(false);
});

it("normalizes custom paths and supports older compatible model names without extra reasoning fields", async () => {
  expect(modelBaseUrl(`${cfg.baseUrl}/chat/completions`)).toBe(cfg.baseUrl);
  const fetch = mockSuccess(); await testModel(cfg);
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  expect(body.max_tokens).toBe(256); expect(body.reasoning_effort).toBeUndefined();
});

it("does not retry rate limits or expose upstream error bodies", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("secret-provider-details", { status: 429 })); vi.stubGlobal("fetch", fetch);
  await expect(testModel(cfg)).rejects.toThrow(/限流/); expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
  { baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro", explanation: "DeepSeek API 账户余额不足" },
  { baseUrl: cfg.baseUrl, model: "deepseek-v4-pro", explanation: "模型供应商返回付款或额度限制" },
])("explains HTTP 402 for $baseUrl without retries or upstream details", async ({ baseUrl, model, explanation }) => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ error: { message: "secret-provider-details" } }, { status: 402 }));
  vi.stubGlobal("fetch", fetch);
  const error = await testModel({ ...cfg, baseUrl, model }).catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain(explanation);
  expect(error.message).toContain("API Key 所属账户");
  expect(error.message).toContain("HTTP 402");
  expect(error.message).not.toContain("secret-provider-details");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("enforces the SDK timeout without automatic retries", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockImplementation((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })));
  vi.stubGlobal("fetch", fetch);
  const task = requestModel(cfg, [], 512, 5000, "signal");
  const assertion = expect(task).rejects.toThrow(/超时/);
  await vi.advanceTimersByTimeAsync(5000); await assertion;
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("extracts safe final text and distinguishes malformed, truncated and empty responses", async () => {
  expect(parseModelResult({ choices: [{ message: { content: [{ type: "text", text: "OK" }] } }], usage: { total_tokens: 5, arbitrary: "secret" } })).toEqual({ text: "OK", usage: { total_tokens: 5 } });
  expect(() => parseModelResult({ choices: [{ finish_reason: "length", message: { content: "partial" } }] })).toThrow(/预算耗尽/);
  expect(() => parseModelResult({ choices: [{ message: { content: "", reasoning_content: "private" } }] })).toThrow(/没有最终正文/);
  expect(() => parseModelResult({ output: "secret" })).toThrow(/Chat Completions/);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret-proxy-page")));
  await expect(testModel(cfg)).rejects.toThrow(/没有返回 JSON/);
});

it("validates observation prices separately from numbers in explanatory text", () => {
  expect(validateReport(report, evidence, [86.6])).toEqual(report);
  expect(() => validateReport({ ...report, scenarios: [{ ...report.scenarios[0], levels: ["20 日均线 86.60"] }] }, evidence, [86.6])).toThrow(/纯价格字符串/);
  expect(() => validateReport({ ...report, scenarios: [{ ...report.scenarios[0], levels: ["86.61"] }] }, evidence, [86.6])).toThrow(/未提供的观察价格/);
  expect(() => validateReport({ ...report, sections: [{ ...report.sections[0], evidenceIds: ["invented-source"] }] }, evidence, [86.6])).toThrow(/未提供的来源/);
  expect(() => validateReport({ title: "incomplete" }, evidence, [86.6])).toThrow(/报告结构/);
});

it("requests report JSON with reasoning budget and corrects invalid output once using the original snapshot", async () => {
  const invalid = { ...report, scenarios: [{ ...report.scenarios[0], levels: ["20 日均线 86.60"] }] };
  const fetch = vi.fn().mockResolvedValueOnce(modelResponse(invalid)).mockResolvedValueOnce(modelResponse(report));
  vi.stubGlobal("fetch", fetch);
  const result = await requestReport({ ...cfg, model: "gpt-6-luna" }, reportMessages, evidence, [86.6], "COMPANY_RESEARCH");
  expect(result).toEqual({ content: report, usage: { total_tokens: 10 }, attempts: 2 });
  expect(fetch).toHaveBeenCalledTimes(2);
  const first = JSON.parse(fetch.mock.calls[0][1].body), corrected = JSON.parse(fetch.mock.calls[1][1].body);
  expect(first.response_format).toEqual({ type: "json_object" });
  expect(first.max_completion_tokens).toBeGreaterThanOrEqual(8192);
  expect(corrected.messages.slice(0, 2)).toEqual(reportMessages);
  expect(corrected.messages.at(-1).content).toContain('["86.60"]');
});

it("stops after one correction and retains strict price validation", async () => {
  const fetch = vi.fn().mockImplementation(async () => modelResponse({ ...report, scenarios: [{ ...report.scenarios[0], levels: ["99.00"] }] }));
  vi.stubGlobal("fetch", fetch);
  await expect(requestReport(cfg, reportMessages, evidence, [86.6], "COMPANY_RESEARCH")).rejects.toThrow(/未提供的观察价格/);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("does not restart the report deadline for a correction", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-18T02:00:00Z"));
  const fetch = vi.fn().mockImplementation(async () => {
    vi.setSystemTime(Date.now() + 89000);
    return modelResponse({ title: "incomplete" });
  });
  vi.stubGlobal("fetch", fetch);
  await expect(requestReport(cfg, reportMessages, evidence, [86.6], "COMPANY_RESEARCH", 90000)).rejects.toThrow(/报告结构/);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not treat a provider failure as a report formatting error", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("secret-provider-details", { status: 429 })); vi.stubGlobal("fetch", fetch);
  await expect(requestReport(cfg, reportMessages, evidence, [86.6], "COMPANY_RESEARCH")).rejects.toThrow(/限流/);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("recovers auction results later while excluding every 09:30 and later minute", () => {
  const stock = auctionData.parseAuctionInstrument(auctionPayload, auctionSymbol, auctionDate, Date.parse(`${auctionDate}T18:00:00+08:00`));
  expect(stock.price).toBe(86.6); expect(stock.volume).toBe(10000); expect(stock.amount).toBe(866000);
  expect(stock.samples.map(s => s.price)).not.toContain(99);
  expect(stock.availableAt).toBe(Date.parse(`${auctionDate}T09:30:00+08:00`));
});

it("does not replace a missing or not-yet-available auction with opening-session prices", () => {
  expect(() => auctionData.parseAuctionInstrument({ ...auctionPayload, data: { ...auctionPayload.data, trends: auctionPayload.data.trends.slice(-1) } }, auctionSymbol, auctionDate)).toThrow(/已撮合/);
  expect(() => auctionData.parseAuctionInstrument(auctionPayload, auctionSymbol, auctionDate, Date.parse(`${auctionDate}T09:25:00+08:00`))).toThrow(/已撮合/);
  const early = auctionData.parseAuctionInstrument(auctionPayload, auctionSymbol, auctionDate, Date.parse(`${auctionDate}T09:27:00+08:00`));
  expect(early.sourceAt).toBe(Date.parse(`${auctionDate}T09:26:00+08:00`));
});

it("builds auction evidence from the frozen stock and sector only and rejects later sector data", () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(`${auctionDate}T18:00:00+08:00`));
  const snapshot = auctionFixture();
  const { input, prices } = auctionReportInput(snapshot);
  expect(input.evidence.map(e => e.id)).toEqual(["quote", "industry"]);
  expect(input.dataCutoffAt).toBe(new Date(snapshot.cutoffAt).toISOString());
  expect(prices).not.toContain(99); expect(input.analysisBasis).toBe("auction-snapshot");
  const contaminated = { ...snapshot, industry: { ...snapshot.industry!, quote: { ...snapshot.industry!.quote, sourceAt: Date.parse(`${auctionDate}T10:00:00+08:00`) } } };
  expect(auctionData.validAuctionSnapshot(contaminated, auctionSymbol, auctionDate)).toBe(false);
  expect(() => auctionReportInput(contaminated)).toThrow(/开盘后数据/);
});

it("reuses a persisted auction snapshot without an in-memory collector or new data requests", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(`${auctionDate}T18:00:00+08:00`));
  const snapshot = auctionFixture();
  const mockDb = { dailySignal: { findUnique: vi.fn().mockResolvedValue({ coverage: { auction: snapshot } }) } };
  vi.spyOn(database, "db").mockReturnValue(mockDb as unknown as ReturnType<typeof database.db>);
  const fetch = vi.fn().mockRejectedValue(new Error("must not refetch saved evidence")); vi.stubGlobal("fetch", fetch);
  expect(await auctionData.getAuctionSnapshot(auctionSymbol, auctionDate)).toBe(snapshot);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["13:00:00", "18:00:00"])("generates at %s from the saved auction, rejects a concurrent duplicate, and never loads current market data", async at => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(`${auctionDate}T${at}+08:00`));
  const snapshot = auctionFixture();
  vi.spyOn(settings, "resolveLlm").mockResolvedValue(cfg);
  const loadAuction = vi.spyOn(auctionData, "getAuctionSnapshot").mockResolvedValue(snapshot);
  const current = ["getQuote", "getCompany", "getContext", "getDaily", "getNews", "getIntraday"] as const;
  const currentCalls = current.map(name => vi.spyOn(marketData, name).mockRejectedValue(new Error("must not load later data")));
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, id: "saved-auction-report", createdAt: new Date() }));
  const dayRow = { id: "day", runtime: {}, coverage: {}, strategy: { version: "causal-realtime-v4.0" } };
  const dailySignal = { upsert: async () => structuredClone(dayRow), findUniqueOrThrow: async () => structuredClone(dayRow), update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(dayRow, structuredClone(data)); return structuredClone(dayRow); } };
  const tx = { $queryRaw: vi.fn().mockResolvedValue([]), dailySignal, analysisReport: { findFirst: vi.fn().mockResolvedValue(null), create } };
  let tail: Promise<unknown> = Promise.resolve();
  const mockDb = { dailySignal, analysisReport: { findUnique: vi.fn().mockResolvedValue(null) }, $transaction: async (work: (value: typeof tx) => unknown) => { const result = tail.then(() => work(tx)); tail = result.catch(() => {}); return result; } };
  vi.spyOn(database, "db").mockReturnValue(mockDb as unknown as ReturnType<typeof database.db>);
  const content = { ...report, scenarios: (["偏强", "震荡", "偏弱"] as const).map(direction => ({ ...report.scenarios[0], direction })) };
  const fetch = vi.fn().mockResolvedValue(modelResponse(content)); vi.stubGlobal("fetch", fetch);
  const outcomes = await Promise.allSettled([
    generateReport(auctionSymbol, "AUCTION_OUTLOOK", { force: true, requestId: "manual-first" }),
    generateReport(auctionSymbol, "AUCTION_OUTLOOK", { force: true, requestId: "manual-second" }),
  ]);
  expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
  const rejected = outcomes.find(o => o.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason).toBeInstanceOf(ReportBusyError);
  const output = outcomes.filter((o): o is PromiseFulfilledResult<Awaited<ReturnType<typeof generateReport>>> => o.status === "fulfilled").map(o => o.value);
  expect(create).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
  expect(loadAuction).toHaveBeenCalledTimes(1); currentCalls.forEach(call => expect(call).not.toHaveBeenCalled());
  expect(output[0].inputSummary.analysisBasis).toBe("auction-snapshot");
  expect(output[0].inputSummary.dataCutoffAt).toBe(new Date(snapshot.cutoffAt).toISOString());
  const input = JSON.parse(JSON.parse(fetch.mock.calls[0][1].body).messages[1].content);
  expect(input.evidence.map((e: Evidence) => e.id)).toEqual(["quote", "industry"]);
  expect(input.allowedPriceLevels).not.toContain("99.00");
});
