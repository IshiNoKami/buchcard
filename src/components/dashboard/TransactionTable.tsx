import { useState, useMemo, useEffect, useRef } from "react";
import { Transaction, Category } from "@/lib/types";
import { formatCurrency, formatDate, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  ArrowUpDown, Search, Trash2,
} from "lucide-react";

const PAGE_SIZES = [20, 50, 100];

interface Props {
  transactions: Transaction[];
  categories: Category[];
  onDelete?: (id: number) => Promise<void>;
}

type SortKey = "date" | "amount" | "category" | "merchant_key";
type SortDir = "asc" | "desc";

export function TransactionTable({ transactions, categories, onDelete }: Props) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "date", dir: "desc" });
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  // Selection state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const dragState = useRef<{ value: boolean } | null>(null);
  const lastClickedHash = useRef<string | null>(null);

  const colorMap = Object.fromEntries(categories.map((c) => [c.name, c.color]));

  const filtered = useMemo(() => {
    let res = [...transactions];
    if (search) {
      const q = search.toLowerCase();
      res = res.filter(
        (t) =>
          t.description.toLowerCase().includes(q) ||
          t.merchant_key.toLowerCase().includes(q)
      );
    }
    if (catFilter !== "all") {
      res = res.filter((t) => t.category === catFilter);
    }
    res.sort((a, b) => {
      const av: string | number = a[sort.key];
      const bv: string | number = b[sort.key];
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

  // Clear selection when filter/sort changes
  useEffect(() => { setSelected(new Set()); }, [search, catFilter, sort, page]);

  // Global mouseup to stop drag
  useEffect(() => {
    const onMouseUp = () => { dragState.current = null; };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, []);

  const toggleSort = (key: SortKey) => {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }
    );
    setPage(1);
  };

  const catList = Array.from(new Set(transactions.map((t) => t.category))).sort();

  const handleDelete = async (id: number) => {
    if (!onDelete || id == null) return;
    setDeleting(id);
    try {
      await onDelete(id);
    } finally {
      setDeleting(null);
      setPendingDelete(null);
    }
  };

  const handleBulkDelete = async () => {
    if (!onDelete || selected.size === 0) return;
    setBulkDeleting(true);
    try {
      const toDelete = paginated.filter((tx) => selected.has(tx.tx_hash) && tx.id != null);
      for (const tx of toDelete) {
        await onDelete(tx.id!);
      }
      setSelected(new Set());
    } finally {
      setBulkDeleting(false);
    }
  };

  // Checkbox mousedown: start drag + toggle row
  const handleCheckboxMouseDown = (tx: Transaction, e: React.MouseEvent) => {
    e.preventDefault();

    if (e.shiftKey && lastClickedHash.current !== null) {
      // Shift+click: range selection
      const hashes = paginated.map((t) => t.tx_hash);
      const startIdx = hashes.indexOf(lastClickedHash.current);
      const endIdx = hashes.indexOf(tx.tx_hash);
      if (startIdx !== -1 && endIdx !== -1) {
        const from = Math.min(startIdx, endIdx);
        const to = Math.max(startIdx, endIdx);
        const newVal = !selected.has(tx.tx_hash);
        setSelected((prev) => {
          const next = new Set(prev);
          hashes.slice(from, to + 1).forEach((h) => newVal ? next.add(h) : next.delete(h));
          return next;
        });
      }
      lastClickedHash.current = tx.tx_hash;
      return;
    }

    const newVal = !selected.has(tx.tx_hash);
    setSelected((prev) => {
      const next = new Set(prev);
      newVal ? next.add(tx.tx_hash) : next.delete(tx.tx_hash);
      return next;
    });
    dragState.current = { value: newVal };
    lastClickedHash.current = tx.tx_hash;
  };

  // Row mouseenter: apply drag value
  const handleRowMouseEnter = (tx: Transaction) => {
    if (dragState.current === null) return;
    const val = dragState.current.value;
    setSelected((prev) => {
      if (prev.has(tx.tx_hash) === val) return prev;
      const next = new Set(prev);
      val ? next.add(tx.tx_hash) : next.delete(tx.tx_hash);
      return next;
    });
  };

  const allPageSelected = paginated.length > 0 && paginated.every((tx) => selected.has(tx.tx_hash));
  const somePageSelected = paginated.some((tx) => selected.has(tx.tx_hash));

  const toggleAllPage = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      paginated.forEach((tx) => checked ? next.add(tx.tx_hash) : next.delete(tx.tx_hash));
      return next;
    });
  };

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

        {selected.size > 0 ? (
          <button
            onClick={handleBulkDelete}
            disabled={bulkDeleting || !onDelete}
            className="flex items-center gap-1.5 h-8 px-3 rounded-md text-xs text-red-400 border border-red-500/40 hover:bg-red-500/10 transition-colors disabled:opacity-50"
          >
            <Trash2 className="h-3 w-3" />
            {bulkDeleting ? "Удаляю..." : `Удалить (${selected.size})`}
          </button>
        ) : (
          <span className="text-xs text-muted-foreground ml-auto">
            {filtered.length} из {transactions.length} транзакций
          </span>
        )}
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs" style={{ userSelect: "none" }}>
          <thead>
            <tr className="border-b border-border bg-secondary/50">
              <th className="pl-4 pr-1 py-3 w-6">
                <input
                  type="checkbox"
                  checked={allPageSelected}
                  ref={(el) => { if (el) el.indeterminate = somePageSelected && !allPageSelected; }}
                  onChange={(e) => toggleAllPage(e.target.checked)}
                  className="h-3 w-3 cursor-pointer"
                />
              </th>
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
              {onDelete && <th className="w-8 px-2 py-3" />}
            </tr>
          </thead>
          <tbody>
            {paginated.map((tx, i) => {
              const isSelected = selected.has(tx.tx_hash);
              return (
                <tr
                  key={tx.tx_hash}
                  onMouseEnter={() => handleRowMouseEnter(tx)}
                  className={cn(
                    "group border-b border-border/50 transition-colors",
                    isSelected ? "bg-primary/10" : i % 2 === 1 ? "bg-secondary/20" : "",
                    !isSelected && "hover:bg-accent/30",
                    deleting === tx.id && "opacity-40"
                  )}
                >
                  <td
                    className="pl-4 pr-1 py-2.5 cursor-pointer"
                    onMouseDown={(e) => handleCheckboxMouseDown(tx, e)}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      readOnly
                      className="h-3 w-3 cursor-pointer pointer-events-none"
                    />
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">
                    {formatDate(tx.date)}
                  </td>
                  <td className={`px-4 py-2.5 font-medium whitespace-nowrap ${tx.is_income ? "text-emerald-400" : "text-amber-400"}`}>
                    {tx.is_income ? "+" : ""}{formatCurrency(tx.amount)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs"
                      style={{
                        background: `${colorMap[tx.category] ?? "#9E9E9E"}22`,
                        color: colorMap[tx.category] ?? "#9E9E9E",
                      }}
                    >
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: colorMap[tx.category] ?? "#9E9E9E" }}
                      />
                      {tx.category}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-foreground max-w-[140px] truncate">
                    {tx.merchant_key}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground max-w-[300px] truncate">
                    {tx.description}
                  </td>
                  {onDelete && (
                    <td className="px-2 py-2 w-8">
                      {pendingDelete === tx.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleDelete(tx.id!)}
                            disabled={deleting === tx.id}
                            className="text-[10px] text-red-400 hover:text-red-300 px-1.5 py-0.5 rounded border border-red-500/40 hover:bg-red-500/10 whitespace-nowrap transition-colors"
                          >
                            Удалить
                          </button>
                          <button
                            onClick={() => setPendingDelete(null)}
                            className="text-muted-foreground hover:text-foreground px-1 py-0.5 text-[10px] transition-colors"
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setPendingDelete(tx.id ?? null)}
                          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-400 p-1 rounded hover:bg-red-500/10 transition-all"
                          title="Удалить транзакцию"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>

        {paginated.length === 0 && (
          <div className="py-12 text-center text-muted-foreground text-sm">
            Нет транзакций
          </div>
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
          <Button
            variant="outline" size="icon" className="h-7 w-7"
            onClick={() => setPage(1)} disabled={page === 1}
          >
            <ChevronsLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline" size="icon" className="h-7 w-7"
            onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
            const p = Math.max(1, Math.min(totalPages - 4, page - 2)) + i;
            return (
              <Button
                key={p}
                variant={p === page ? "default" : "outline"}
                size="icon"
                className="h-7 w-7 text-xs"
                onClick={() => setPage(p)}
              >
                {p}
              </Button>
            );
          })}
          <Button
            variant="outline" size="icon" className="h-7 w-7"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages || totalPages === 0}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline" size="icon" className="h-7 w-7"
            onClick={() => setPage(totalPages)}
            disabled={page === totalPages || totalPages === 0}
          >
            <ChevronsRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
