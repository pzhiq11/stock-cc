import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSignalAdvice, reviewPoint } from "@/lib/analysis/signal-ai";
import type { Point } from "@/lib/types";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), request: vi.fn() }));
vi.mock("@/lib/settings", () => ({ resolveLlm: mocks.resolve }));
vi.mock("@/lib/analysis/model", () => ({ requestModel: mocks.request }));
const config = { baseUrl: "https://model.invalid", model: "test-only-model", apiKey: "test-only-key", source: "界面配置" };
function point(): Point { const now = Date.now(); return { id: "test", type: "HIGH", sequenceNo: 1, pivotAt: now, pivotPrice: "102.00", confirmedAt: now, quoteAtConfirmation: "102.00", ruleScore: 90, regime: "RANGE", reasons: [], invalidationRule: { price: 102.5, direction: "above" }, strategyVersion: "causal-realtime-v3.0", dataProfile: "test", mode: "live", inputSnapshot: { cutoffAt: now, samples: [], provider: "test", market: 3000, missing: [], features: { structuralSupport: 99, structuralResistance: 103 } }, riskEvents: [] }; }
beforeEach(() => { mocks.resolve.mockReset().mockResolvedValue(config); mocks.request.mockReset(); });
afterEach(() => vi.useRealTimers());
describe("AI point decisions", () => {
  it("waits for the final result and permits AI to veto without marking", async () => {
    mocks.request.mockResolvedValue({ text: '{"decision":"reject","summary":"剩余空间不足","risks":["强势突破"]}' });
    const p = point(), result = await reviewPoint(p, "002281.SZ");
    expect(result.accepted).toBe(false); expect(result.ai.status).toBe("rejected"); expect(result.ai.snapshotAt).toBe(p.pivotAt);
    const payload = JSON.parse(mocks.request.mock.calls[0][1][1].content);
    expect(payload.symbol).toBe("002281.SZ"); expect(payload.triggerPrice).toBe("102.00"); expect(payload.features.structuralSupport).toBe(99);
    expect(mocks.request.mock.calls[0][4]).toBe("signal");
  });
  it("accepts a valid approval and preserves its explanation", async () => {
    mocks.request.mockResolvedValue({ text: '```json\n{"decision":"approve","summary":"阻力区出现抛压","risks":[]}\n```' });
    const result = await reviewPoint(point()); expect(result.accepted).toBe(true); expect(result.ai.status).toBe("approved"); expect(result.ai.summary).toBe("阻力区出现抛压");
  });
  it("uses quantitative fallback for no model, failed requests and incompatible advice", async () => {
    mocks.resolve.mockResolvedValue(null); expect((await reviewPoint(point())).ai.status).toBe("not_configured"); expect(mocks.request).not.toHaveBeenCalled();
    mocks.resolve.mockResolvedValue(config); mocks.request.mockRejectedValue(new Error("模型接口不可用")); const failed = await reviewPoint(point()); expect(failed.accepted).toBe(true); expect(failed.ai.status).toBe("unavailable");
    mocks.request.mockResolvedValue({ text: "不是JSON" }); expect((await reviewPoint(point())).ai.status).toBe("unavailable");
  });
  it("caps the entire AI operation at five seconds, including config resolution", async () => {
    vi.useFakeTimers(); mocks.resolve.mockReturnValue(new Promise(() => {}));
    const p = point(), task = reviewPoint(p); let completed = false; void task.then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(4999); expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1); const result = await task;
    expect(result.accepted).toBe(true); expect(result.ai.status).toBe("unavailable"); expect(result.ai.finishedAt - result.ai.startedAt).toBe(5000); expect(mocks.request).not.toHaveBeenCalled();
  });
  it("also times out an unresponsive model and never invokes current AI for historical backfill", async () => {
    vi.useFakeTimers(); mocks.request.mockReturnValue(new Promise(() => {}));
    const task = reviewPoint(point()); await vi.advanceTimersByTimeAsync(5000); expect((await task).ai.status).toBe("unavailable");
    mocks.request.mockClear(); mocks.resolve.mockClear(); const p = point(); p.mode = "historical";
    expect((await reviewPoint(p)).ai.status).toBe("historical_skipped"); expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("rejects invented verdicts and missing or unbounded fields", () => {
    expect(() => parseSignalAdvice('{"decision":"buy","summary":"test","risks":[]}')).toThrow(/格式/);
    expect(() => parseSignalAdvice('{"decision":"approve","summary":"test"}')).toThrow(/格式/);
  });
});
