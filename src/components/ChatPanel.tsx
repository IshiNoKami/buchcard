import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  X, Send, Bot, User, Loader2, Trash2, Archive,
  Plus, MessageSquare, Cloud, Monitor, ChevronDown, History, Target, Check, StopCircle,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { addPaidModel, getPaidModels } from "../lib/paidModels";
import {
  ChatSession, getChats, getOrCreateActive, createChat,
  updateChatMessages, deleteChat, setActiveId as persistActiveId,
} from "../lib/chats";
import { Settings } from "../lib/types";

interface Message {
  role: "user" | "assistant";
  content: string;
  summary?: boolean; // true = auto-generated compaction of earlier turns
}

interface GoalProposal {
  goal_type: "limit" | "save";
  name: string;
  category?: string;
  budget: number;
  date_from: string;
  date_to: string;
}

interface PendingProposal extends GoalProposal {
  uid: string;
  status: "pending" | "accepted" | "rejected";
}

const COMPACT_THRESHOLD = 0.7;
const KEEP_TAIL = 2;
const MIN_WIDTH = 360;
const MAX_WIDTH = 900;
const WIDTH_KEY = "buchcard_chat_width";

// Free cloud models with tool-calling support — shown first in cloud mode
const CLOUD_PREFERRED = ["minimax-m3:cloud", "nemotron-3-super"];

function sortCloudModels(list: string[]): string[] {
  const top = CLOUD_PREFERRED.filter((p) => list.includes(p));
  const rest = list.filter((m) => !CLOUD_PREFERRED.includes(m));
  return [...top, ...rest];
}

type ConnStatus = "checking" | "online" | "offline";

interface Props {
  onClose: () => void;
  onStatusChange?: (status: ConnStatus) => void;
}

const SUGGESTIONS = [
  "Сколько я потратил за последние 3 месяца?",
  "Покажи мои траты по категориям за этот год",
  "Где я трачу больше всего денег?",
  "Хочу накопить 100 000₽ к Новому году — что можно сократить?",
];

const md: Components = {
  p:      ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em:     ({ children }) => <em className="italic">{children}</em>,
  ul:     ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
  ol:     ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
  li:     ({ children }) => <li className="text-sm">{children}</li>,
  h1:     ({ children }) => <p className="font-bold text-base mb-1">{children}</p>,
  h2:     ({ children }) => <p className="font-semibold mb-1">{children}</p>,
  h3:     ({ children }) => <p className="font-medium mb-1">{children}</p>,
  code:   ({ children }) => <code className="bg-background/50 rounded px-1 font-mono text-xs">{children}</code>,
  hr:     () => <hr className="border-border my-2" />,
  table:  ({ children }) => <div className="overflow-x-auto mb-2"><table className="w-full text-xs border-collapse">{children}</table></div>,
  thead:  ({ children }) => <thead className="bg-background/50">{children}</thead>,
  tbody:  ({ children }) => <tbody>{children}</tbody>,
  tr:     ({ children }) => <tr className="border-b border-border">{children}</tr>,
  th:     ({ children }) => <th className="text-left px-2 py-1 font-semibold text-foreground border border-border">{children}</th>,
  td:     ({ children }) => <td className="px-2 py-1 border border-border">{children}</td>,
};

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

export function ChatPanel({ onClose, onStatusChange }: Props) {
  // ── Chat sessions ────────────────────────────────────────────────────────
  const [chats, setChats] = useState<ChatSession[]>(() => getChats());
  const [activeId, setActiveIdState] = useState<string>(() => getOrCreateActive().id);
  const [messages, setMessages] = useState<Message[]>(() => getOrCreateActive().messages as Message[]);
  const [showList, setShowList] = useState(false);

  // ── Conversation runtime ─────────────────────────────────────────────────
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [statusText, setStatusText] = useState("");
  const [contextUsage, setContextUsage] = useState<{ used: number; max: number } | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [proposals, setProposals] = useState<PendingProposal[]>([]);

  // ── Connection / model ───────────────────────────────────────────────────
  const [connStatus, setConnStatus] = useState<ConnStatus>("checking");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);

  // ── Resizable width ──────────────────────────────────────────────────────
  const [width, setWidth] = useState(() => {
    const w = Number(localStorage.getItem(WIDTH_KEY));
    return w >= MIN_WIDTH && w <= MAX_WIDTH ? w : 440;
  });
  const widthRef = useRef(width);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamingRef = useRef("");
  const ignoringRef = useRef(false);

  const isCloud = !!settings && settings.endpoint.includes("ollama.com");
  const paid = getPaidModels();
  const visibleModels = isCloud
    ? sortCloudModels(models.filter((m) => !paid.includes(m)))
    : models;

  // Persist messages into the active session whenever they change.
  useEffect(() => {
    updateChatMessages(activeId, messages);
    setChats(getChats());
  }, [messages, activeId]);

  // Event stream from the backend.
  useEffect(() => {
    const unlistenToken = listen<string>("chat-token", (e) => {
      if (ignoringRef.current) return;
      streamingRef.current += e.payload;
      setStreamingText(streamingRef.current);
    });
    const unlistenReset = listen<string>("chat-reset", () => {
      if (ignoringRef.current) return;
      streamingRef.current = "";
      setStreamingText("");
    });
    const unlistenStatus = listen<string>("chat-status", (e) => {
      if (ignoringRef.current) return;
      setStatusText(e.payload);
    });
    const unlistenContext = listen<{ used: number; max: number }>("chat-context", (e) => {
      if (ignoringRef.current) return;
      setContextUsage(e.payload);
    });
    const unlistenPaid = listen<string>("chat-model-unavailable", (e) => {
      addPaidModel(e.payload);
      setModels((prev) => [...prev]); // trigger re-filter
    });
    const unlistenProposal = listen<GoalProposal>("chat-goal-proposal", (e) => {
      setProposals((prev) => [
        ...prev,
        { ...e.payload, uid: Date.now().toString(36), status: "pending" },
      ]);
    });
    const unlistenDone = listen<string>("chat-done", () => {
      if (ignoringRef.current) { ignoringRef.current = false; return; }
      const finalText = streamingRef.current;
      if (finalText) setMessages((m) => [...m, { role: "assistant", content: finalText }]);
      streamingRef.current = "";
      setStreamingText("");
      setStatusText("");
      setLoading(false);
    });
    return () => {
      unlistenToken.then((f) => f());
      unlistenReset.then((f) => f());
      unlistenStatus.then((f) => f());
      unlistenContext.then((f) => f());
      unlistenPaid.then((f) => f());
      unlistenProposal.then((f) => f());
      unlistenDone.then((f) => f());
    };
  }, []);

  // Load settings + model list once.
  const loadModels = useCallback(async (s: Settings): Promise<string[]> => {
    setLoadingModels(true);
    try {
      const list = await invoke<{ name: string }[]>("fetch_models", {
        endpoint: s.endpoint,
        apiKey: s.api_key,
      });
      const names = list.map((m) => m.name);
      setModels(names);
      return names;
    } catch {
      setModels([]);
      return [];
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    invoke<Settings>("get_settings").then((s) => {
      setSettings(s);
      loadModels(s);
    }).catch(() => {});
  }, [loadModels]);

  // Connection status polling.
  useEffect(() => {
    if (!settings) return;
    let alive = true;
    async function check() {
      try {
        const ok = await invoke<boolean>("ping_ollama", { endpoint: settings!.endpoint });
        if (!alive) return;
        const status: ConnStatus = ok ? "online" : "offline";
        setConnStatus(status);
        onStatusChange?.(status);
      } catch {
        if (!alive) return;
        setConnStatus("offline");
        onStatusChange?.("offline");
      }
    }
    check();
    const id = setInterval(check, 15000);
    return () => { alive = false; clearInterval(id); };
  }, [settings?.endpoint]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  const resetRuntime = () => {
    streamingRef.current = "";
    setStreamingText("");
    setStatusText("");
    setContextUsage(null);
    setLoading(false);
    setProposals([]);
  };

  const cancelRequest = () => {
    ignoringRef.current = true;
    resetRuntime();
    // Clear ignore flag once the pending chat-done arrives (or after timeout)
    setTimeout(() => { ignoringRef.current = false; }, 10_000);
  };

  const acceptProposal = async (p: PendingProposal) => {
    setProposals((prev) => prev.map((x) => x.uid === p.uid ? { ...x, status: "accepted" } : x));
    try {
      await invoke("create_goal", {
        name: p.name,
        goalType: p.goal_type,
        category: p.category ?? "",
        budget: p.budget,
        dateFrom: p.date_from,
        dateTo: p.date_to,
      });
      window.dispatchEvent(new CustomEvent("buchcard:goal-created"));
    } catch (e) {
      setProposals((prev) => prev.map((x) => x.uid === p.uid ? { ...x, status: "pending" } : x));
      console.error("create_goal failed", e);
      return;
    }
    setTimeout(() => setProposals((prev) => prev.filter((x) => x.uid !== p.uid)), 2500);
  };

  const rejectProposal = (uid: string) => {
    setProposals((prev) => prev.map((x) => x.uid === uid ? { ...x, status: "rejected" } : x));
    setTimeout(() => setProposals((prev) => prev.filter((x) => x.uid !== uid)), 1500);
  };

  // ── Chat session actions ─────────────────────────────────────────────────
  const newChat = () => {
    const c = createChat();
    setActiveIdState(c.id);
    setMessages([]);
    setChats(getChats());
    setShowList(false);
    resetRuntime();
  };

  const switchChat = (id: string) => {
    const c = getChats().find((x) => x.id === id);
    if (!c) return;
    persistActiveId(id);
    setActiveIdState(id);
    setMessages(c.messages as Message[]);
    setShowList(false);
    resetRuntime();
  };

  const removeChat = (id: string) => {
    deleteChat(id);
    const remaining = getChats();
    setChats(remaining);
    if (id === activeId) {
      const next = remaining[0] ?? createChat();
      persistActiveId(next.id);
      setActiveIdState(next.id);
      setMessages(next.messages as Message[]);
      resetRuntime();
    }
  };

  // ── Model / mode actions ─────────────────────────────────────────────────
  const applySettings = async (next: Settings) => {
    setSettings(next);
    try { await invoke("save_settings", { settings: next }); } catch { /* ignore */ }
  };

  const setMode = async (cloud: boolean) => {
    if (!settings) return;
    const endpoint = cloud ? "https://ollama.com" : "http://localhost:11434";
    if (endpoint === settings.endpoint) return;
    const next = { ...settings, endpoint };
    await applySettings(next);
    const names = await loadModels(next);
    setModelOpen(false);
    if (cloud) {
      const currentPaid = getPaidModels();
      const free = names.filter((m) => !currentPaid.includes(m));
      const preferred = CLOUD_PREFERRED.find((p) => free.includes(p));
      if (preferred) await applySettings({ ...next, model: preferred });
    }
  };

  const pickModel = async (m: string) => {
    if (!settings) return;
    await applySettings({ ...settings, model: m });
    setModelOpen(false);
  };

  // ── Send ─────────────────────────────────────────────────────────────────
  const send = useCallback(async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || loading || compacting) return;
    const userMsg: Message = { role: "user", content };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    setStatusText("Думаю…");
    streamingRef.current = "";
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    try {
      await invoke("chat_with_ai", {
        messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
      });
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", content: `Ошибка: ${String(e)}` }]);
      setLoading(false);
    }
  }, [input, messages, loading, compacting]);

  // ── Auto-compaction ──────────────────────────────────────────────────────
  const compact = useCallback(async () => {
    setCompacting(true);
    try {
      const head = messages.slice(0, messages.length - KEEP_TAIL);
      const tail = messages.slice(messages.length - KEEP_TAIL);
      const summary = await invoke<string>("summarize_conversation", {
        messages: head.map((m) => ({ role: m.role, content: m.content })),
      });
      setMessages([{ role: "assistant", content: summary, summary: true }, ...tail]);
      setContextUsage(null);
    } catch (e) {
      console.error("compaction failed", e);
    } finally {
      setCompacting(false);
    }
  }, [messages]);

  useEffect(() => {
    if (loading || compacting || !contextUsage) return;
    if (contextUsage.used / contextUsage.max <= COMPACT_THRESHOLD) return;
    if (messages.length <= KEEP_TAIL + 1) return;
    compact();
  }, [contextUsage, loading, compacting, messages.length, compact]);

  // ── Resize ───────────────────────────────────────────────────────────────
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(Math.max(window.innerWidth - ev.clientX, MIN_WIDTH), MAX_WIDTH);
      widthRef.current = w;
      setWidth(w);
    };
    const onUp = () => {
      document.body.style.userSelect = "";
      localStorage.setItem(WIDTH_KEY, String(widthRef.current));
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };
  const onInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
  };

  const isEmpty = messages.length === 0 && !loading;
  const contextPct = contextUsage ? Math.min(contextUsage.used / contextUsage.max, 1) : 0;
  const contextColor =
    contextPct > 0.9 ? "bg-red-500" :
    contextPct > COMPACT_THRESHOLD ? "bg-amber-500" : "bg-primary/50";

  return (
    <>
      {/* Overlay — click outside minimizes (state is persisted, reopens as-is) */}
      <div className="fixed inset-0 bg-background/50 z-40" onClick={onClose} />

      {/* Drawer */}
      <div
        className="fixed right-0 top-0 h-full z-50 flex flex-col bg-card border-l border-border shadow-2xl"
        style={{ width }}
      >
        {/* Resize handle */}
        <div
          onMouseDown={startResize}
          title="Потяните, чтобы изменить ширину"
          className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-primary/40 active:bg-primary/60 transition-colors z-10"
        />

        {/* Header */}
        <div className="border-b border-border shrink-0">
          <div className="flex items-center gap-2 px-4 py-3">
            <button
              onClick={() => setShowList((v) => !v)}
              title="Прошлые чаты"
              className={`relative h-7 w-7 flex items-center justify-center rounded-lg transition-colors ${
                showList ? "bg-accent text-foreground" : "hover:bg-accent text-muted-foreground"
              }`}
            >
              <History className="h-4 w-4" />
              {chats.length > 1 && (
                <span className="absolute -top-1 -right-1 h-4 min-w-[16px] px-0.5 rounded-full bg-primary text-primary-foreground text-[9px] font-medium flex items-center justify-center">
                  {chats.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setShowList((v) => !v)}
              className="flex-1 min-w-0 text-left group"
              title="Прошлые чаты"
            >
              <p className="text-sm font-semibold truncate flex items-center gap-1">
                {chats.find((c) => c.id === activeId)?.title || "AI Ассистент"}
                <ChevronDown className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${showList ? "rotate-180" : ""}`} />
              </p>
              <div className="flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                  connStatus === "online" ? "bg-green-500" :
                  connStatus === "offline" ? "bg-red-500" : "bg-yellow-500 animate-pulse"
                }`} />
                <span className="text-xs text-muted-foreground truncate">
                  {connStatus === "online" ? (settings?.model ?? "") :
                   connStatus === "offline" ? "Нет соединения" : "Проверка..."}
                </span>
              </div>
            </button>
            <button
              onClick={newChat}
              title="Новый чат"
              className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-accent transition-colors text-muted-foreground"
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              onClick={onClose}
              title="Свернуть"
              className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-accent transition-colors text-muted-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Model / mode selector */}
          <div className="flex items-center gap-1.5 px-4 pb-3">
            <div className="flex rounded-lg border border-border overflow-hidden shrink-0">
              <button
                onClick={() => setMode(false)}
                className={`flex items-center gap-1 px-2 py-1 text-xs transition-colors ${
                  !isCloud ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
                }`}
              >
                <Monitor className="h-3 w-3" /> Локально
              </button>
              <button
                onClick={() => setMode(true)}
                className={`flex items-center gap-1 px-2 py-1 text-xs transition-colors ${
                  isCloud ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
                }`}
              >
                <Cloud className="h-3 w-3" /> Облако
              </button>
            </div>

            <div className="relative flex-1 min-w-0">
              <button
                onClick={() => setModelOpen((v) => !v)}
                className="w-full flex items-center gap-1 px-2.5 py-1 rounded-lg border border-border text-xs text-foreground hover:bg-accent transition-colors"
              >
                <span className="truncate flex-1 text-left">{settings?.model || "выберите модель"}</span>
                {loadingModels
                  ? <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                  : <ChevronDown className="h-3 w-3 shrink-0" />}
              </button>
              {modelOpen && (
                <div className="absolute top-full left-0 right-0 mt-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-card shadow-xl z-20">
                  {visibleModels.length === 0 && (
                    <p className="px-3 py-2 text-xs text-muted-foreground">
                      {loadingModels ? "Загрузка..." : "Нет моделей. Проверьте соединение."}
                    </p>
                  )}
                  {visibleModels.map((m) => (
                    <button
                      key={m}
                      onClick={() => pickModel(m)}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors truncate ${
                        m === settings?.model ? "text-primary font-medium" : "text-foreground"
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Chat list */}
          {showList && (
            <div className="max-h-72 overflow-y-auto border-t border-border">
              <div className="flex items-center justify-between px-4 py-2 sticky top-0 bg-card">
                <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Прошлые чаты
                </span>
                <button
                  onClick={newChat}
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <Plus className="h-3 w-3" /> Новый
                </button>
              </div>
              {chats.length === 0 && (
                <p className="px-4 py-3 text-xs text-muted-foreground">Нет сохранённых чатов</p>
              )}
              {chats.map((c) => (
                <div
                  key={c.id}
                  onClick={() => switchChat(c.id)}
                  className={`flex items-center gap-2 px-4 py-2 cursor-pointer transition-colors ${
                    c.id === activeId ? "bg-accent/60" : "hover:bg-accent/40"
                  }`}
                >
                  <MessageSquare className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{c.title}</p>
                    <p className="text-[10px] text-muted-foreground">{fmtDate(c.updatedAt)}</p>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeChat(c.id); }}
                    title="Удалить чат"
                    className="p-1 text-muted-foreground/40 hover:text-red-400 transition-colors shrink-0"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {isEmpty && (
            <div className="flex flex-col items-center justify-center h-full gap-6 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
                <Bot className="h-7 w-7 text-primary" />
              </div>
              <div>
                <p className="font-medium">Финансовый помощник</p>
                <p className="text-sm text-muted-foreground mt-1 max-w-[280px]">
                  Задайте вопрос о своих расходах или попросите помочь с планированием бюджета
                </p>
              </div>
              <div className="flex flex-col gap-2 w-full max-w-[360px]">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="text-left text-sm px-4 py-2.5 rounded-xl border border-border hover:border-primary/40 hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => {
            if (m.summary) {
              return (
                <div key={i} className="flex items-start gap-2 rounded-xl border border-dashed border-border bg-muted/30 px-3 py-2.5">
                  <Archive className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium text-muted-foreground mb-1">Сводка предыдущего разговора</p>
                    <div className="text-xs text-muted-foreground/90 leading-relaxed [&_p]:mb-1 [&_p:last-child]:mb-0">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    </div>
                  </div>
                </div>
              );
            }
            return (
              <div key={i} className={`flex gap-2.5 ${m.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                <div className={`shrink-0 flex h-7 w-7 items-center justify-center rounded-full ${
                  m.role === "user" ? "bg-primary" : "bg-muted"
                }`}>
                  {m.role === "user"
                    ? <User className="h-3.5 w-3.5 text-primary-foreground" />
                    : <Bot className="h-3.5 w-3.5 text-muted-foreground" />}
                </div>
                <div className={`px-4 py-2.5 rounded-2xl text-sm ${
                  m.role === "user"
                    ? "max-w-[85%] bg-primary text-primary-foreground rounded-tr-sm whitespace-pre-wrap"
                    : "max-w-[90%] bg-muted text-foreground rounded-tl-sm"
                }`}>
                  {m.role === "user"
                    ? m.content
                    : <ReactMarkdown remarkPlugins={[remarkGfm]} components={md}>{m.content}</ReactMarkdown>}
                </div>
              </div>
            );
          })}

          {(loading || streamingText) && (
            <div className="flex gap-2.5 flex-row">
              <div className="shrink-0 flex h-7 w-7 items-center justify-center rounded-full bg-muted">
                {streamingText
                  ? <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                  : <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />}
              </div>
              <div className="max-w-[90%] px-4 py-2.5 rounded-2xl rounded-tl-sm text-sm bg-muted text-foreground">
                {streamingText ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={md}>{streamingText}</ReactMarkdown>
                ) : (
                  <span className="text-muted-foreground text-xs inline-flex items-center gap-1.5">
                    {statusText || "Думаю…"}
                    <span className="inline-flex gap-0.5">
                      <span className="h-1 w-1 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:-0.3s]" />
                      <span className="h-1 w-1 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:-0.15s]" />
                      <span className="h-1 w-1 rounded-full bg-muted-foreground/60 animate-bounce" />
                    </span>
                  </span>
                )}
              </div>
            </div>
          )}

          {compacting && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
              <Archive className="h-3.5 w-3.5 animate-pulse shrink-0" />
              Сжимаю историю разговора, чтобы продолжить без потери контекста…
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Goal proposals — rendered above input so they don't interfere with scroll */}
        {proposals.length > 0 && (
          <div className="px-4 pt-3 pb-1 border-t border-border shrink-0 space-y-2">
            {proposals.map((p) => (
              <div key={p.uid} className={`rounded-xl border px-3 py-2.5 text-sm transition-all ${
                p.status === "accepted" ? "border-emerald-500/40 bg-emerald-500/5" :
                p.status === "rejected" ? "border-border bg-muted/20 opacity-40" :
                "border-primary/30 bg-primary/5"
              }`}>
                <div className="flex items-start gap-2">
                  <div className={`mt-0.5 shrink-0 flex h-5 w-5 items-center justify-center rounded-full ${
                    p.status === "accepted" ? "bg-emerald-500/15" : "bg-primary/10"
                  }`}>
                    {p.status === "accepted"
                      ? <Check className="h-3 w-3 text-emerald-500" />
                      : <Target className="h-3 w-3 text-primary" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground text-xs leading-snug">{p.name}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {p.goal_type === "limit" ? "Лимит" : "Накопление"}
                      {p.category && <> · {p.category}</>}
                      {" · "}{p.budget.toLocaleString("ru-RU")} ₽
                      {" · "}{p.date_from} — {p.date_to}
                    </p>
                    {p.status === "accepted" && (
                      <p className="text-[11px] text-emerald-500 mt-0.5">✓ Цель добавлена в виджет</p>
                    )}
                  </div>
                  {p.status === "pending" && (
                    <div className="flex gap-1.5 shrink-0 ml-1">
                      <button
                        onClick={() => acceptProposal(p)}
                        className="px-2.5 py-1 rounded-lg bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 transition-colors"
                      >
                        Создать
                      </button>
                      <button
                        onClick={() => rejectProposal(p.uid)}
                        className="px-2 py-1 rounded-lg border border-border text-[11px] text-muted-foreground hover:bg-accent transition-colors"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Input */}
        <div className="px-4 py-4 border-t border-border shrink-0">
          {contextUsage && (
            <div className="flex items-center gap-2 mb-2" title={`Контекст: ${contextUsage.used} / ${contextUsage.max} токенов`}>
              <span className="text-[10px] text-muted-foreground shrink-0">Контекст</span>
              <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                <div className={`h-full rounded-full transition-all ${contextColor}`} style={{ width: `${Math.max(contextPct * 100, 2)}%` }} />
              </div>
              <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{Math.round(contextPct * 100)}%</span>
            </div>
          )}
          <div className="flex gap-2 items-end">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={onInput}
              onKeyDown={onKeyDown}
              placeholder="Напишите вопрос... (Enter — отправить)"
              rows={1}
              className="flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary min-h-[40px] max-h-[120px]"
            />
            {loading ? (
              <button
                onClick={cancelRequest}
                title="Остановить"
                className="h-10 w-10 shrink-0 flex items-center justify-center rounded-xl bg-muted text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
              >
                <StopCircle className="h-4 w-4" />
              </button>
            ) : (
              <button
                onClick={() => send()}
                disabled={!input.trim() || compacting}
                className="h-10 w-10 shrink-0 flex items-center justify-center rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-2 text-center">
            Shift+Enter для переноса строки
          </p>
        </div>
      </div>
    </>
  );
}
