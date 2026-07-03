import { formatCurrency } from "@/lib/utils";
import { Transaction } from "@/lib/types";
import { TrendingDown, ShoppingCart, Calendar } from "lucide-react";

interface Props {
  transactions: Transaction[];
}

export function KpiCards({ transactions }: Props) {
  const expenses = transactions.filter((t) => !t.is_income);
  const incomes  = transactions.filter((t) => t.is_income);

  const totalExpense = expenses.reduce((s, t) => s + t.amount, 0);
  const totalIncome  = incomes.reduce((s, t) => s + t.amount, 0);

  const days = (() => {
    if (!transactions.length) return 1;
    const dates = transactions.map((t) => t.date);
    const min = dates.reduce((a, b) => (a < b ? a : b));
    const max = dates.reduce((a, b) => (a > b ? a : b));
    return Math.max((new Date(max).getTime() - new Date(min).getTime()) / 86400000 + 1, 1);
  })();

  const perDay = totalExpense / days;

  const catTotals = expenses.reduce<Record<string, number>>((acc, t) => {
    acc[t.category] = (acc[t.category] || 0) + t.amount;
    return acc;
  }, {});
  const topCat = Object.entries(catTotals).sort((a, b) => b[1] - a[1])[0];

  const cards = [
    {
      label: "Всего расходов",
      value: formatCurrency(totalExpense),
      sub: totalIncome > 0 ? `доходы ${formatCurrency(totalIncome)}` : undefined,
      icon: TrendingDown,
      color: "text-amber-400",
    },
    {
      label: "В среднем в день",
      value: formatCurrency(perDay),
      sub: `за ${Math.round(days)} дней`,
      icon: Calendar,
      color: "text-sky-400",
    },
    {
      label: "Топ категория",
      value: topCat?.[0] ?? "—",
      sub: topCat ? formatCurrency(topCat[1]) : undefined,
      icon: ShoppingCart,
      color: "text-violet-400",
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted-foreground">{c.label}</span>
            <c.icon className={`h-4 w-4 ${c.color}`} />
          </div>
          <p className={`text-xl font-bold ${c.color}`}>{c.value}</p>
          {c.sub && <p className="text-[11px] text-muted-foreground mt-0.5">{c.sub}</p>}
        </div>
      ))}
    </div>
  );
}
