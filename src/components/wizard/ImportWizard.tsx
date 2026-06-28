import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Transaction, CategorizedTx, ParseResult, ProgressEvent, Category } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency, formatDate, cn } from "@/lib/utils";
import { FileUp, Bot, CheckCircle2, ChevronRight, X, Loader2, AlertCircle } from "lucide-react";

type Step = "pick" | "parsing" | "ai" | "review" | "done";

interface Props {
  categories: Category[];
  onComplete: () => void;
  onClose: () => void;
}

export function ImportWizard({ categories, onComplete, onClose }: Props) {
  const [step, setStep] = useState<Step>("pick");
  const [filePath, setFilePath] = useState("");
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [categorized, setCategorized] = useState<CategorizedTx[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0, last: "" });
  const [log, setLog] = useState<ProgressEvent[]>([]);
  const [editedCats, setEditedCats] = useState<Record<string, string>>({});
  const [committing, setCommitting] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const catNames = categories.map((c) => c.name);
  const colorMap = Object.fromEntries(categories.map((c) => [c.name, c.color]));

  const pickFile = async () => {
    let selected: string | null = null;
    try {
      selected = await openDialog({
        filters: [{ name: "Excel", extensions: ["xls", "xlsx"] }],
        multiple: false,
      }) as string | null;
    } catch (e) {
      console.error("Dialog error:", e);
      alert("Ошибка открытия диалога: " + String(e));
      return;
    }
    if (!selected) return;
    const path = selected;
    setFilePath(path);

    setStep("parsing");
    try {
      const result = await invoke<ParseResult>("parse_file", { path });
      setParseResult(result);
      if (result.new_count === 0) {
        setStep("done");
        return;
      }
      setStep("ai");
      runCategorization(result.transactions, path);
    } catch (e) {
      console.error("Parse error:", e);
      alert("Ошибка парсинга: " + String(e));
      setStep("pick");
    }
  };

  const runCategorization = async (txs: Transaction[], path: string) => {
    setProgress({ done: 0, total: txs.length, last: "" });
    setLog([]);

    const unlisten = await listen<ProgressEvent>("categorize-progress", (event) => {
      setProgress({ done: event.payload.done, total: event.payload.total, last: event.payload.merchant_key });
      setLog((prev) => [...prev, event.payload]);
      setTimeout(() => logRef.current?.scrollTo({ top: 99999, behavior: "smooth" }), 50);
    });

    try {
      const result = await invoke<CategorizedTx[]>("categorize_transactions", { transactions: txs });
      setCategorized(result);
      setStep("review");
    } catch (e) {
      console.error(e);
    } finally {
      unlisten();
    }
  };

  const commit = async () => {
    setCommitting(true);
    const filename = filePath.split(/[\\/]/).pop() ?? "unknown.xls";
    const approved = categorized.map((c) => ({
      tx: { ...c.tx, category: editedCats[c.tx.merchant_key] ?? c.tx.category },
      source: editedCats[c.tx.merchant_key] ? "user" : c.source,
      confidence: c.confidence,
      reasoning: c.reasoning,
    }));
    try {
      await invoke("commit_import", { filename, approved });
      setStep("done");
      onComplete();
    } catch (e) {
      console.error(e);
    } finally {
      setCommitting(false);
    }
  };

  const steps = [
    { id: "pick", label: "Файл" },
    { id: "ai", label: "ИИ" },
    { id: "review", label: "Проверка" },
    { id: "done", label: "Готово" },
  ];
  const stepIdx = { pick: 0, parsing: 0, ai: 1, review: 2, done: 3 }[step];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-3xl max-h-[90vh] rounded-2xl border border-border bg-card shadow-2xl overflow-hidden flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-secondary/30">
          <h2 className="font-semibold text-base">Импорт выписки</h2>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-0 px-6 pt-4 pb-2">
          {steps.map((s, i) => (
            <div key={s.id} className="flex items-center">
              <div className={cn("flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium transition-colors",
                i < stepIdx ? "bg-emerald-500 text-white" :
                i === stepIdx ? "bg-primary text-primary-foreground" :
                "bg-secondary text-muted-foreground")}>
                {i < stepIdx ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
              </div>
              <span className={cn("ml-1.5 text-xs", i === stepIdx ? "text-foreground font-medium" : "text-muted-foreground")}>{s.label}</span>
              {i < steps.length - 1 && <ChevronRight className="h-4 w-4 text-muted-foreground mx-2" />}
            </div>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">

          {/* Step: Pick file */}
          {(step === "pick") && (
            <div className="flex flex-col items-center justify-center min-h-48 gap-4">
              <div className="rounded-full bg-primary/10 p-5">
                <FileUp className="h-10 w-10 text-primary" />
              </div>
              <div className="text-center">
                <p className="font-medium">Выберите XLS-выписку Совкомбанка</p>
                <p className="text-sm text-muted-foreground mt-1">Формат: .xls или .xlsx</p>
              </div>
              <Button onClick={pickFile} size="lg" className="mt-2">
                Выбрать файл
              </Button>
            </div>
          )}

          {/* Step: Parsing */}
          {step === "parsing" && (
            <div className="flex flex-col items-center justify-center min-h-48 gap-4">
              <Loader2 className="h-10 w-10 text-primary animate-spin" />
              <p className="text-sm text-muted-foreground">Читаю файл...</p>
            </div>
          )}

          {/* Step: AI categorization */}
          {step === "ai" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Bot className="h-5 w-5 text-primary animate-pulse" />
                <div className="flex-1">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground">
                      {progress.last ? `Обработка: ${progress.last}` : "Запуск..."}
                    </span>
                    <span className="font-medium">{progress.done}/{progress.total}</span>
                  </div>
                  <Progress value={progress.total ? (progress.done / progress.total) * 100 : 0} />
                </div>
              </div>

              <div ref={logRef} className="h-64 overflow-y-auto rounded-lg bg-background/50 border border-border p-3 space-y-1 font-mono text-xs">
                {log.map((e, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Badge variant={e.source === "keyword" ? "success" : e.source === "llm" ? "default" : "secondary"} className="shrink-0 w-16 justify-center text-[10px]">
                      {e.source}
                    </Badge>
                    <span className="text-muted-foreground truncate flex-1">{e.merchant_key}</span>
                    <span className="shrink-0" style={{ color: Object.fromEntries(categories.map(c => [c.name, c.color]))[e.category] ?? "#9E9E9E" }}>
                      {e.category}
                    </span>
                    {e.confidence !== undefined && (
                      <span className="text-muted-foreground shrink-0">{(e.confidence * 100).toFixed(0)}%</span>
                    )}
                  </div>
                ))}
                {progress.done < progress.total && (
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> обработка...
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step: Review */}
          {step === "review" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Проверьте категории. Мерчанты с уверенностью &lt;50% выделены. Измените при необходимости.
              </p>

              {/* Keyword matches (collapsed) */}
              {(() => {
                const kw = categorized.filter((c) => c.source === "keyword");
                if (!kw.length) return null;
                return (
                  <details className="rounded-lg border border-emerald-500/20 bg-emerald-500/5">
                    <summary className="px-4 py-2.5 text-sm font-medium text-emerald-400 cursor-pointer select-none">
                      Автоматически ({kw.length} мерчантов) ✅
                    </summary>
                    <div className="px-4 pb-3 space-y-1">
                      {kw.map((c) => (
                        <div key={c.tx.tx_hash} className="flex items-center justify-between text-xs py-1 border-b border-border/30 last:border-0">
                          <span className="text-muted-foreground">{c.tx.merchant_key}</span>
                          <span style={{ color: colorMap[c.tx.category] }}>{c.tx.category}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                );
              })()}

              {/* LLM / cache — require review */}
              {categorized.filter((c) => c.source !== "keyword").map((c) => {
                const currentCat = editedCats[c.tx.merchant_key] ?? c.tx.category;
                const conf = c.confidence ?? 1;
                const isLow = conf < 0.5;
                const total = categorized.filter(x => x.tx.merchant_key === c.tx.merchant_key)
                  .reduce((s, x) => s + x.tx.amount, 0);
                const count = categorized.filter(x => x.tx.merchant_key === c.tx.merchant_key).length;

                return (
                  <div key={c.tx.tx_hash}
                    className={cn("rounded-lg border p-3 transition-colors",
                      isLow ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-secondary/20")}>
                    <div className="flex items-start gap-3">
                      {isLow && <AlertCircle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium text-sm truncate">{c.tx.merchant_key}</span>
                          <Badge variant={c.source === "llm" ? "default" : "secondary"} className="text-[10px]">{c.source}</Badge>
                          {c.confidence !== undefined && (
                            <span className={cn("text-xs", conf < 0.3 ? "text-red-400" : conf < 0.5 ? "text-amber-400" : "text-muted-foreground")}>
                              {(conf * 100).toFixed(0)}%
                            </span>
                          )}
                        </div>
                        {c.reasoning && <p className="text-xs text-muted-foreground mb-2 truncate">{c.reasoning}</p>}
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-muted-foreground">{count} транз. · {formatCurrency(total)}</span>
                        </div>
                      </div>
                      <Select value={currentCat} onValueChange={(v) => setEditedCats((e) => ({ ...e, [c.tx.merchant_key]: v }))}>
                        <SelectTrigger className="w-40 shrink-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {catNames.map((name) => (
                            <SelectItem key={name} value={name}>{name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Step: Done */}
          {step === "done" && (
            <div className="flex flex-col items-center justify-center min-h-48 gap-4">
              <div className="rounded-full bg-emerald-500/10 p-5">
                <CheckCircle2 className="h-10 w-10 text-emerald-400" />
              </div>
              <div className="text-center">
                <p className="font-medium text-lg">Импорт завершён</p>
                {parseResult && (
                  <p className="text-sm text-muted-foreground mt-1">
                    {parseResult.new_count === 0
                      ? "Все транзакции уже были в базе"
                      : `Записано ${categorized.length} транзакций`}
                  </p>
                )}
              </div>
              <Button onClick={onClose}>Открыть дашборд</Button>
            </div>
          )}
        </div>

        {/* Footer */}
        {step === "review" && (
          <div className="px-6 py-4 border-t border-border bg-secondary/20 flex justify-end">
            <Button onClick={commit} disabled={committing} size="lg">
              {committing ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Сохранение...</> : "Подтвердить и сохранить"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
