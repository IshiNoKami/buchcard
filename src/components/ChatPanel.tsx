import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { X, Send, Bot, User, Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Message {
  role: "user" | "assistant";
  content: string;
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

export function ChatPanel({ onClose, onStatusChange }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [connStatus, setConnStatus] = useState<ConnStatus>("checking");
  const [modelName, setModelName] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamingRef = useRef("");

  useEffect(() => {
    const unlistenToken = listen<string>("chat-token", (e) => {
      streamingRef.current += e.payload;
      setStreamingText(streamingRef.current);
    });
    const unlistenDone = listen<string>("chat-done", () => {
      const finalText = streamingRef.current;
      if (finalText) {
        setMessages((m) => [...m, { role: "assistant", content: finalText }]);
      }
      streamingRef.current = "";
      setStreamingText("");
      setLoading(false);
    });
    return () => {
      unlistenToken.then((f) => f());
      unlistenDone.then((f) => f());
    };
  }, []);

  // Connection status polling
  useEffect(() => {
    async function check() {
      try {
        const s = await invoke<{ endpoint: string; model: string; api_key: string }>("get_settings");
        setModelName(s.model);
        const ok = await invoke<boolean>("ping_ollama", { endpoint: s.endpoint });
        const status: ConnStatus = ok ? "online" : "offline";
        setConnStatus(status);
        onStatusChange?.(status);
      } catch {
        setConnStatus("offline");
        onStatusChange?.("offline");
      }
    }
    check();
    const id = setInterval(check, 15000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  const send = useCallback(async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || loading) return;

    const userMsg: Message = { role: "user", content };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    streamingRef.current = "";

    // Resize textarea back
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    try {
      await invoke("chat_with_ai", {
        messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
      });
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: `Ошибка: ${String(e)}` },
      ]);
      setLoading(false);
    }
  }, [input, messages, loading]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const onInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
  };

  const isEmpty = messages.length === 0 && !loading;

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-background/50 z-40"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-[440px] z-50 flex flex-col bg-card border-l border-border shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border shrink-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
            <Bot className="h-4 w-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">AI Ассистент</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                connStatus === "online"   ? "bg-green-500" :
                connStatus === "offline"  ? "bg-red-500" :
                "bg-yellow-500 animate-pulse"
              }`} />
              <span className="text-xs text-muted-foreground truncate">
                {connStatus === "online"  ? modelName :
                 connStatus === "offline" ? "Ollama не запущен" :
                 "Проверка..."}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-accent transition-colors text-muted-foreground"
          >
            <X className="h-4 w-4" />
          </button>
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
              <div className="flex flex-col gap-2 w-full">
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

          {messages.map((m, i) => (
            <div key={i} className={`flex gap-2.5 ${m.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
              <div className={`shrink-0 flex h-7 w-7 items-center justify-center rounded-full ${
                m.role === "user" ? "bg-primary" : "bg-muted"
              }`}>
                {m.role === "user"
                  ? <User className="h-3.5 w-3.5 text-primary-foreground" />
                  : <Bot className="h-3.5 w-3.5 text-muted-foreground" />}
              </div>
              <div className={`${m.role === "user" ? "max-w-[320px]" : "max-w-[400px]"} px-4 py-2.5 rounded-2xl text-sm ${
                m.role === "user"
                  ? "bg-primary text-primary-foreground rounded-tr-sm whitespace-pre-wrap"
                  : "bg-muted text-foreground rounded-tl-sm"
              }`}>
                {m.role === "user" ? m.content : (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
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
                    }}
                  >
                    {m.content}
                  </ReactMarkdown>
                )}
              </div>
            </div>
          ))}

          {/* Streaming message */}
          {(loading || streamingText) && (
            <div className="flex gap-2.5 flex-row">
              <div className="shrink-0 flex h-7 w-7 items-center justify-center rounded-full bg-muted">
                {streamingText
                  ? <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                  : <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />}
              </div>
              <div className="max-w-[400px] px-4 py-2.5 rounded-2xl rounded-tl-sm text-sm bg-muted text-foreground">
                {streamingText ? (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      p:      ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                      strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
                      ul:     ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
                      ol:     ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
                      li:     ({ children }) => <li className="text-sm">{children}</li>,
                      h2:     ({ children }) => <p className="font-semibold mb-1">{children}</p>,
                      code:   ({ children }) => <code className="bg-background/50 rounded px-1 font-mono text-xs">{children}</code>,
                      table:  ({ children }) => <div className="overflow-x-auto mb-2"><table className="w-full text-xs border-collapse">{children}</table></div>,
                      thead:  ({ children }) => <thead className="bg-background/50">{children}</thead>,
                      tbody:  ({ children }) => <tbody>{children}</tbody>,
                      tr:     ({ children }) => <tr className="border-b border-border">{children}</tr>,
                      th:     ({ children }) => <th className="text-left px-2 py-1 font-semibold text-foreground border border-border">{children}</th>,
                      td:     ({ children }) => <td className="px-2 py-1 border border-border">{children}</td>,
                    }}
                  >
                    {streamingText}
                  </ReactMarkdown>
                ) : (
                  <span className="text-muted-foreground text-xs">Анализирую данные...</span>
                )}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="px-4 py-4 border-t border-border shrink-0">
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
            <button
              onClick={() => send()}
              disabled={!input.trim() || loading}
              className="h-10 w-10 shrink-0 flex items-center justify-center rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-2 text-center">
            Shift+Enter для переноса строки
          </p>
        </div>
      </div>
    </>
  );
}
