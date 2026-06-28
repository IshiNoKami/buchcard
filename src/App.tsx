import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Transaction, Category, Import } from "./lib/types";
import { KpiCards } from "./components/dashboard/KpiCards";
import { SpendingPie, TopMerchantsBar, DailyArea } from "./components/dashboard/Charts";
import { TransactionTable } from "./components/dashboard/TransactionTable";
import { ImportWizard } from "./components/wizard/ImportWizard";
import { Button } from "./components/ui/button";
import { Upload, RefreshCw, CreditCard, Calendar, Settings, MessageSquare } from "lucide-react";
import { DateRangePicker, DateRange } from "./components/ui/date-range-picker";
import { useTheme, THEMES } from "./lib/theme";
import { SettingsPanel } from "./components/SettingsPanel";
import { ChatPanel } from "./components/ChatPanel";

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
  const [selectedImport, setSelectedImport] = useState<Import | null>(null);
  const [customRange, setCustomRange] = useState<DateRange | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [aiStatus, setAiStatus] = useState<"checking" | "online" | "offline">("checking");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [txs, cats, imps] = await Promise.all([
        invoke<Transaction[]>("get_transactions"),
        invoke<Category[]>("get_categories"),
        invoke<Import[]>("get_imports"),
      ]);
      setTransactions(txs);
      setCategories(cats);
      setImports(imps);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onImportComplete = () => {
    setShowWizard(false);
    load();
  };

  const activeDates = useMemo(() => new Set(transactions.map(tx => tx.date)), [transactions]);

  const filtered = useMemo(() => {
    if (customRange) {
      return transactions.filter(tx => tx.date >= customRange.from && tx.date <= customRange.to);
    }
    if (selectedImport) {
      const { period_from, period_to } = selectedImport;
      return transactions.filter(tx => tx.date >= period_from && tx.date <= period_to);
    }
    return transactions;
  }, [transactions, selectedImport, customRange]);

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

          {/* Period filter */}
          {imports.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <button
                onClick={() => { setSelectedImport(null); setCustomRange(null); }}
                className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                  selectedImport === null && customRange === null
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                }`}
              >
                Все периоды
              </button>
              {imports.map(imp => (
                <button
                  key={imp.id}
                  onClick={() => {
                    setCustomRange(null);
                    setSelectedImport(prev => prev?.id === imp.id ? null : imp);
                  }}
                  title={imp.filename}
                  className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                    selectedImport?.id === imp.id
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                  }`}
                >
                  {formatPeriod(imp.period_from, imp.period_to)}
                </button>
              ))}
              <div className="w-px h-4 bg-border" />
              <DateRangePicker
                value={customRange}
                activeDates={activeDates}
                onChange={range => { setCustomRange(range); if (range) setSelectedImport(null); }}
              />
            </div>
          )}

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
              <KpiCards transactions={filtered} />

              <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
                <div className="lg:col-span-2">
                  <SpendingPie transactions={filtered} categories={categories} />
                </div>
                <div className="lg:col-span-3">
                  <TopMerchantsBar transactions={filtered} />
                </div>
              </div>

              <DailyArea transactions={filtered} />

              <TransactionTable transactions={filtered} categories={categories} />
            </>
          )}
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
    </div>
  );
}
