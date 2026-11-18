"use client";
import { useEffect, useState } from "react";
import {
  Check,
  Database,
  KeyRound,
  Loader2,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Volume2,
} from "lucide-react";
import { Frame } from "./frame";
import { usePoll } from "./use-poll";
import { request, time } from "@/lib/format";

type Settings = {
  prefs: { sound?: boolean };
  lastStock: string;
  llm: {
    baseUrl: string;
    model: string;
    hasKey: boolean;
    configured: boolean;
    source: string;
    testedAt: string | null;
    error: string | null;
  };
};
export function SettingsPage() {
  const [revision, setRevision] = useState(0),
    [baseUrl, setBaseUrl] = useState(""),
    [model, setModel] = useState(""),
    [apiKey, setApiKey] = useState("");
  const [sound, setSound] = useState(false),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const settings = usePoll<Settings>("/api/settings", 0, revision);
  const health = usePoll<{
    database: string;
    model: string;
    monitoring: string;
    bridge: boolean;
  }>("/api/health", 0, revision);
  useEffect(() => {
    if (settings.data) {
      setBaseUrl(settings.data.llm.baseUrl || "https://api.deepseek.com");
      setModel(settings.data.llm.model || "deepseek-v4-pro");
      setSound(!!settings.data.prefs.sound);
    }
  }, [settings.data]);
  async function perform(action: "test" | "save" | "prefs") {
    setBusy(action);
    setError("");
    setMessage("");
    try {
      if (action === "test") {
        const result = await request<{ latency: number; model: string }>(
          "/api/settings/test-model",
          {
            method: "POST",
            body: JSON.stringify({
              baseUrl,
              model,
              ...(apiKey ? { apiKey } : {}),
            }),
          },
        );
        setMessage(
          `连接成功 · ${result.model} · ${(result.latency / 1000).toFixed(1)} 秒`,
        );
      } else {
        await request("/api/settings", {
          method: "PUT",
          body: JSON.stringify(
            action === "prefs"
              ? { prefs: { sound } }
              : { llm: { baseUrl, model, ...(apiKey ? { apiKey } : {}) } },
          ),
        });
        setMessage(
          action === "prefs"
            ? "提醒偏好已保存。"
            : "连接测试通过，模型配置已加密保存。",
        );
        setApiKey("");
        setRevision((i) => i + 1);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作未完成");
    } finally {
      setBusy("");
    }
  }
  return (
    <Frame active="settings">
      <div className="page-heading">
        <div>
          <div className="eyebrow">PREFERENCES / CONNECTIONS</div>
          <h1>让工作台按你的习惯运行</h1>
          <p>配置模型连接、提醒偏好，查看当前服务状态。</p>
        </div>
        <Settings2 className="heading-icon" size={28} />
      </div>
      {(error || settings.error) && (
        <div className="error-banner" role="alert">
          {error || settings.error}
        </div>
      )}
      {message && (
        <div className="info-banner" role="status">
          <Check size={16} />
          {message}
        </div>
      )}
      <div className="settings-grid">
        <div>
          <section className="card settings-card">
            <div className="card-heading">
              <h2>
                <Sparkles size={18} />
                大模型连接
              </h2>
              <span
                className={`tag ${settings.data?.llm.configured ? "green" : "neutral"}`}
              >
                {settings.data?.llm.source || "读取中"}
              </span>
            </div>
            <div className="form-body">
              <p className="muted">
                使用 OpenAI SDK，支持 GPT、DeepSeek 和兼容 Chat Completions
                的服务。优先使用已保存配置；没有时自动使用环境变量，两者都没有时暂停
                AI 调用。
              </p>
              <label>
                Base URL
                <input
                  aria-label="Base URL"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  spellCheck={false}
                  autoComplete="off"
                />
                <small>
                  GPT：https://api.openai.com/v1；DeepSeek：https://api.deepseek.com。填写接口前缀，系统追加聊天路径。
                </small>
              </label>
              <label>
                模型名称
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="填写供应商支持的 model"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label>
                API Key
                <div className="key-input">
                  <KeyRound size={16} />
                  <input
                    aria-label="API Key"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      settings.data?.llm.hasKey
                        ? "已配置密钥 · 留空继续使用"
                        : "填写你的 API Key"
                    }
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                </div>
                <small>
                  密钥不会返回浏览器；保存前加密，无需本地密钥文件。
                </small>
              </label>
              {settings.data?.llm.error && (
                <p className="inline-warning">{settings.data.llm.error}</p>
              )}
              <div className="form-actions">
                <button
                  className="button subtle"
                  disabled={!!busy || !baseUrl || !model}
                  onClick={() => void perform("test")}
                >
                  {busy === "test" ? (
                    <Loader2 className="spin" size={15} />
                  ) : (
                    <Server size={15} />
                  )}
                  测试连接
                </button>
                <button
                  className="button primary"
                  disabled={!!busy || !baseUrl || !model}
                  onClick={() => void perform("save")}
                >
                  {busy === "save" ? (
                    <Loader2 className="spin" size={15} />
                  ) : (
                    <Check size={15} />
                  )}
                  测试并保存
                </button>
              </div>
              <div className="model-footnote">
                <span>
                  {settings.data?.llm.testedAt
                    ? `上次保存测试：${new Date(settings.data.llm.testedAt).toLocaleDateString("zh-CN")} ${time(settings.data.llm.testedAt)}`
                    : "尚未保存界面配置"}
                </span>
              </div>
            </div>
          </section>
          <section className="card settings-card">
            <div className="card-heading">
              <h2>
                <Volume2 size={18} />
                点位提醒
              </h2>
            </div>
            <div className="form-body">
              <div className="preference-row">
                <div>
                  <strong>新点位声音提醒</strong>
                  <p>
                    当前页面确认新点位时短音提示；初次加载历史点位保持安静。
                  </p>
                </div>
                <button
                  className={`toggle ${sound ? "on" : ""}`}
                  role="switch"
                  aria-checked={sound}
                  aria-label="新点位声音提醒"
                  onClick={() => setSound(!sound)}
                >
                  <span />
                </button>
              </div>
              <p className="muted">
                声音播放受浏览器权限影响；页面始终显示视觉提示。
              </p>
              <button
                className="button subtle"
                disabled={!!busy}
                onClick={() => void perform("prefs")}
              >
                {busy === "prefs" ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <Check size={14} />
                )}
                保存偏好
              </button>
            </div>
          </section>
        </div>
        <aside>
          <section className="card status-card">
            <div className="card-heading">
              <h2>
                <ActivityIcon />
                服务状态
              </h2>
            </div>
            <div className="status-row">
              <Database size={17} />
              <span>PostgreSQL</span>
              <b
                className={
                  health.data?.database === "connected" ? "down" : "muted"
                }
              >
                {health.data?.database === "connected"
                  ? "已连接"
                  : health.error || "检查中"}
              </b>
            </div>
            <div className="status-row">
              <Sparkles size={17} />
              <span>AI 模型</span>
              <b>{settings.data?.llm.configured ? "已配置" : "待配置"}</b>
            </div>
            <div className="status-row">
              <Server size={17} />
              <span>AKTools 扩展</span>
              <b>{health.data?.bridge ? "已配置" : "未启用"}</b>
            </div>
            <div className="status-row">
              <ShieldCheck size={17} />
              <span>密钥加密</span>
              <b>无需文件</b>
            </div>
            <div className="status-note">
              当前监控 <strong>{health.data?.monitoring || "—"}</strong>
              <br />
              页面打开时按请求观察，关闭后停止采样。
            </div>
          </section>
          <div className="settings-note">
            <h3>简单部署，清楚的数据边界</h3>
            <p>
              本地使用本地数据库。部署时修改 DATABASE_URL
              指向线上数据库，执行迁移和初始化即可。
            </p>
            <p>
              报价、分时、日 K 和公司资料按需请求；仅配置、常看列表、确认点位和
              AI 报告持久保存。
            </p>
            <p>
              竞价和盘后分析由股票页面在对应时段发起；没有页面请求时服务保持空闲。模型未配置时保留行情与点位功能。
            </p>
          </div>
        </aside>
      </div>
    </Frame>
  );
}
function ActivityIcon() {
  return <span className="status-light" />;
}
