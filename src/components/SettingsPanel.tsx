import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, RefreshCw, Eye, EyeOff, Check, Play } from "lucide-react";
import { Button } from "./ui/button";
import { useTheme, THEMES, Theme } from "../lib/theme";
import { Settings } from "../lib/types";

const DAYS_RU = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const MONTHS_RU = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function nextPayDate(day: number): { date: Date; adjusted: boolean } | null {
  if (!day || day < 1 || day > 31) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const calc = (y: number, m: number) => {
    const lastDay = new Date(y, m + 1, 0).getDate();
    const d = Math.min(day, lastDay);
    const date = new Date(y, m, d);
    const dow = date.getDay();
    const adjusted = dow === 0 || dow === 6;
    if (dow === 0) date.setDate(date.getDate() - 2);
    else if (dow === 6) date.setDate(date.getDate() - 1);
    return { date, adjusted };
  };
  let y = today.getFullYear(), m = today.getMonth();
  let r = calc(y, m);
  if (r.date < today) { m++; if (m > 11) { m = 0; y++; } r = calc(y, m); }
  return r;
}

function formatPayDate(day: number): string {
  const r = nextPayDate(day);
  if (!r) return "";
  const { date, adjusted } = r;
  const d = date.getDate(), mo = MONTHS_RU[date.getMonth()], dow = DAYS_RU[date.getDay()];
  return adjusted ? `${d} ${mo} (${dow}) — перенос с ${day}-го` : `${d} ${mo} (${dow})`;
}

interface ModelInfo {
  name: string;
}

interface Props {
  onClose: () => void;
}

export function SettingsPanel({ onClose }: Props) {
  const { theme, setTheme } = useTheme();
  const [settings, setSettings] = useState<Settings>({
    endpoint: "http://localhost:11434",
    api_key: "",
    model: "qwen2.5:14b",
    advance_day: undefined,
    advance_amount: undefined,
    salary_day: undefined,
    salary_amount: undefined,
  });
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [startingOllama, setStartingOllama] = useState(false);

  useEffect(() => {
    invoke<Settings>("get_settings").then(setSettings).catch(() => {});
  }, []);

  async function loadModels() {
    setLoadingModels(true);
    setModelsError("");
    try {
      const list = await invoke<ModelInfo[]>("fetch_models", {
        endpoint: settings.endpoint,
        apiKey: settings.api_key,
      });
      setModels(list.map(m => m.name));
      if (list.length > 0 && !list.find(m => m.name === settings.model)) {
        setSettings(s => ({ ...s, model: list[0].name }));
      }
    } catch (e) {
      setModelsError(String(e));
    } finally {
      setLoadingModels(false);
    }
  }

  async function handleStartOllama() {
    setStartingOllama(true);
    setModelsError("");
    try {
      const startedVia = await invoke<string>("start_ollama");
      console.log("Ollama started via:", startedVia);

      // Poll TCP port every 2s (up to 15 attempts = 30s) — much faster than full HTTP
      let ready = false;
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000));
        ready = await invoke<boolean>("ping_ollama", { endpoint: settings.endpoint });
        if (ready) break;
      }

      if (!ready) {
        setModelsError("Ollama не ответил за 30 секунд. Попробуйте нажать ↻ вручную.");
        return;
      }

      // Port is open — now load the model list
      await loadModels();
    } catch (e) {
      setModelsError(String(e));
    } finally {
      setStartingOllama(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      await invoke("save_settings", { settings });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  const isCloud = settings.endpoint.includes("ollama.com");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md mx-4">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-semibold">Настройки</h2>
          <button onClick={onClose} className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-accent transition-colors text-muted-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-6">

          {/* Theme */}
          <section>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Тема</p>
            <div className="flex gap-2">
              {THEMES.map(t => (
                <button
                  key={t.id}
                  onClick={() => setTheme(t.id as Theme)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
                    theme === t.id
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:border-primary/50"
                  }`}
                >
                  <span className="h-3.5 w-3.5 rounded-full border border-border/60 shrink-0" style={{ background: t.dot }} />
                  {t.label}
                </button>
              ))}
            </div>
          </section>

          {/* Salary / Advance */}
          <section>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Выплаты</p>
            <div className="space-y-3">
              {(["advance", "salary"] as const).map(type => {
                const dayKey   = type === "advance" ? "advance_day"    : "salary_day";
                const amtKey   = type === "advance" ? "advance_amount" : "salary_amount";
                const label    = type === "advance" ? "Аванс" : "Зарплата";
                const dayVal   = settings[dayKey] ?? "";
                const amtVal   = settings[amtKey] ?? "";
                const preview  = dayVal ? formatPayDate(Number(dayVal)) : "";
                return (
                  <div key={type}>
                    <p className="text-xs text-muted-foreground mb-1.5">{label}</p>
                    <div className="flex gap-2 items-center">
                      <div className="relative w-20">
                        <input
                          type="number" min={1} max={31}
                          value={dayVal}
                          onChange={e => setSettings(s => ({ ...s, [dayKey]: e.target.value ? Number(e.target.value) : undefined }))}
                          placeholder="день"
                          className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                      </div>
                      <input
                        type="number" min={0}
                        value={amtVal}
                        onChange={e => setSettings(s => ({ ...s, [amtKey]: e.target.value ? Number(e.target.value) : undefined }))}
                        placeholder="сумма, ₽"
                        className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                    {preview && (
                      <p className="text-xs text-muted-foreground mt-1 pl-0.5">
                        Ближайшая выплата: <span className="text-foreground">{preview}</span>
                      </p>
                    )}
                  </div>
                );
              })}
              <p className="text-xs text-muted-foreground/70">
                Если день выплаты выпадает на выходной — переносится на пятницу перед ним.
              </p>
            </div>
          </section>

          {/* LLM Settings */}
          <section>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Модель (Ollama)</p>

            <div className="space-y-3">
              {/* Endpoint */}
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Endpoint</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSettings(s => ({ ...s, endpoint: "http://localhost:11434" }))}
                    className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                      !isCloud ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:border-primary/50"
                    }`}
                  >
                    Локальный
                  </button>
                  <button
                    onClick={() => setSettings(s => ({ ...s, endpoint: "https://ollama.com" }))}
                    className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                      isCloud ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:border-primary/50"
                    }`}
                  >
                    Ollama Cloud
                  </button>
                </div>
                <input
                  type="url"
                  value={settings.endpoint}
                  onChange={e => setSettings(s => ({ ...s, endpoint: e.target.value }))}
                  className="mt-2 w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="http://localhost:11434"
                />
              </div>

              {/* API Key */}
              <div>
                <label className="text-xs text-muted-foreground block mb-1">
                  API ключ {!isCloud && <span className="opacity-50">(не нужен для локального)</span>}
                </label>
                <div className="relative">
                  <input
                    type={showKey ? "text" : "password"}
                    value={settings.api_key}
                    onChange={e => setSettings(s => ({ ...s, api_key: e.target.value }))}
                    className="w-full px-3 py-2 pr-10 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                    placeholder={isCloud ? "ollama_..." : "—"}
                  />
                  <button
                    onClick={() => setShowKey(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {isCloud && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Получить ключ: <span className="text-primary font-mono">ollama.com/settings/keys</span>
                  </p>
                )}
              </div>

              {/* Model */}
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Модель</label>
                <div className="flex gap-2">
                  <select
                    value={settings.model}
                    onChange={e => setSettings(s => ({ ...s, model: e.target.value }))}
                    className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    {models.length === 0 && (
                      <option value={settings.model}>{settings.model}</option>
                    )}
                    {models.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                  <button
                    onClick={loadModels}
                    disabled={loadingModels}
                    title="Загрузить список моделей"
                    className="h-9 w-9 flex items-center justify-center rounded-lg border border-border hover:bg-accent transition-colors text-muted-foreground disabled:opacity-50"
                  >
                    <RefreshCw className={`h-4 w-4 ${loadingModels ? "animate-spin" : ""}`} />
                  </button>
                </div>
                {modelsError && (
                  <div className="mt-1 rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2 space-y-2">
                    <p className="text-xs text-destructive">{modelsError}</p>
                    {!isCloud && modelsError.includes("не запущен") && (
                      <button
                        onClick={handleStartOllama}
                        disabled={startingOllama}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-60 transition-colors"
                      >
                        {startingOllama
                          ? <RefreshCw className="h-3 w-3 animate-spin" />
                          : <Play className="h-3 w-3" />}
                        {startingOllama ? "Запускаем..." : "Запустить Ollama"}
                      </button>
                    )}
                    {modelsError.includes("не установлен") && (
                      <p className="text-xs text-muted-foreground">
                        Скачать: <span className="font-mono text-primary">ollama.com/download</span>
                      </p>
                    )}
                  </div>
                )}
                {models.length === 0 && !modelsError && (
                  <p className="text-xs text-muted-foreground mt-1">Нажмите ↻ чтобы загрузить список моделей</p>
                )}
              </div>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border flex justify-end gap-3">
          <Button variant="outline" onClick={onClose}>Отмена</Button>
          <Button onClick={save} disabled={saving}>
            {saved ? <><Check className="h-3.5 w-3.5 mr-1.5" />Сохранено</> : "Сохранить"}
          </Button>
        </div>
      </div>
    </div>
  );
}
