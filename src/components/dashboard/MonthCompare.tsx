import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TrendingUp, TrendingDown, ArrowLeftRight } from "lucide-react";
import { MonthComparison } from "@/lib/types";
import { formatCurrency, cn } from "@/lib/utils";

export function MonthCompare() {
  const [data, setData] = useState<MonthComparison | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await invoke<MonthComparison>("get_month_comparison"));
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const h = () => load();
    window.addEventListener("buchcard:data-changed", h);
    return () => window.removeEventListener("buchcard:data-changed", h);
  }, [load]);

  // Нечего сравнивать — прошлый месяц пуст
  if (!data || !data.has_previous) return null;

  const top = data.rows.filter(r => Math.abs(r.delta) >= 1).slice(0, 5);
  if (top.length === 0) return null;

  const totalDelta = data.total_current - data.total_previous;
  const totalPct = data.total_previous > 0 ? (totalDelta / data.total_previous) * 100 : 0;

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <ArrowLeftRight className="h-4 w-4" />
          {data.current_label} vs {data.previous_label}
        </h3>
        <span className={cn("text-xs font-medium", totalDelta > 0 ? "text-red-400" : "text-emerald-400")}>
          {totalDelta > 0 ? "+" : ""}{formatCurrency(totalDelta)}
          {data.total_previous > 0 && ` (${totalPct > 0 ? "+" : ""}${totalPct.toFixed(0)}%)`}
        </span>
      </div>

      <div className="space-y-1.5">
        {top.map(r => {
          const worse = r.delta > 0; // расходы выросли
          return (
            <div key={r.category} className="flex items-center gap-2 text-xs">
              {worse
                ? <TrendingUp className="h-3.5 w-3.5 text-red-400 shrink-0" />
                : <TrendingDown className="h-3.5 w-3.5 text-emerald-400 shrink-0" />}
              <span className="flex-1 truncate">{r.category}</span>
              <span className="text-muted-foreground">
                {formatCurrency(r.previous)} → {formatCurrency(r.current)}
              </span>
              <span className={cn("w-16 text-right font-medium", worse ? "text-red-400" : "text-emerald-400")}>
                {r.pct != null
                  ? `${r.pct > 0 ? "+" : ""}${r.pct.toFixed(0)}%`
                  : "нов."}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
