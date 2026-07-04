import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Pencil, Trash2, CalendarClock, TrendingDown, TrendingUp } from "lucide-react";
import { PlannedItem } from "@/lib/types";
import { formatCurrency, formatDate, cn } from "@/lib/utils";

const todayISO = () => new Date().toISOString().slice(0, 10);
const parseNum = (s: string): number => parseFloat(s.replace(/\s/g, "").replace(",", ".")) || 0;

const DEFAULT_FORM = () => ({
  kind: "expense" as "expense" | "income",
  name: "",
  amount: "",
  date: todayISO(),
});

export function PlanningBlock() {
  const [items, setItems] = useState<PlannedItem[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [editId, setEditId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await invoke<PlannedItem[]>("get_planned_items"));
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function openCreate() {
    setForm(DEFAULT_FORM());
    setEditId(null);
    setShowForm(true);
  }

  function openEdit(p: PlannedItem) {
    setForm({ kind: p.kind, name: p.name, amount: String(p.amount), date: p.date.slice(0, 10) });
    setEditId(p.id);
    setShowForm(true);
  }

  async function handleSave() {
    const amount = parseNum(form.amount);
    if (!form.name.trim() || amount <= 0 || !form.date) return;
    setSaving(true);
    try {
      if (editId != null) {
        await invoke("update_planned_item", {
          id: editId, name: form.name.trim(), amount, date: form.date, kind: form.kind,
        });
      } else {
        await invoke("create_planned_item", {
          name: form.name.trim(), amount, date: form.date, kind: form.kind,
        });
      }
      setShowForm(false);
      await load();
      window.dispatchEvent(new CustomEvent("buchcard:data-changed"));
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    await invoke("delete_planned_item", { id });
    await load();
    window.dispatchEvent(new CustomEvent("buchcard:data-changed"));
  }

  const today = todayISO();

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <CalendarClock className="h-4 w-4" />
          Планы
        </h3>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Добавить
        </button>
      </div>

      {items.length === 0 && (
        <p className="text-sm text-muted-foreground/60 text-center py-3">
          Нет планов. Добавьте отпуск, покупку или ожидаемый доход — они появятся на прогнозе баланса.
        </p>
      )}

      {items.length > 0 && (
        <div className="space-y-1">
          {items.map(p => {
            const past = p.date <= today;
            const isIncome = p.kind === "income";
            return (
              <div
                key={p.id}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-2 py-1.5 group",
                  past ? "opacity-45" : "hover:bg-accent/40"
                )}
              >
                {isIncome
                  ? <TrendingUp className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  : <TrendingDown className="h-3.5 w-3.5 text-red-400 shrink-0" />}
                <span className="text-xs flex-1 truncate">
                  {p.name}
                  {past && <span className="ml-1.5 text-[10px] text-muted-foreground">· прошло</span>}
                </span>
                <span className="text-[11px] text-muted-foreground shrink-0">{formatDate(p.date)}</span>
                <span className={cn("text-xs font-medium shrink-0 w-24 text-right", isIncome ? "text-emerald-400" : "text-red-400")}>
                  {isIncome ? "+" : "−"}{formatCurrency(p.amount)}
                </span>
                <span className="flex items-center gap-0.5 shrink-0">
                  <button
                    onClick={() => openEdit(p)}
                    className="text-muted-foreground/30 hover:text-primary transition-colors p-0.5"
                    title="Редактировать"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => handleDelete(p.id)}
                    className="text-muted-foreground/30 hover:text-red-400 transition-colors p-0.5"
                    title="Удалить"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Create / Edit modal */}
      {showForm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
          onClick={() => setShowForm(false)}
        >
          <div
            className="bg-card border border-border rounded-2xl shadow-2xl w-80 p-6 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold">{editId != null ? "Редактировать план" : "Новый план"}</h3>

            <div className="grid grid-cols-2 gap-2">
              {(["expense", "income"] as const).map(k => (
                <button
                  key={k}
                  onClick={() => setForm(f => ({ ...f, kind: k }))}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors",
                    form.kind === k
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:border-primary/50"
                  )}
                >
                  {k === "expense" ? <TrendingDown className="h-4 w-4" /> : <TrendingUp className="h-4 w-4" />}
                  {k === "expense" ? "Расход" : "Доход"}
                </button>
              ))}
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1.5">Название</p>
              <input
                autoFocus
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder={form.kind === "expense" ? "Отпуск, подарок, покупка…" : "Премия, возврат долга…"}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-muted-foreground mb-1.5">Сумма, ₽</p>
                <input
                  type="text"
                  inputMode="decimal"
                  value={form.amount}
                  onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                  placeholder="50 000"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1.5">Дата</p>
                <input
                  type="date"
                  value={form.date}
                  onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setShowForm(false)}
                className="flex-1 px-3 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent transition-colors"
              >
                Отмена
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !form.name.trim() || !form.amount || !form.date}
                className="flex-1 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {saving ? "Сохраняем…" : editId != null ? "Сохранить" : "Добавить"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
