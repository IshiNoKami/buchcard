import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Transaction, Category, Import, NetWorthParts, Reminder } from "./lib/types";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { KpiCards } from "./components/dashboard/KpiCards";
import { SpendingPie, TopMerchantsBar, DailyArea } from "./components/dashboard/Charts";
import { TransactionTable } from "./components/dashboard/TransactionTable";
import { ImportWizard } from "./components/wizard/ImportWizard";
import { Button } from "./components/ui/button";
import { Upload, RefreshCw, CreditCard, Calendar, Settings, MessageSquare, Trash2, ChevronDown, Wallet, SlidersHorizontal, LayoutDashboard, Target, Landmark, Scale, BellRing } from "lucide-react";
import { formatCurrency } from "./lib/utils";
import { DateRangePicker, DateRange } from "./components/ui/date-range-picker";
import { useTheme, THEMES } from "./lib/theme";
import { SettingsPanel } from "./components/SettingsPanel";
import { ChatPanel } from "./components/ChatPanel";
import { GoalsWidget } from "./components/dashboard/GoalsWidget";
import { CreditsWidget } from "./components/dashboard/CreditsWidget";
import { MonthCompare } from "./components/dashboard/MonthCompare";
import { CashForecast } from "./components/dashboard/CashForecast";
import { PlanningBlock } from "./components/dashboard/PlanningBlock";

const MONTHS_RU = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function formatPeriod(from: string, to: string): string {
  const f = new Date(from + "T00:00:00");
  const t = new Date(to + "T00:00:00");
  const fm = MONTHS_RU[f.getMonth()];
  const tm = MONTHS_RU[t.getMonth()];
  const fy = f.getFullYear();
  const ty = t.getFullYear();
  if (fy === ty && f.getMonth() === t.getMonth()) return `${fm} ${fy}`;
  if (fy === ty) return `${fm}–${tm} ${fy}`;
  return `${fm} ${fy} – ${tm} ${ty}`;
}

// Системные уведомления с анти-спамом: каждый reminder-key не чаще раза в день.
async function notifyReminders(rems: Reminder[]) {
  if (rems.length === 0) return;
  const todayKey = new Date().toISOString().slice(0, 10);
  let notified: Record<string, string> = {};
  try { notified = JSON.parse(localStorage.getItem("buchcard_notified") ?? "{}"); } catch { /* ignore */ }
  const fresh = rems.filter(r => notified[r.key] !== todayKey);
  if (fresh.length === 0) return;
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) return;
    for (const r of fresh) {
      sendNotification({ title: r.title, body: r.body });
      notified[r.key] = todayKey;
    }
    localStorage.setItem("buchcard_notified", JSON.stringify(notified));
  } catch (e) {
    console.error("notification error", e);
  }
}

export default function App() {
  const { theme, setTheme } = useTheme();
  const nextTheme = () => {
    const idx = THEMES.findIndex(t => t.id === theme);
    setTheme(THEMES[(idx + 1) % THEMES.length].id);
  };
  const currentTheme = THEMES.find(t => t.id === theme)!;

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [imports, setImports] = useState<Import[]>([]);
  const [netWorth, setNetWorth] = useState<NetWorthParts | null>(null);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [selectedImport, setSelectedImport] = useState<Import | null>(null);
  const [customRange, setCustomRange] = useState<DateRange | null>(null);
  const [period, setPeriod] = useState<"7d" | "30d" | "90d" | "all">("30d");
  const [showImports, setShowImports] = useState(false);
  const [showCatFilter, setShowCatFilter] = useState(false);
  const [tab, setTab] = useState<"overview" | "goals" | "credits">("overview");
  const [showWizard, setShowWizard] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [aiStatus, setAiStatus] = useState<"checking" | "online" | "offline">("checking");
  const [loading, setLoading] = useState(true);
  const [deleteSelection, setDeleteSelection] = useState<Set<number>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [txs, cats, imps, nw, rems] = await Promise.all([
        invoke<Transaction[]>("get_transactions"),
        invoke<Category[]>("get_categories"),
        invoke<Import[]>("get_imports"),
        invoke<NetWorthParts>("get_net_worth_parts").catch(() => null),
        invoke<Reminder[]>("get_due_reminders").catch(() => [] as Reminder[]),
      ]);
      setTransactions(txs);
      setCategories(cats);
      setImports(imps);
      setNetWorth(nw);
      setReminders(rems);
      notifyReminders(rems);
      // Notify self-contained widgets (goals) to recompute after any data change.
      window.dispatchEvent(new CustomEvent("buchcard:data-changed"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Только перезагрузка данных — визард закрывает сам себя с экрана «Готово» (onClose),
  // иначе пост-коммитные шаги (копилки, кредиты) никогда не показываются.
  const onImportComplete = () => {
    load();
  };

  const toggleDeleteSelection = (id: number) => {
    setDeleteSelection(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleBulkDelete = async () => {
    setBulkDeleting(true);
    try {
      for (const id of deleteSelection) {
        await invoke("delete_import", { importId: id });
      }
      if (selectedImport && deleteSelection.has(selectedImport.id)) setSelectedImport(null);
      setDeleteSelection(new Set());
      setConfirmBulkDelete(false);
      await load();
    } finally {
      setBulkDeleting(false);
    }
  };

  // Savings-account imports (kopilkas) are tracked separately — their transactions
  // must NOT pollute the main account's balance, KPIs or charts.
  const savingsImportIds = useMemo(
    () => new Set(imports.filter(imp => imp.kopilka_id != null).map(imp => imp.id)),
    [imports],
  );

  // Main account transactions only (exclude anything from a savings-account import)
  const mainTransactions = useMemo(
    () => transactions.filter(tx => tx.import_id == null || !savingsImportIds.has(tx.import_id)),
    [transactions, savingsImportIds],
  );

  const activeDates = useMemo(() => new Set(mainTransactions.map(tx => tx.date)), [mainTransactions]);

  // Categories the user has taken out of accounting (e.g. ambiguous transfers).
  const excludedCats = useMemo(
    () => new Set(categories.filter(c => c.excluded).map(c => c.name)),
    [categories],
  );

  const calculatedBalance = useMemo(() => {
    // The account balance is the user-entered value of the most recent MAIN-account
    // statement, rolled forward by every real main-account movement since then.
    // (Transfers/kopilka deposits DO change the real balance, so they are kept here —
    // only the spending analytics excludes them.)
    const anchor = [...imports]
      .filter(imp => imp.balance != null && imp.kopilka_id == null)
      .sort((a, b) => b.period_to.localeCompare(a.period_to))[0];
    if (!anchor) return null;
    const delta = mainTransactions
      .filter(tx => tx.date > anchor.period_to)
      .reduce((sum, tx) => sum + (tx.is_income ? tx.amount : -tx.amount), 0);
    return anchor.balance! + delta;
  }, [imports, mainTransactions]);

  const filtered = useMemo(() => {
    // If the user explicitly opens a savings-account import, show its own transactions.
    const source = (selectedImport && savingsImportIds.has(selectedImport.id))
      ? transactions.filter(tx => tx.import_id === selectedImport.id)
      : mainTransactions;

    if (selectedImport) {
      const { period_from, period_to } = selectedImport;
      return source.filter(tx => tx.date >= period_from && tx.date <= period_to);
    }
    if (customRange) {
      return source.filter(tx => tx.date >= customRange.from && tx.date <= customRange.to);
    }
    if (period !== "all") {
      const days = period === "7d" ? 7 : period === "30d" ? 30 : 90;
      const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      const to   = new Date().toISOString().slice(0, 10);
      return source.filter(tx => tx.date >= from && tx.date <= to);
    }
    return source;
  }, [transactions, mainTransactions, savingsImportIds, selectedImport, customRange, period]);

  // Transactions actually counted in analytics — excluded categories are dropped.
  const analyzed = useMemo(
    () => excludedCats.size === 0 ? filtered : filtered.filter(tx => !excludedCats.has(tx.category)),
    [filtered, excludedCats],
  );

  const toggleCategoryExcluded = useCallback(async (name: string, excluded: boolean) => {
    // Optimistic update, then persist
    setCategories(cs => cs.map(c => c.name === name ? { ...c, excluded } : c));
    try {
      await invoke("set_category_excluded", { name, excluded });
    } catch (e) {
      console.error(e);
      await load();
    }
  }, [load]);

  return (
    <div className="min-h-screen bg-background">
      {/* Sidebar */}
      <div className="fixed left-0 top-0 h-full w-14 border-r border-border bg-card flex flex-col items-center py-4 gap-4 z-40">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
          <CreditCard className="h-5 w-5 text-primary" />
        </div>
        <div className="flex-1" />
        <button
          onClick={() => setShowWizard(true)}
          title="Импорт"
          className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        >
          <Upload className="h-4 w-4" />
        </button>
        <button
          onClick={load}
          title="Обновить"
          className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
        <button
          onClick={() => setShowChat(true)}
          title="AI Ассистент"
          className="relative flex h-9 w-9 items-center justify-center rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        >
          <MessageSquare className="h-4 w-4" />
          <span className={`absolute top-1 right-1 h-2 w-2 rounded-full border border-card ${
            aiStatus === "online"  ? "bg-green-500" :
            aiStatus === "offline" ? "bg-red-500" :
            "bg-yellow-500 animate-pulse"
          }`} />
        </button>
        <button
          onClick={() => setShowSettings(true)}
          title="Настройки"
          className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>

      {/* Main content */}
      <div className="pl-14">
        <div className="max-w-7xl mx-auto px-6 py-6 space-y-5">

          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold">Buchcard</h1>
              <p className="text-xs text-muted-foreground">Учёт расходов по выпискам Совкомбанка</p>
            </div>
            <Button onClick={() => setShowWizard(true)} size="sm">
              <Upload className="h-3.5 w-3.5 mr-1.5" />
              Импорт
            </Button>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1 border-b border-border">
            {([
              ["overview", "Обзор", LayoutDashboard],
              ["goals", "Цели", Target],
              ["credits", "Кредиты", Landmark],
            ] as const).map(([id, label, Icon]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex items-center gap-1.5 px-4 py-2 text-sm border-b-2 -mb-px transition-colors ${
                  tab === id
                    ? "border-primary text-foreground font-medium"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>

          {/* ─── Обзор ─── */}
          {tab === "overview" && (
          <div className="space-y-5">

          {/* Period filter */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground shrink-0" />

              {/* Quick period buttons */}
              {(["7d", "30d", "90d", "all"] as const).map(p => (
                <button
                  key={p}
                  onClick={() => { setPeriod(p); setCustomRange(null); setSelectedImport(null); }}
                  className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                    period === p && !customRange && !selectedImport
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                  }`}
                >
                  {p === "7d" ? "7 дней" : p === "30d" ? "30 дней" : p === "90d" ? "90 дней" : "Всё"}
                </button>
              ))}

              <div className="w-px h-4 bg-border" />
              <DateRangePicker
                value={customRange}
                activeDates={activeDates}
                onChange={range => { setCustomRange(range); if (range) setSelectedImport(null); }}
              />

              {imports.length > 0 && (
                <>
                  <div className="w-px h-4 bg-border" />
                  <button
                    onClick={() => setShowImports(v => !v)}
                    className={`flex items-center gap-1 px-3 py-1 rounded-full text-xs border transition-colors ${
                      showImports || !!selectedImport
                        ? "bg-primary/10 border-primary/40 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                    }`}
                  >
                    Импорты ({imports.length})
                    <ChevronDown className={`h-3 w-3 transition-transform ${showImports ? "rotate-180" : ""}`} />
                  </button>
                </>
              )}

              <div className="w-px h-4 bg-border" />
              <button
                onClick={() => setShowCatFilter(v => !v)}
                className={`flex items-center gap-1 px-3 py-1 rounded-full text-xs border transition-colors ${
                  showCatFilter || excludedCats.size > 0
                    ? "bg-primary/10 border-primary/40 text-primary"
                    : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                }`}
                title="Какие категории учитывать в аналитике"
              >
                <SlidersHorizontal className="h-3 w-3" />
                Категории{excludedCats.size > 0 ? ` (−${excludedCats.size})` : ""}
                <ChevronDown className={`h-3 w-3 transition-transform ${showCatFilter ? "rotate-180" : ""}`} />
              </button>
            </div>

            {/* Collapsible category filter */}
            {showCatFilter && (
              <div className="pl-5 space-y-2">
                <p className="text-[11px] text-muted-foreground">
                  Снятые категории не учитываются в балансе, KPI и графиках. Удобно для переводов и взаимозачётов.
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  {categories.map(c => {
                    const on = !c.excluded;
                    return (
                      <button
                        key={c.name}
                        onClick={() => toggleCategoryExcluded(c.name, on)}
                        className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs border transition-colors ${
                          on
                            ? "border-border text-foreground hover:border-primary/50"
                            : "border-dashed border-border/60 text-muted-foreground/50 line-through"
                        }`}
                        title={on ? "Учитывается — нажмите чтобы снять" : "Снято — нажмите чтобы вернуть"}
                      >
                        <span
                          className="h-2.5 w-2.5 rounded-full shrink-0"
                          style={{ background: on ? c.color : "transparent", border: on ? "none" : `1.5px solid ${c.color}` }}
                        />
                        {c.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Collapsible import pills */}
            {showImports && imports.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap pl-5">
                {imports.map(imp => {
                  const marked = deleteSelection.has(imp.id);
                  return (
                    <div key={imp.id} className="flex items-center gap-0.5">
                      <button
                        onClick={() => {
                          if (!marked) {
                            setCustomRange(null);
                            setSelectedImport(prev => prev?.id === imp.id ? null : imp);
                          }
                        }}
                        title={imp.filename}
                        className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                          marked
                            ? "border-red-400 text-red-400 line-through"
                            : selectedImport?.id === imp.id
                            ? "bg-primary text-primary-foreground border-primary"
                            : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                        }`}
                      >
                        {formatPeriod(imp.period_from, imp.period_to)}
                      </button>
                      <button
                        onClick={() => toggleDeleteSelection(imp.id)}
                        title={marked ? "Снять отметку" : "Отметить для удаления"}
                        className={`p-1 transition-colors ${marked ? "text-red-400" : "text-muted-foreground/50 hover:text-red-400"}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}
                {deleteSelection.size > 0 && (
                  <button
                    onClick={() => setConfirmBulkDelete(true)}
                    className="px-3 py-1 rounded-full text-xs border border-red-400 text-red-400 hover:bg-red-400/10 transition-colors"
                  >
                    Удалить ({deleteSelection.size})
                  </button>
                )}
              </div>
            )}
          </div>

          {filtered.length === 0 && !loading ? (
            <div className="flex flex-col items-center justify-center h-96 gap-4 rounded-2xl border border-dashed border-border">
              <CreditCard className="h-12 w-12 text-muted-foreground/40" />
              <div className="text-center">
                <p className="font-medium text-muted-foreground">Нет данных</p>
                <p className="text-sm text-muted-foreground/60 mt-1">Импортируйте выписку Совкомбанка чтобы начать</p>
              </div>
              <Button onClick={() => setShowWizard(true)}>
                <Upload className="h-4 w-4 mr-2" />
                Импортировать выписку
              </Button>
            </div>
          ) : (
            <>
              {reminders.length > 0 && (
                <div className="space-y-2">
                  {reminders.map(r => (
                    <div key={r.key} className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                      <BellRing className="h-4 w-4 text-amber-400 shrink-0" />
                      <p className="text-xs text-amber-400">
                        <span className="font-medium">{r.title}:</span> {r.body}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-stretch gap-3 flex-wrap">
                {calculatedBalance != null && (
                  <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 w-fit">
                    <Wallet className="h-4 w-4 text-sky-400 shrink-0" />
                    <div>
                      <p className="text-[11px] text-muted-foreground leading-none mb-0.5">Баланс счёта</p>
                      <p className={`text-lg font-bold leading-none ${calculatedBalance >= 0 ? "text-sky-400" : "text-red-400"}`}>
                        {formatCurrency(calculatedBalance)}
                      </p>
                    </div>
                  </div>
                )}
                {netWorth && (netWorth.kopilka_total > 0 || netWorth.credit_debt > 0) && (() => {
                  const total = (calculatedBalance ?? 0) + netWorth.kopilka_total - netWorth.credit_debt;
                  return (
                    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 w-fit">
                      <Scale className="h-4 w-4 text-violet-400 shrink-0" />
                      <div>
                        <p className="text-[11px] text-muted-foreground leading-none mb-0.5">Чистая стоимость</p>
                        <p className={`text-lg font-bold leading-none ${total >= 0 ? "text-violet-400" : "text-red-400"}`}>
                          {formatCurrency(total)}
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-1 leading-none">
                          {netWorth.kopilka_total > 0 && <span className="text-emerald-400/80">+копилки {formatCurrency(netWorth.kopilka_total)}</span>}
                          {netWorth.kopilka_total > 0 && netWorth.credit_debt > 0 && " · "}
                          {netWorth.credit_debt > 0 && <span className="text-red-400/80">−долги {formatCurrency(netWorth.credit_debt)}</span>}
                        </p>
                      </div>
                    </div>
                  );
                })()}
              </div>
              {calculatedBalance != null && <CashForecast currentBalance={calculatedBalance} />}

              <PlanningBlock />

              <KpiCards transactions={analyzed} />

              <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
                <div className="lg:col-span-2">
                  <SpendingPie transactions={analyzed} categories={categories} />
                </div>
                <div className="lg:col-span-3">
                  <TopMerchantsBar transactions={analyzed} />
                </div>
              </div>

              <DailyArea transactions={analyzed} />

              <MonthCompare />

              <TransactionTable
                transactions={analyzed}
                categories={categories}
                onDelete={async (id) => {
                  await invoke("delete_transaction", { id });
                  load();
                }}
              />
            </>
          )}
          </div>
          )}

          {/* ─── Цели ─── */}
          {tab === "goals" && <GoalsWidget categories={categories} />}

          {/* ─── Кредиты ─── */}
          {tab === "credits" && <CreditsWidget />}
        </div>
      </div>

      {showChat && (
        <ChatPanel onClose={() => setShowChat(false)} onStatusChange={setAiStatus} />
      )}

      {showSettings && (
        <SettingsPanel onClose={() => setShowSettings(false)} />
      )}

      {showWizard && (
        <ImportWizard
          categories={categories}
          onComplete={onImportComplete}
          onClose={() => setShowWizard(false)}
        />
      )}

      {confirmBulkDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-xl shadow-xl p-6 w-80 space-y-4">
            <h3 className="font-semibold text-sm">Удалить {deleteSelection.size} {deleteSelection.size === 1 ? "импорт" : "импорта"}?</h3>
            <p className="text-xs text-muted-foreground">
              Все транзакции из отмеченных выписок будут удалены. Это действие нельзя отменить.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmBulkDelete(false)}
                className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-accent transition-colors"
              >
                Отмена
              </button>
              <button
                onClick={handleBulkDelete}
                disabled={bulkDeleting}
                className="px-3 py-1.5 text-xs rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition-colors"
              >
                {bulkDeleting ? "Удаляем..." : `Удалить (${deleteSelection.size})`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
