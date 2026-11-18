import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptKey, encryptKey, publicSettings, resolveLlm, saveModel } from "@/lib/settings";
import { PUT } from "@/app/api/settings/route";
const state = vi.hoisted(() => ({ setting: { id: 1, lastStock: "002281.SZ", prefs: {}, llm: {} as Record<string, unknown> }, test: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: () => ({ appSetting: { upsert: async () => state.setting, findUniqueOrThrow: async () => state.setting, update: state.update } }) }));
vi.mock("@/lib/analysis/reports", () => ({ testModel: state.test }));
const config = { baseUrl: "https://saved-model.invalid", model: "saved-model", apiKey: "saved-test-key", source: "界面配置" as const };
beforeEach(() => {
  state.setting.llm = {}; state.test.mockReset().mockResolvedValue({ model: "saved-model", latency: 1 });
  state.update.mockReset().mockImplementation(async ({ data }) => { Object.assign(state.setting, data); return state.setting; });
  vi.stubEnv("CONFIG_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("LLM_BASE_URL", "https://env-model.invalid"); vi.stubEnv("LLM_MODEL", "env-model"); vi.stubEnv("LLM_API_KEY", "env-test-key");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("automatic configuration priority and saving", () => {
  it("uses saved configuration first, even with the obsolete enabled flag false", async () => {
    state.setting.llm = { enabled: false, baseUrl: config.baseUrl, model: config.model, secret: encryptKey(config.apiKey) };
    const active = await resolveLlm(); expect(active?.source).toBe("界面配置"); expect(active?.model).toBe("saved-model"); expect(active?.apiKey === "saved-test-key").toBe(true);
    const publicValue = await publicSettings(); expect(publicValue.llm.source).toBe("界面配置"); expect("enabled" in publicValue.llm).toBe(false); expect(JSON.stringify(publicValue).includes("saved-test-key")).toBe(false);
  });
  it("falls back to environment only when no saved config exists, and returns null without either", async () => {
    expect((await resolveLlm())?.source).toBe("环境变量");
    vi.stubEnv("LLM_API_KEY", ""); expect(await resolveLlm()).toBeNull(); expect((await publicSettings()).llm.configured).toBe(false);
  });
  it("does not hide a damaged saved key behind the environment config", async () => {
    await saveModel(config); vi.stubEnv("CONFIG_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    await expect(resolveLlm()).rejects.toThrow(); expect((await publicSettings()).llm.error).toBeTruthy();
  });
  it("saves without a writable project directory and restores the default key after module reload", async () => {
    vi.spyOn(process, "cwd").mockReturnValue("/stocklens-read-only-project"); vi.stubEnv("CONFIG_ENCRYPTION_KEY", "");
    const request = new Request("http://localhost:3000/api/settings", { method: "PUT", headers: { origin: "http://localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify({ llm: { baseUrl: config.baseUrl, model: config.model } }) });
    const response = await PUT(request); expect(response.status).toBe(200); expect(state.test).toHaveBeenCalledTimes(1);
    expect((state.setting.llm.secret as { keySource: string }).keySource).toBe("project");
    expect((await resolveLlm())?.source).toBe("界面配置"); expect((await resolveLlm())?.apiKey === "env-test-key").toBe(true);
    vi.restoreAllMocks(); vi.resetModules();
    const reloaded = await import("@/lib/settings"); expect((await reloaded.resolveLlm())?.apiKey === "env-test-key").toBe(true);
  });
  it("uses environment encryption for new saves but keeps project-encrypted configurations readable", async () => {
    vi.stubEnv("CONFIG_ENCRYPTION_KEY", ""); await saveModel(config);
    vi.stubEnv("CONFIG_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    expect((await resolveLlm())?.apiKey === config.apiKey).toBe(true);
    await saveModel(config); expect((state.setting.llm.secret as { keySource: string }).keySource).toBe("environment");
    expect((await resolveLlm())?.apiKey === config.apiKey).toBe(true);
  });
  it("rejects an invalid configured key instead of silently changing encryption sources", async () => {
    vi.stubEnv("CONFIG_ENCRYPTION_KEY", "invalid-key");
    await expect(saveModel(config)).rejects.toThrow(/CONFIG_ENCRYPTION_KEY/); expect(state.update).not.toHaveBeenCalled();
  });
  it("preserves legacy environment ciphertext and never reads a legacy local key file", () => {
    const secret = encryptKey(config.apiKey); delete secret.keySource;
    expect(decryptKey(secret) === config.apiKey).toBe(true);
    expect(() => decryptKey({ ...secret, keySource: "local" })).toThrow(/本地文件密钥/);
  });
  it("keeps previous configuration unchanged when a connection test fails", async () => {
    await saveModel(config); const original = JSON.stringify(state.setting.llm); state.test.mockRejectedValue(new Error("连接失败"));
    const response = await PUT(new Request("http://localhost:3000/api/settings", { method: "PUT", headers: { origin: "http://localhost:3000" }, body: JSON.stringify({ llm: { baseUrl: "https://new.invalid", model: "new-model" } }) }));
    expect(response.status).toBe(400); expect(JSON.stringify(state.setting.llm)).toBe(original);
  });
});
