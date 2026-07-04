import { useState } from "react";
import { Transaction, Category } from "@/lib/types";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useChartColors } from "@/lib/theme";
import { X } from "lucide-react";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  AreaChart, Area,
} from "recharts";

interface Props {
  transactions: Transaction[];
  categories: Category[];
}

const colorMap = (cats: Category[]) =>
  Object.fromEntries(cats.map((c) => [c.name, c.color]));

export function SpendingPie({ transactions, categories }: Props) {
  const colors = colorMap(categories);
  const c = useChartColors();
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const data = Object.entries(
    transactions
      .filter((t) => !t.is_income)
      .reduce<Record<string, number>>((acc, t) => {
        acc[t.category] = (acc[t.category] || 0) + t.amount;
        return acc;
      }, {})
  )
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  const tooltipStyle = {
    background: c.tooltipBg,
    border: `1px solid ${c.tooltipBorder}`,
    borderRadius: 10,
    fontSize: 12,
    color: c.tooltipText,
  };

  const drillDownMerchants = selectedCategory
    ? Object.entries(
        transactions
          .filter(tx => tx.category === selectedCategory)
          .reduce<Record<string, number>>((acc, tx) => {
            const key = tx.merchant_key || tx.description;
            acc[key] = (acc[key] || 0) + tx.amount;
            return acc;
          }, {})
      )
        .map(([name, total]) => ({ name, total }))
        .sort((a, b) => b.total - a.total)
    : [];

  const drillDownTotal = drillDownMerchants.reduce((s, m) => s + m.total, 0);

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium text-muted-foreground mb-4">Структура расходов</h3>
      <ResponsiveContainer width="100%" height={260}>
        <PieChart>
          <Pie
            data={data}
            cx="40%"
            cy="50%"
            innerRadius={65}
            outerRadius={105}
            paddingAngle={2}
            dataKey="value"
            onClick={(entry: { name: string }) => setSelectedCategory(entry.name)}
            style={{ cursor: "pointer" }}
          >
            {data.map((entry) => (
              <Cell key={entry.name} fill={colors[entry.name] ?? "#9E9E9E"} />
            ))}
          </Pie>
          <Tooltip
            formatter={(v: number) => formatCurrency(v)}
            contentStyle={tooltipStyle}
            itemStyle={{ color: c.tooltipText }}
            labelStyle={{ color: c.tooltipMuted }}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {data.slice(0, 6).map((d) => (
          <button
            key={d.name}
            onClick={() => setSelectedCategory(d.name)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <span className="h-2 w-2 rounded-full shrink-0" style={{ background: colors[d.name] ?? "#9E9E9E" }} />
            {d.name}
          </button>
        ))}
      </div>

      {selectedCategory && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
          onClick={() => setSelectedCategory(null)}
        >
          <div
            className="bg-card border border-border rounded-2xl shadow-2xl w-80 max-h-[65vh] flex flex-col overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="h-3 w-3 rounded-full shrink-0"
                  style={{ background: colors[selectedCategory] ?? "#9E9E9E" }}
                />
                <h3 className="text-sm font-semibold truncate">{selectedCategory}</h3>
              </div>
              <div className="flex items-center gap-2 ml-2 shrink-0">
                <span className="text-sm font-bold text-muted-foreground">{formatCurrency(drillDownTotal)}</span>
                <button
                  onClick={() => setSelectedCategory(null)}
                  className="h-6 w-6 flex items-center justify-center rounded-md hover:bg-accent transition-colors text-muted-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <div className="overflow-y-auto flex-1 px-5 py-2">
              {drillDownMerchants.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">Нет данных</p>
              ) : (
                drillDownMerchants.map((m, i) => (
                  <div
                    key={m.name}
                    className="flex items-center justify-between py-2 border-b border-border/40 last:border-0"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs text-muted-foreground w-5 shrink-0">{i + 1}</span>
                      <span className="text-sm text-foreground truncate">{m.name || "—"}</span>
                    </div>
                    <span className="text-sm font-medium ml-3 shrink-0">{formatCurrency(m.total)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export function TopMerchantsBar({ transactions }: { transactions: Transaction[] }) {
  const c = useChartColors();

  const data = Object.entries(
    transactions
      .filter((t) => !t.is_income)
      .reduce<Record<string, number>>((acc, t) => {
        const k = t.merchant_key.trim();
        if (!k) return acc;
        acc[k] = (acc[k] || 0) + t.amount;
        return acc;
      }, {})
  )
    .map(([fullName, value]) => ({ fullName, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  const tickFill = c.tick;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium text-muted-foreground mb-4">Топ-10 мерчантов</h3>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 40 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={c.grid} horizontal={false} />
          <XAxis
            type="number"
            tickFormatter={(v) => `${(v / 1000).toFixed(0)}к`}
            tick={{ fill: tickFill, fontSize: 10 }}
            axisLine={false} tickLine={false}
          />
          <YAxis
            type="category" dataKey="fullName" width={24}
            axisLine={false} tickLine={false} interval={0}
            tick={(props: { x: number; y: number; index: number }) => (
              <g transform={`translate(${props.x},${props.y})`}>
                <text x={-4} y={0} dy={4} textAnchor="end" fill={tickFill} fontSize={10} opacity={0.5}>
                  {props.index + 1}
                </text>
              </g>
            )}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as { fullName: string; value: number };
              return (
                <div style={{ background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 10, padding: "8px 12px", fontSize: 12 }}>
                  <p style={{ color: c.tooltipMuted, marginBottom: 4, maxWidth: 240 }}>{d.fullName}</p>
                  <p style={{ color: c.tooltipText, fontWeight: 600 }}>{formatCurrency(d.value)}</p>
                </div>
              );
            }}
          />
          <Bar
            dataKey="value" fill={c.primary} radius={[0, 4, 4, 0]}
            label={{ position: "right", formatter: (v: number) => formatCurrency(v), fill: tickFill, fontSize: 10 }}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DailyArea({ transactions }: { transactions: Transaction[] }) {
  const c = useChartColors();
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const byDate = transactions
    .filter((t) => !t.is_income)
    .reduce<Record<string, number>>((acc, t) => {
      acc[t.date] = (acc[t.date] || 0) + t.amount;
      return acc;
    }, {});

  const data = Object.entries(byDate)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, amount]) => ({ date: date.slice(5), full: date, amount }));

  const dayTxs = selectedDay
    ? transactions
        .filter((t) => !t.is_income && t.date === selectedDay)
        .sort((a, b) => b.amount - a.amount)
    : [];
  const dayTotal = dayTxs.reduce((s, t) => s + t.amount, 0);

  const avg = data.reduce((s, d) => s + d.amount, 0) / (data.length || 1);

  const tooltipStyle = {
    background: c.tooltipBg,
    border: `1px solid ${c.tooltipBorder}`,
    borderRadius: 10,
    fontSize: 12,
    color: c.tooltipText,
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-muted-foreground">Расходы по дням</h3>
        <span className="text-xs text-muted-foreground">среднее: {formatCurrency(avg)}/день</span>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <AreaChart
          data={data}
          margin={{ left: 0, right: 0 }}
          style={{ cursor: "pointer" }}
          onClick={(st: { activePayload?: Array<{ payload?: { full?: string } }> } | null) => {
            const full = st?.activePayload?.[0]?.payload?.full;
            if (full) setSelectedDay(full);
          }}
        >
          <defs>
            <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={c.primary} stopOpacity={0.3} />
              <stop offset="95%" stopColor={c.primary} stopOpacity={0} />
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
            axisLine={false} tickLine={false} width={36}
          />
          <Tooltip
            formatter={(v: number) => formatCurrency(v)}
            contentStyle={tooltipStyle}
            itemStyle={{ color: c.tooltipText }}
            labelStyle={{ color: c.tooltipMuted }}
          />
          <Area
            name="Расходы"
            type="monotone" dataKey="amount"
            stroke={c.primary} strokeWidth={2}
            fill="url(#areaGrad)" dot={false} activeDot={{ r: 4 }}
          />
        </AreaChart>
      </ResponsiveContainer>
      <p className="text-[10px] text-muted-foreground/60 mt-1 text-right">нажмите на день, чтобы увидеть траты</p>

      {/* Day details modal */}
      {selectedDay && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm"
          onClick={() => setSelectedDay(null)}
        >
          <div
            className="bg-card border border-border rounded-2xl shadow-2xl w-[26rem] max-h-[70vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <div>
                <h3 className="text-sm font-semibold">Траты за {formatDate(selectedDay)}</h3>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {dayTxs.length} операц. · итого <span className="text-foreground font-medium">{formatCurrency(dayTotal)}</span>
                </p>
              </div>
              <button
                onClick={() => setSelectedDay(null)}
                className="rounded-md p-1 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 px-5 py-2">
              {dayTxs.map((t) => (
                <div key={t.tx_hash} className="flex items-start gap-3 py-2 border-b border-border/30 last:border-0">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs truncate">{t.merchant_key || t.description.slice(0, 50)}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{t.category}</p>
                  </div>
                  <span className="text-xs font-medium shrink-0">{formatCurrency(t.amount)}</span>
                </div>
              ))}
              {dayTxs.length === 0 && (
                <p className="text-xs text-muted-foreground py-4 text-center">Нет расходов в этот день</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
