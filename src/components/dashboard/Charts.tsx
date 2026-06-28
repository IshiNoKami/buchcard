import { Transaction, Category } from "@/lib/types";
import { formatCurrency } from "@/lib/utils";
import { useChartColors } from "@/lib/theme";
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

  const data = Object.entries(
    transactions.reduce<Record<string, number>>((acc, t) => {
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
          <span key={d.name} className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="h-2 w-2 rounded-full" style={{ background: colors[d.name] ?? "#9E9E9E" }} />
            {d.name}
          </span>
        ))}
      </div>
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export function TopMerchantsBar({ transactions }: { transactions: Transaction[] }) {
  const c = useChartColors();

  const data = Object.entries(
    transactions.reduce<Record<string, number>>((acc, t) => {
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

  const byDate = transactions.reduce<Record<string, number>>((acc, t) => {
    acc[t.date] = (acc[t.date] || 0) + t.amount;
    return acc;
  }, {});

  const data = Object.entries(byDate)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, amount]) => ({ date: date.slice(5), amount }));

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
        <AreaChart data={data} margin={{ left: 0, right: 0 }}>
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
            type="monotone" dataKey="amount"
            stroke={c.primary} strokeWidth={2}
            fill="url(#areaGrad)" dot={false} activeDot={{ r: 4 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
