import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine, ReferenceDot,
} from "recharts";
import { AlertTriangle, TrendingUp, ChevronLeft, ChevronRight } from "lucide-react";
import { CashForecast as CashForecastData } from "@/lib/types";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useChartColors } from "@/lib/theme";

interface Props {
  currentBalance: number;
}

const HORIZON_DAYS = 180;
const PAGE_DAYS = 30;

// Цвет точки-события по типу: план / платёж по кредиту / доход.
// Строки событий приходят с бэка: «План: …», «Платёж: …», «Зарплата»/«Аванс»/имя дохода.
const EVENT_COLORS = {
  plan: "#a78bfa",    // фиолетовый — запланированные расходы
  credit: "#f59e0b",  // янтарный — платежи по кредитам
  income: "#34d399",  // зелёный — зарплата, аванс, плановые доходы
} as const;

function eventColor(event: string): string {
  if (event.includes("План:")) return EVENT_COLORS.plan;
  if (event.includes("Платёж:")) return EVENT_COLORS.credit;
  return EVENT_COLORS.income;
}

export function CashForecast({ currentBalance }: Props) {
  const c = useChartColors();
  const [data, setData] = useState<CashForecastData | null>(null);
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    try {
      setData(await invoke<CashForecastData>("get_cash_forecast", {
        currentBalance,
        days: HORIZON_DAYS,
      }));
    } catch (e) {
      console.error(e);
    }
  }, [currentBalance]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const h = () => load();
    window.addEventListener("buchcard:data-changed", h);
    return () => window.removeEventListener("buchcard:data-changed", h);
  }, [load]);

  if (!data || data.points.length === 0) return null;

  const totalPages = Math.ceil(data.points.length / PAGE_DAYS);
  const pageClamped = Math.min(page, totalPages - 1);
  const slice = data.points.slice(pageClamped * PAGE_DAYS, (pageClamped + 1) * PAGE_DAYS);

  const chartData = slice.map(p => ({
    date: p.date.slice(5),
    fullDate: p.date,
    balance: p.balance,
    event: p.event,
  }));

  const eventPoints = chartData.filter(p => p.event);
  const rangeLabel = slice.length > 0
    ? `${formatDate(slice[0].date)} — ${formatDate(slice[slice.length - 1].date)}`
    : "";

  // Вертикальный градиент по значению: вверху (высокий баланс) зелёный,
  // к нулю — жёлтый, ниже нуля — красный. Считается по видимому срезу.
  const values = chartData.map(p => p.balance);
  const maxV = Math.max(...values, 0.01);
  const minV = Math.min(...values, 0);
  const range = maxV - minV || 1;
  const zeroOff = Math.max(0, Math.min(1, maxV / range)); // доля сверху, где проходит ноль
  const gradStops = minV < 0
    ? [
        { off: 0, color: "#34d399" },
        { off: Math.max(zeroOff - 0.25, 0.05), color: "#fbbf24" },
        { off: zeroOff, color: "#f87171" },
        { off: 1, color: "#ef4444" },
      ]
    : [
        { off: 0, color: "#34d399" },
        { off: 1, color: "#fbbf24" },
      ];

  const tooltipStyle = {
    background: c.tooltipBg,
    border: `1px solid ${c.tooltipBorder}`,
    borderRadius: 10,
    fontSize: 12,
    color: c.tooltipText,
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <TrendingUp className="h-4 w-4" />
          Прогноз баланса
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={pageClamped === 0}
            className="rounded-md p-1 border border-border text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
            title="Раньше"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="text-xs text-muted-foreground min-w-[9.5rem] text-center">{rangeLabel}</span>
          <button
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={pageClamped >= totalPages - 1}
            className="rounded-md p-1 border border-border text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
            title="Дальше"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
        <span className="text-xs text-muted-foreground">
          быт ≈ {formatCurrency(data.daily_avg)}/день (за последние 7 дней, без переводов и копилки)
        </span>
      </div>

      {data.has_gap && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
          <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
          <p className="text-xs text-red-400">
            <span className="font-medium">{formatDate(data.min_date)}</span> баланс уйдёт в минус:{" "}
            <span className="font-bold">{formatCurrency(data.min_balance)}</span>.
            Проверьте предстоящие платежи.
          </p>
        </div>
      )}

      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={chartData} margin={{ left: 0, right: 8 }}>
          <defs>
            <linearGradient id="forecastStroke" x1="0" y1="0" x2="0" y2="1">
              {gradStops.map((s, i) => (
                <stop key={i} offset={`${(s.off * 100).toFixed(1)}%`} stopColor={s.color} />
              ))}
            </linearGradient>
            <linearGradient id="forecastGrad" x1="0" y1="0" x2="0" y2="1">
              {gradStops.map((s, i) => (
                <stop key={i} offset={`${(s.off * 100).toFixed(1)}%`} stopColor={s.color} stopOpacity={0.18} />
              ))}
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={c.grid} />
          <XAxis
            dataKey="date"
            tick={{ fill: c.tick, fontSize: 10 }}
            axisLine={false} tickLine={false}
          />
          <YAxis
            tickFormatter={(v) => `${(v / 1000).toFixed(0)}к`}
            tick={{ fill: c.tick, fontSize: 10 }}
            axisLine={false} tickLine={false} width={40}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            itemStyle={{ color: c.tooltipText }}
            labelStyle={{ color: c.tooltipMuted }}
            formatter={(v: number) => [formatCurrency(v), "Баланс"]}
            labelFormatter={(label: string, payload) => {
              const p = payload?.[0]?.payload;
              return p?.event ? `${label} — ${p.event}` : label;
            }}
          />
          <ReferenceLine y={0} stroke="#f87171" strokeDasharray="4 4" />
          <Area
            type="monotone"
            dataKey="balance"
            name="Баланс"
            stroke="url(#forecastStroke)"
            strokeWidth={2}
            fill="url(#forecastGrad)"
          />
          {eventPoints.map(p => (
            <ReferenceDot
              key={p.fullDate}
              x={p.date}
              y={p.balance}
              r={3.5}
              fill={eventColor(p.event!)}
              stroke={c.tooltipBg}
              strokeWidth={1.5}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>

      {/* Легенда точек-событий */}
      <div className="flex items-center gap-4 justify-end text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: EVENT_COLORS.income }} />
          доходы
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: EVENT_COLORS.credit }} />
          платежи по кредитам
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: EVENT_COLORS.plan }} />
          планы
        </span>
      </div>
    </div>
  );
}
