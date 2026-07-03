import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Transaction, CategorizedTx, ParseResult, ProgressEvent,
  Category, PdfRow, ParsedPdf, Kopilka,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency, cn } from "@/lib/utils";
import {
  FileUp, Bot, CheckCircle2, ChevronRight, X,
  Loader2, AlertCircle, AlertTriangle, ArrowRight, PiggyBank, Link2,
} from "lucide-react";

type Step = "pick" | "parsing" | "pdf-review" | "ai" | "review" | "kopilka-link" | "done";

type DescriptionAction =
  | { type: "link"; kopilkaId: number }
  | { type: "create"; newName: string }
  | { type: "skip" };

interface EditableRow {
  id: number;
  date: string;
  amount: string;
  description: string;
  is_income: boolean;
  warning?: string;
  include: boolean;
}

interface Props {
  categories: Category[];
  onComplete: () => void;
  onClose: () => void;
}

export function ImportWizard({ categories, onComplete, onClose }: Props) {
  const [step, setStep] = useState<Step>("pick");
  const [filePath, setFilePath] = useState("");
  const [isPdf, setIsPdf] = useState(false);

  // Excel flow state
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [categorized, setCategorized] = useState<CategorizedTx[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0, last: "" });
  const [log, setLog] = useState<ProgressEvent[]>([]);
  const [editedCats, setEditedCats] = useState<Record<string, string>>({});
  const [committing, setCommitting] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Kopilka link state (post-commit step)
  const [unmatchedDescs, setUnmatchedDescs] = useState<[string, number][]>([]);
  const [kopilkas, setKopilkas] = useState<Kopilka[]>([]);
  const [descActions, setDescActions] = useState<Record<string, DescriptionAction>>({});
  const [savingLinks, setSavingLinks] = useState(false);

  // Account type selector
  const [accountType, setAccountType] = useState<"main" | "savings">("main");
  const [importKopilkaId, setImportKopilkaId] = useState<number | null>(null);
  const [importKopilkaText, setImportKopilkaText] = useState("");

  // Balance
  const [balance, setBalance] = useState("");

  // PDF flow state
  const [parsedPdf, setParsedPdf] = useState<ParsedPdf | null>(null);
  const [editableRows, setEditableRows] = useState<EditableRow[]>([]);
  const [showIncome, setShowIncome] = useState(false);
  const dragInclude = useRef<{ value: boolean } | null>(null);
  const lastClickedId = useRef<number | null>(null);

  const catNames = categories.map((c) => c.name);
  const colorMap = Object.fromEntries(categories.map((c) => [c.name, c.color]));

  useEffect(() => {
    invoke<Kopilka[]>("get_kopilkas").then(setKopilkas).catch(() => {});
  }, []);

  // ── File pick ────────────────────────────────────────────────────────────────

  const pickFile = async () => {
    let selected: string | null = null;
    try {
      selected = await openDialog({
        filters: [{ name: "Выписка Совкомбанка", extensions: ["xls", "xlsx", "pdf"] }],
        multiple: false,
      }) as string | null;
    } catch (e) {
      alert("Ошибка открытия диалога: " + String(e));
      return;
    }
    if (!selected) return;

    const path = selected;
    setFilePath(path);
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const pdf = ext === "pdf";
    setIsPdf(pdf);
    setStep("parsing");

    if (pdf) {
      try {
        const result = await invoke<ParsedPdf>("parse_pdf_preview", { path });
        setParsedPdf(result);
        // Pre-populate editable rows (all rows, income pre-unchecked)
        setEditableRows(
          result.rows.map((r) => ({
            id: r.id,
            date: r.date,
            amount: r.amount.toFixed(2),
            description: r.description,
            is_income: r.is_income,
            warning: r.warning,
            include: !r.is_income,
          }))
        );
        setStep("pdf-review");
      } catch (e) {
        alert("Ошибка чтения PDF: " + String(e));
        setStep("pick");
      }
    } else {
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
        alert("Ошибка парсинга: " + String(e));
        setStep("pick");
      }
    }
  };

  // ── PDF: confirm rows → transactions ─────────────────────────────────────────

  const confirmPdfRows = async () => {
    const confirmed = editableRows
      .filter((r) => r.include)
      .map((r) => ({
        date: r.date,
        amount: parseFloat(r.amount.replace(",", ".")) || 0,
        description: r.description,
        is_income: r.is_income,
      }));

    if (confirmed.length === 0) {
      alert("Выберите хотя бы одну строку для импорта");
      return;
    }

    setStep("parsing");
    try {
      const result = await invoke<ParseResult>("pdf_rows_to_transactions", {
        rows: confirmed,
      });
      setParseResult(result);
      if (result.new_count === 0) {
        setStep("done");
        return;
      }
      setStep("ai");
      runCategorization(result.transactions, filePath);
    } catch (e) {
      alert("Ошибка: " + String(e));
      setStep("pdf-review");
    }
  };

  // ── AI categorisation (shared) ───────────────────────────────────────────────

  const runCategorization = async (txs: Transaction[], path: string) => {
    setProgress({ done: 0, total: txs.length, last: "" });
    setLog([]);

    const unlisten = await listen<ProgressEvent>("categorize-progress", (event) => {
      setProgress({ done: event.payload.done, total: event.payload.total, last: event.payload.merchant_key });
      setLog((prev) => [...prev.slice(-49), event.payload]);
      requestAnimationFrame(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
      });
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

  // ── Commit (shared) ──────────────────────────────────────────────────────────

  const commit = async () => {
    setCommitting(true);
    const filename = filePath.split(/[\\/]/).pop() ?? "unknown";
    const approved = categorized.map((c) => ({
      tx: { ...c.tx, category: editedCats[c.tx.merchant_key] ?? c.tx.category },
      source: editedCats[c.tx.merchant_key] ? "user" : c.source,
      confidence: c.confidence,
      reasoning: c.reasoning,
    }));
    try {
      const balanceVal = balance.trim() ? parseFloat(balance.replace(/\s/g, "").replace(",", ".")) : null;

      // Resolve kopilka for savings account imports
      let finalKopilkaId: number | null = null;
      if (accountType === "savings") {
        if (importKopilkaId !== null) {
          finalKopilkaId = importKopilkaId;
        } else if (importKopilkaText.trim()) {
          finalKopilkaId = await invoke<number>("create_kopilka", {
            name: importKopilkaText.trim(),
            initialAlias: importKopilkaText.trim(),
          });
          setKopilkas(kops => [...kops, { id: finalKopilkaId!, name: importKopilkaText.trim(), aliases: [importKopilkaText.trim()] }]);
        }
      }

      await invoke("commit_import", { filename, approved, balance: balanceVal, kopilkaId: finalKopilkaId });
      onComplete();

      // Check for kopilka transactions that don't match any known alias
      const [unmatched, kops] = await Promise.all([
        invoke<[string, number][]>("find_unmatched_kopilka_descriptions"),
        invoke<Kopilka[]>("get_kopilkas"),
      ]);
      if (unmatched.length > 0) {
        const actions: Record<string, DescriptionAction> = {};
        unmatched.forEach(([desc]) => { actions[desc] = { type: "skip" }; });
        setUnmatchedDescs(unmatched);
        setKopilkas(kops);
        setDescActions(actions);
        setStep("kopilka-link");
      } else {
        setStep("done");
      }
    } catch (e) {
      console.error(e);
    } finally {
      setCommitting(false);
    }
  };

  const confirmKopilkaLinks = async () => {
    setSavingLinks(true);
    try {
      for (const [desc, action] of Object.entries(descActions)) {
        if (action.type === "link") {
          await invoke("add_kopilka_alias", { kopilkaId: action.kopilkaId, alias: desc });
        } else if (action.type === "create" && action.newName.trim()) {
          await invoke("create_kopilka", { name: action.newName.trim(), initialAlias: desc });
        }
      }
      setStep("done");
    } catch (e) {
      console.error(e);
    } finally {
      setSavingLinks(false);
    }
  };

  // ── Step indicator ───────────────────────────────────────────────────────────

  const steps = isPdf
    ? [
        { id: "pick",       label: "Файл" },
        { id: "pdf-review", label: "Строки" },
        { id: "ai",         label: "ИИ" },
        { id: "review",     label: "Проверка" },
        { id: "done",       label: "Готово" },
      ]
    : [
        { id: "pick",   label: "Файл" },
        { id: "ai",     label: "ИИ" },
        { id: "review", label: "Проверка" },
        { id: "done",   label: "Готово" },
      ];

  const stepIdx = isPdf
    ? ({ pick: 0, parsing: 0, "pdf-review": 1, ai: 2, review: 3, "kopilka-link": 4, done: 4 } as Record<string, number>)[step] ?? 0
    : ({ pick: 0, parsing: 0, ai: 1, review: 2, "kopilka-link": 3, done: 3 } as Record<string, number>)[step] ?? 0;

  // ── Helpers for editable rows ────────────────────────────────────────────────

  const visibleRows = editableRows.filter((r) => !r.is_income || showIncome);
  const allChecked = visibleRows.length > 0 && visibleRows.every((r) => r.include);
  const selectedCount = editableRows.filter((r) => r.include).length;

  const updateRow = (id: number, patch: Partial<EditableRow>) => {
    setEditableRows((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const toggleAll = (checked: boolean) => {
    setEditableRows((rows) =>
      rows.map((r) => (!r.is_income || showIncome ? { ...r, include: checked } : r))
    );
  };

  useEffect(() => {
    const onMouseUp = () => { dragInclude.current = null; };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-4xl max-h-[92vh] rounded-2xl border border-border bg-card shadow-2xl overflow-hidden flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-secondary/30 shrink-0">
          <h2 className="font-semibold text-base">Импорт выписки</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-0 px-6 pt-4 pb-2 shrink-0">
          {steps.map((s, i) => (
            <div key={s.id} className="flex items-center">
              <div
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium transition-colors",
                  i < stepIdx
                    ? "bg-emerald-500 text-white"
                    : i === stepIdx
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground"
                )}
              >
                {i < stepIdx ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
              </div>
              <span
                className={cn(
                  "ml-1.5 text-xs",
                  i === stepIdx ? "text-foreground font-medium" : "text-muted-foreground"
                )}
              >
                {s.label}
              </span>
              {i < steps.length - 1 && (
                <ChevronRight className="h-4 w-4 text-muted-foreground mx-2" />
              )}
            </div>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 min-h-0">

          {/* ── Pick ── */}
          {step === "pick" && (
            <div className="flex flex-col items-center justify-center min-h-48 gap-5">
              <div className="rounded-full bg-primary/10 p-5">
                <FileUp className="h-10 w-10 text-primary" />
              </div>
              <div className="text-center">
                <p className="font-medium">Выберите выписку Совкомбанка</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Поддерживаемые форматы: .xls, .xlsx, .pdf
                </p>
              </div>

              {/* Account type selector */}
              <div className="w-80 space-y-3">
                <div>
                  <p className="text-xs text-muted-foreground mb-2 text-center">Какой счёт в выписке?</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setAccountType("main")}
                      className={cn(
                        "flex flex-col items-center gap-1 px-3 py-2.5 rounded-lg border text-sm transition-colors",
                        accountType === "main"
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:border-primary/50"
                      )}
                    >
                      <span className="text-base">💳</span>
                      <span className="text-xs">Основной счёт</span>
                    </button>
                    <button
                      onClick={() => setAccountType("savings")}
                      className={cn(
                        "flex flex-col items-center gap-1 px-3 py-2.5 rounded-lg border text-sm transition-colors",
                        accountType === "savings"
                          ? "border-sky-500 bg-sky-500/10 text-sky-400"
                          : "border-border text-muted-foreground hover:border-sky-500/50"
                      )}
                    >
                      <PiggyBank className="h-4 w-4" />
                      <span className="text-xs">Накопительный</span>
                    </button>
                  </div>
                </div>

                {/* Kopilka selector for savings account */}
                {accountType === "savings" && (
                  <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-3 space-y-2">
                    <p className="text-xs text-sky-400 font-medium">Копилка</p>
                    <div className="relative">
                      <input
                        type="text"
                        value={importKopilkaText}
                        onChange={e => { setImportKopilkaText(e.target.value); setImportKopilkaId(null); }}
                        placeholder="Название копилки"
                        list="kopilka-list-import"
                        className="w-full px-3 py-2 rounded-lg border border-sky-500/30 bg-background text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
                      />
                      <datalist id="kopilka-list-import">
                        {kopilkas.map(k => (
                          <option key={k.id} value={k.name} />
                        ))}
                      </datalist>
                    </div>
                    {(() => {
                      const matched = kopilkas.find(k => k.name.toLowerCase() === importKopilkaText.toLowerCase());
                      if (matched && !importKopilkaId) setImportKopilkaId(matched.id);
                      return matched
                        ? <p className="text-[11px] text-sky-400">Связать с «{matched.name}»</p>
                        : importKopilkaText.trim()
                          ? <p className="text-[11px] text-muted-foreground">Будет создана новая копилка</p>
                          : <p className="text-[11px] text-muted-foreground">Введите название или выберите существующую</p>;
                    })()}
                  </div>
                )}

                {/* Balance */}
                <div>
                  <label className="text-xs text-muted-foreground block mb-1 text-center">
                    Актуальный баланс (₽) — необязательно
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={balance}
                    onChange={e => setBalance(e.target.value)}
                    placeholder="например: 24 500"
                    className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-center focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>

              <Button
                onClick={pickFile}
                size="lg"
                disabled={accountType === "savings" && !importKopilkaText.trim()}
              >
                Выбрать файл
              </Button>
              {accountType === "savings" && !importKopilkaText.trim() && (
                <p className="text-xs text-muted-foreground -mt-2">Укажите название копилки</p>
              )}
            </div>
          )}

          {/* ── Parsing spinner ── */}
          {step === "parsing" && (
            <div className="flex flex-col items-center justify-center min-h-48 gap-4">
              <Loader2 className="h-10 w-10 text-primary animate-spin" />
              <p className="text-sm text-muted-foreground">
                {isPdf ? "Распознаю PDF..." : "Читаю файл..."}
              </p>
            </div>
          )}

          {/* ── PDF row review ── */}
          {step === "pdf-review" && parsedPdf && (
            <div className="space-y-3 flex flex-col h-full">
              {/* Stats bar */}
              <div className="flex items-center gap-4 text-xs flex-wrap">
                <span className="text-muted-foreground">
                  <span className="text-red-400 font-bold">−</span> Расходов:{" "}
                  <strong className="text-foreground">
                    {editableRows.filter((r) => !r.is_income).length}
                  </strong>
                </span>
                {editableRows.some((r) => r.is_income) && (
                  <span className="text-muted-foreground">
                    <span className="text-emerald-400 font-bold">+</span> Доходов:{" "}
                    <strong className="text-foreground">
                      {editableRows.filter((r) => r.is_income).length}
                    </strong>
                    <span className="ml-1 opacity-60">(не импортируются)</span>
                  </span>
                )}
                {parsedPdf.warnings > 0 && (
                  <span className="flex items-center gap-1 text-amber-400">
                    <AlertTriangle className="h-3 w-3" />
                    {parsedPdf.warnings} строк требуют проверки
                  </span>
                )}
                <span className="text-muted-foreground ml-auto">
                  Счёт: …{parsedPdf.account.slice(-4)}
                </span>
                {editableRows.some((r) => r.is_income) && (
                  <label className="flex items-center gap-1.5 cursor-pointer text-muted-foreground hover:text-foreground">
                    <input
                      type="checkbox"
                      checked={showIncome}
                      onChange={(e) => setShowIncome(e.target.checked)}
                      className="h-3 w-3"
                    />
                    Показать доходы
                  </label>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Знак <span className="text-red-400 font-bold">−</span> = расход (импортируется), <span className="text-emerald-400 font-bold">+</span> = доход (не импортируется). Нажмите знак чтобы исправить ошибку распознавания.
              </p>

              {/* Scrollable table */}
              <div className="overflow-y-auto border border-border rounded-lg flex-1" style={{ maxHeight: "52vh" }}>
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 z-10 bg-card border-b border-border">
                    <tr className="text-[11px] text-muted-foreground">
                      <th className="py-2 pl-3 pr-1 w-8 text-left font-normal">
                        <input
                          type="checkbox"
                          checked={allChecked}
                          onChange={(e) => toggleAll(e.target.checked)}
                          className="h-3 w-3 cursor-pointer"
                        />
                      </th>
                      <th className="py-2 px-1 w-[110px] text-left font-normal">Дата</th>
                      <th className="py-2 px-1 w-[90px] text-right font-normal">Сумма ₽</th>
                      <th className="py-2 px-1 text-left font-normal">Описание</th>
                      <th className="py-2 px-1 w-5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row) => (
                      <tr
                        key={row.id}
                        onMouseEnter={() => {
                          if (dragInclude.current === null) return;
                          updateRow(row.id, { include: dragInclude.current.value });
                        }}
                        className={cn(
                          "border-b border-border/30 last:border-0 text-[11px] transition-colors",
                          row.warning && "bg-amber-500/5",
                          row.is_income && "bg-emerald-500/5",
                          !row.include && "opacity-40"
                        )}
                      >
                        <td
                          className="py-0.5 pl-3 pr-1 cursor-pointer select-none"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            if (e.shiftKey && lastClickedId.current !== null) {
                              const ids = visibleRows.map((r) => r.id);
                              const from = ids.indexOf(lastClickedId.current);
                              const to = ids.indexOf(row.id);
                              if (from !== -1 && to !== -1) {
                                const newVal = !row.include;
                                const rangeIds = new Set(
                                  ids.slice(Math.min(from, to), Math.max(from, to) + 1)
                                );
                                setEditableRows((rows) =>
                                  rows.map((r) => rangeIds.has(r.id) ? { ...r, include: newVal } : r)
                                );
                              }
                              lastClickedId.current = row.id;
                              return;
                            }
                            const newVal = !row.include;
                            updateRow(row.id, { include: newVal });
                            dragInclude.current = { value: newVal };
                            lastClickedId.current = row.id;
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={row.include}
                            readOnly
                            className="h-3 w-3 cursor-pointer pointer-events-none"
                          />
                        </td>
                        <td className="py-0.5 px-1">
                          <input
                            type="date"
                            value={row.date}
                            onChange={(e) => updateRow(row.id, { date: e.target.value })}
                            className="w-full text-[11px] bg-transparent border border-transparent hover:border-border/60 focus:border-primary focus:outline-none rounded px-1 py-0.5 cursor-pointer"
                          />
                        </td>
                        <td className="py-0.5 px-1">
                          <div className="flex items-center gap-0.5">
                            <button
                              onClick={() => updateRow(row.id, { is_income: !row.is_income })}
                              title={
                                row.is_income
                                  ? "Доход — нажмите чтобы пометить как расход"
                                  : "Расход — нажмите чтобы пометить как доход"
                              }
                              className={cn(
                                "w-4 h-4 rounded font-bold text-[13px] flex-shrink-0 flex items-center justify-center transition-colors leading-none",
                                row.is_income
                                  ? "text-emerald-400 hover:bg-emerald-500/20"
                                  : "text-red-400 hover:bg-red-500/20"
                              )}
                            >
                              {row.is_income ? "+" : "−"}
                            </button>
                            <input
                              type="number"
                              value={row.amount}
                              min="0"
                              step="0.01"
                              onChange={(e) => updateRow(row.id, { amount: e.target.value })}
                              className={cn(
                                "w-full text-right text-[11px] bg-transparent border border-transparent hover:border-border/60 focus:border-primary focus:outline-none rounded px-1 py-0.5",
                                row.is_income && "text-emerald-400/60"
                              )}
                            />
                          </div>
                        </td>
                        <td className="py-0.5 px-1">
                          <input
                            value={row.description}
                            onChange={(e) => updateRow(row.id, { description: e.target.value })}
                            className="w-full text-[11px] bg-transparent border border-transparent hover:border-border/60 focus:border-primary focus:outline-none rounded px-1 py-0.5"
                          />
                        </td>
                        <td className="py-0.5 px-1 text-center">
                          {row.warning && (
                            <span
                              title={row.warning}
                              className="text-amber-400 cursor-help text-[10px]"
                            >
                              ⚠
                            </span>
                          )}
                          {row.is_income && !row.warning && (
                            <span
                              title="Доход (приход)"
                              className="text-emerald-400 text-[10px]"
                            >
                              ↑
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── AI categorisation ── */}
          {step === "ai" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Bot className="h-5 w-5 text-primary animate-pulse" />
                <div className="flex-1">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground">
                      {progress.last ? `Обработка: ${progress.last}` : "Запуск..."}
                    </span>
                    <span className="font-medium">
                      {progress.done}/{progress.total}
                    </span>
                  </div>
                  <Progress
                    value={progress.total ? (progress.done / progress.total) * 100 : 0}
                  />
                </div>
              </div>

              <div
                ref={logRef}
                className="h-64 overflow-y-auto rounded-lg bg-background/50 border border-border p-3 space-y-1 font-mono text-xs"
              >
                {log.map((e, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Badge
                      variant={
                        e.source === "keyword"
                          ? "success"
                          : e.source === "llm"
                          ? "default"
                          : "secondary"
                      }
                      className="shrink-0 w-16 justify-center text-[10px]"
                    >
                      {e.source}
                    </Badge>
                    <span className="text-muted-foreground truncate flex-1">
                      {e.merchant_key}
                    </span>
                    <span
                      className="shrink-0"
                      style={{ color: colorMap[e.category] ?? "#9E9E9E" }}
                    >
                      {e.category}
                    </span>
                    {e.confidence !== undefined && (
                      <span className="text-muted-foreground shrink-0">
                        {(e.confidence * 100).toFixed(0)}%
                      </span>
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

          {/* ── Category review ── */}
          {step === "review" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Проверьте категории. Мерчанты с уверенностью &lt;50% выделены. Измените при необходимости.
              </p>

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
                        <div
                          key={c.tx.tx_hash}
                          className="flex items-center justify-between text-xs py-1 border-b border-border/30 last:border-0"
                        >
                          <span className="text-muted-foreground">{c.tx.merchant_key}</span>
                          <span style={{ color: colorMap[c.tx.category] }}>
                            {c.tx.category}
                          </span>
                        </div>
                      ))}
                    </div>
                  </details>
                );
              })()}

              {Array.from(
                new Map(
                  categorized
                    .filter((c) => c.source !== "keyword")
                    .map((c) => [c.tx.merchant_key, c])
                ).values()
              ).map((c) => {
                  const currentCat = editedCats[c.tx.merchant_key] ?? c.tx.category;
                  const conf = c.confidence ?? 1;
                  const isLow = conf < 0.5;
                  const total = categorized
                    .filter((x) => x.tx.merchant_key === c.tx.merchant_key)
                    .reduce((s, x) => s + x.tx.amount, 0);
                  const count = categorized.filter(
                    (x) => x.tx.merchant_key === c.tx.merchant_key
                  ).length;

                  return (
                    <div
                      key={c.tx.tx_hash}
                      className={cn(
                        "rounded-lg border p-3 transition-colors",
                        isLow
                          ? "border-amber-500/30 bg-amber-500/5"
                          : "border-border bg-secondary/20"
                      )}
                    >
                      <div className="flex items-start gap-3">
                        {isLow && (
                          <AlertCircle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium text-sm truncate">
                              {c.tx.merchant_key}
                            </span>
                            <Badge
                              variant={c.source === "llm" ? "default" : "secondary"}
                              className="text-[10px]"
                            >
                              {c.source}
                            </Badge>
                            {c.confidence !== undefined && (
                              <span
                                className={cn(
                                  "text-xs",
                                  conf < 0.3
                                    ? "text-red-400"
                                    : conf < 0.5
                                    ? "text-amber-400"
                                    : "text-muted-foreground"
                                )}
                              >
                                {(conf * 100).toFixed(0)}%
                              </span>
                            )}
                          </div>
                          {c.reasoning && (
                            <p className="text-xs text-muted-foreground mb-2 truncate">
                              {c.reasoning}
                            </p>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {count} транз. · {formatCurrency(total)}
                          </span>
                        </div>
                        <Select
                          value={currentCat}
                          onValueChange={(v) =>
                            setEditedCats((e) => ({ ...e, [c.tx.merchant_key]: v }))
                          }
                        >
                          <SelectTrigger className="w-40 shrink-0">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {catNames.map((name) => (
                              <SelectItem key={name} value={name}>
                                {name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  );
                })}
            </div>
          )}

          {/* ── Kopilka link ── */}
          {step === "kopilka-link" && (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <PiggyBank className="h-5 w-5 text-sky-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium">Связать поступления с копилкой?</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Ниже все поступления из базы. Отметьте те, которые относятся к вашей копилке — и они будут учитываться в целях накопления.
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                {unmatchedDescs.map(([desc, count]) => {
                  const action = descActions[desc] ?? { type: "skip" };
                  const shortDesc = desc.length > 70 ? desc.slice(0, 70) + "…" : desc;
                  return (
                    <div
                      key={desc}
                      className={cn(
                        "rounded-lg border p-3 space-y-2 transition-colors",
                        action.type !== "skip"
                          ? "border-sky-500/40 bg-sky-500/5"
                          : "border-border/40 bg-secondary/10"
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <Link2 className={cn("h-3.5 w-3.5 shrink-0 mt-0.5", action.type !== "skip" ? "text-sky-400" : "text-muted-foreground/40")} />
                        <span className="text-xs text-foreground flex-1 break-words">{shortDesc}</span>
                        <span className="text-[11px] text-muted-foreground shrink-0 ml-1">{count}×</span>
                      </div>

                      <div className="flex gap-2 flex-wrap pl-5">
                        <button
                          onClick={() => setDescActions(a => ({ ...a, [desc]: { type: "skip" } }))}
                          className={cn(
                            "px-2.5 py-1 rounded-md text-xs border transition-colors",
                            action.type === "skip"
                              ? "border-border bg-secondary text-foreground"
                              : "border-border/40 text-muted-foreground hover:border-border"
                          )}
                        >
                          Не копилка
                        </button>
                        <button
                          onClick={() => setDescActions(a => ({ ...a, [desc]: { type: "create", newName: "Копилочка" } }))}
                          className={cn(
                            "px-2.5 py-1 rounded-md text-xs border transition-colors",
                            action.type === "create"
                              ? "border-sky-500 bg-sky-500/10 text-sky-400"
                              : "border-border/40 text-muted-foreground hover:border-border"
                          )}
                        >
                          Это копилка
                        </button>
                        {kopilkas.length > 0 && (
                          <select
                            value={action.type === "link" ? String(action.kopilkaId) : ""}
                            onChange={e => {
                              const id = parseInt(e.target.value);
                              if (id) {
                                setDescActions(a => ({ ...a, [desc]: { type: "link", kopilkaId: id } }));
                              }
                            }}
                            className={cn(
                              "px-2.5 py-1 rounded-md text-xs border bg-background transition-colors",
                              action.type === "link"
                                ? "border-sky-500 text-sky-400"
                                : "border-border/40 text-muted-foreground"
                            )}
                          >
                            <option value="">Связать с существующей...</option>
                            {kopilkas.map(k => (
                              <option key={k.id} value={k.id}>{k.name}</option>
                            ))}
                          </select>
                        )}
                      </div>

                      {action.type === "create" && (
                        <div className="pl-5">
                          <input
                            type="text"
                            value={action.newName}
                            onChange={e => setDescActions(a => ({ ...a, [desc]: { type: "create", newName: e.target.value } }))}
                            placeholder="Название копилки"
                            className="w-full px-2.5 py-1.5 rounded-md text-xs border border-sky-500/40 bg-background focus:outline-none focus:ring-1 focus:ring-sky-500"
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Done ── */}
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
        {step === "pdf-review" && (
          <div className="px-6 py-4 border-t border-border bg-secondary/20 flex items-center justify-between shrink-0">
            <span className="text-xs text-muted-foreground">
              Будет импортировано:{" "}
              <strong className="text-red-400">
                {editableRows.filter((r) => r.include && !r.is_income).length}
              </strong>{" "}
              расходов
              {editableRows.filter((r) => r.include && r.is_income).length > 0 && (
                <span className="ml-2">
                  ·{" "}
                  <strong className="text-emerald-400">
                    {editableRows.filter((r) => r.include && r.is_income).length}
                  </strong>{" "}
                  доходов
                </span>
              )}
            </span>
            <Button onClick={confirmPdfRows} disabled={selectedCount === 0}>
              Далее — ИИ категоризация
              <ArrowRight className="h-4 w-4 ml-1.5" />
            </Button>
          </div>
        )}

        {step === "review" && (
          <div className="px-6 py-4 border-t border-border bg-secondary/20 flex justify-end shrink-0">
            <Button onClick={commit} disabled={committing} size="lg">
              {committing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Сохранение...
                </>
              ) : (
                "Подтвердить и сохранить"
              )}
            </Button>
          </div>
        )}

        {step === "kopilka-link" && (
          <div className="px-6 py-4 border-t border-border bg-secondary/20 flex items-center justify-between shrink-0">
            <button
              onClick={() => setStep("done")}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Пропустить всё
            </button>
            <Button onClick={confirmKopilkaLinks} disabled={savingLinks}>
              {savingLinks ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Сохраняем...
                </>
              ) : (
                <>
                  <PiggyBank className="h-4 w-4 mr-1.5" />
                  Сохранить связи
                </>
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
