import { useState, useMemo } from "react";
import { Transaction, Category } from "@/lib/types";
import { formatCurrency, formatDate, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ArrowUpDown, Search } from "lucide-react";

const PAGE_SIZES = [20, 50, 100];

interface Props {
  transactions: Transaction[];
  categories: Category[];
}

type SortKey = "date" | "amount" | "category" | "merchant_key";
type SortDir = "asc" | "desc";

export function TransactionTable({ transactions, categories }: Props) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "date", dir: "desc" });

  const colorMap = Object.fromEntries(categories.map((c) => [c.name, c.color]));

  const filtered = useMemo(() => {
    let res = [...transactions];
    if (search) {
      const q = search.toLowerCase();
      res = res.filter(
        (t) => t.description.toLowerCase().includes(q) || t.merchant_key.toLowerCase().includes(q)
      );
    }
    if (catFilter !== "all") {
      res = res.filter((t) => t.category === catFilter);
    }
    res.sort((a, b) => {
      let av: string | number = a[sort.key];
      let bv: string | number = b[sort.key];
      if (typeof av === "number" && typeof bv === "number") {
        return sort.dir === "asc" ? av - bv : bv - av;
      }
      return sort.dir === "asc"
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return res;
  }, [transactions, search, catFilter, sort]);

  const totalPages = Math.ceil(filtered.length / pageSize);
  const paginated = filtered.slice((page - 1) * pageSize, page * pageSize);

  const toggleSort = (key: SortKey) => {
    setSort((s) => s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" });
    setPage(1);
  };

  const catList = Array.from(new Set(transactions.map((t) => t.category))).sort();

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 p-4 border-b border-border">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Поиск по описанию или мерчанту..."
            className="w-full h-8 pl-8 pr-3 rounded-md border border-border bg-secondary text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <select
          value={catFilter}
          onChange={(e) => { setCatFilter(e.target.value); setPage(1); }}
          className="h-8 rounded-md border border-border bg-secondary px-3 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="all">Все категории</option>
          {catList.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="text-xs text-muted-foreground ml-auto">
          {filtered.length} из {transactions.length} транзакций
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-secondary/50">
              {(["date", "amount", "category", "merchant_key"] as SortKey[]).map((key) => (
                <th
                  key={key}
                  onClick={() => toggleSort(key)}
                  className="px-4 py-3 text-left font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none"
                >
                  <span className="flex items-center gap-1">
                    {{ date: "Дата", amount: "Сумма", category: "Категория", merchant_key: "Мерчант" }[key]}
                    <ArrowUpDown className="h-3 w-3" />
                  </span>
                </th>
              ))}
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Описание</th>
            </tr>
          </thead>
          <tbody>
            {paginated.map((tx, i) => (
              <tr key={tx.tx_hash} className={cn("border-b border-border/50 hover:bg-accent/30 transition-colors", i % 2 === 1 && "bg-secondary/20")}>
                <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">{formatDate(tx.date)}</td>
                <td className="px-4 py-2.5 font-medium text-amber-400 whitespace-nowrap">{formatCurrency(tx.amount)}</td>
                <td className="px-4 py-2.5">
                  <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs"
                    style={{ background: `${colorMap[tx.category] ?? "#9E9E9E"}22`, color: colorMap[tx.category] ?? "#9E9E9E" }}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: colorMap[tx.category] ?? "#9E9E9E" }} />
                    {tx.category}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-foreground max-w-[140px] truncate">{tx.merchant_key}</td>
                <td className="px-4 py-2.5 text-muted-foreground max-w-[300px] truncate">{tx.description}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {paginated.length === 0 && (
          <div className="py-12 text-center text-muted-foreground text-sm">Нет транзакций</div>
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between px-4 py-3 border-t border-border">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          Строк на странице:
          <select
            value={pageSize}
            onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
            className="h-7 rounded border border-border bg-secondary px-2 text-foreground focus:outline-none"
          >
            {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground mr-3">
            Страница {page} из {totalPages || 1}
          </span>
          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setPage(1)} disabled={page === 1}>
            <ChevronsLeft className="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
            const p = Math.max(1, Math.min(totalPages - 4, page - 2)) + i;
            return (
              <Button key={p} variant={p === page ? "default" : "outline"} size="icon"
                className="h-7 w-7 text-xs" onClick={() => setPage(p)}>
                {p}
              </Button>
            );
          })}
          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages || totalPages === 0}>
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setPage(totalPages)} disabled={page === totalPages || totalPages === 0}>
            <ChevronsRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
