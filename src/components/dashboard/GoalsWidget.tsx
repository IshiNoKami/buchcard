import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Trash2, Target, PiggyBank, Pencil } from "lucide-react";
import { Category, GoalProgress, Goal, Kopilka } from "@/lib/types";
import { formatCurrency } from "@/lib/utils";

interface Props {
  categories: Category[];
}

const MONTHS_RU = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function fmtDate(d: string): string {
  const dt = new Date(d + "T00:00:00");
  return `${dt.getDate()} ${MONTHS_RU[dt.getMonth()]} ${dt.getFullYear()}`;
}

function daysLeft(dateTo: string): number {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const end   = new Date(dateTo + "T00:00:00");
  return Math.ceil((end.getTime() - today.getTime()) / 86_400_000);
}

function monthStartEnd(): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const from = `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const last = new Date(y, m + 1, 0).getDate();
  const to   = `${y}-${String(m + 1).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  return { from, to };
}

function autoName(type: string, category: string, dateTo: string): string {
  const dt = new Date(dateTo + "T00:00:00");
  const mon = MONTHS_RU[dt.getMonth()];
  if (type === "save") return `Накопить к ${mon} ${dt.getFullYear()}`;
  const cat = category || "Все расходы";
  return `${cat} · ${mon} ${dt.getFullYear()}`;
}

function BarColor(type: string, pct: number): string {
  if (type === "save") return "bg-sky-500";
  if (pct >= 100) return "bg-red-500";
  if (pct >= 80)  return "bg-amber-500";
  return "bg-emerald-500";
}

function TextColor(type: string, pct: number): string {
  if (type === "save") return "text-sky-400";
  if (pct >= 100) return "text-red-400";
  if (pct >= 80)  return "text-amber-400";
  return "text-emerald-400";
}

const DEFAULT_FORM = () => {
  const { from, to } = monthStartEnd();
  return { name: "", goal_type: "limit" as "limit" | "save", category: "", budget: "", date_from: from, date_to: to };
};

// Kopilka selector component
interface KopilkaSelectorProps {
  kopilkas: Kopilka[];
  value: number | null;   // selected kopilka_id
  inputValue: string;     // text in the input
  onChange: (kopilkaId: number | null, text: string) => void;
}

function KopilkaSelector({ kopilkas, value, inputValue, onChange }: KopilkaSelectorProps) {
  const [open, setOpen] = useState(false);

  const filtered = kopilkas.filter(k =>
    inputValue.trim() === "" ||
    k.name.toLowerCase().includes(inputValue.toLowerCase()) ||
    k.aliases.some(a => a.toLowerCase().includes(inputValue.toLowerCase()))
  );

  const selectedKopilka = kopilkas.find(k => k.id === value);
  const isNew = inputValue.trim() !== "" && !selectedKopilka && filtered.length === 0;
  const isExistingMatch = inputValue.trim() !== "" && !selectedKopilka && filtered.length === 1 && filtered[0].name.toLowerCase() === inputValue.toLowerCase();

  function handleSelect(k: Kopilka) {
    onChange(k.id, k.name);
    setOpen(false);
  }

  function handleClear() {
    onChange(null, "");
    setOpen(false);
  }

  return (
    <div className="relative">
      <input
        type="text"
        value={inputValue}
        onChange={e => {
          onChange(null, e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Название копилки (например «Копилка 2025»)"
        className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
      />

      {open && (filtered.length > 0 || inputValue.trim() !== "") && (
        <div className="absolute z-10 mt-1 w-full bg-popover border border-border rounded-lg shadow-lg overflow-hidden">
          {filtered.map(k => (
            <button
              key={k.id}
              type="button"
              onMouseDown={() => handleSelect(k)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center gap-2"
            >
              <PiggyBank className="h-3.5 w-3.5 text-sky-400 shrink-0" />
              <span className="truncate">
                {k.name}
                {k.aliases.length > 0 && (
                  <span className="text-muted-foreground ml-1.5">({k.aliases.slice(0, 2).join(", ")})</span>
                )}
              </span>
            </button>
          ))}
          {inputValue.trim() !== "" && !isExistingMatch && (
            <button
              type="button"
              onMouseDown={() => { onChange(null, inputValue); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm text-sky-400 hover:bg-accent border-t border-border"
            >
              + Создать копилку «{inputValue.trim()}»
            </button>
          )}
        </div>
      )}

      <div className="mt-1 h-4">
        {value && (
          <p className="text-[11px] text-sky-400">
            Выбрана копилка «{selectedKopilka?.name ?? inputValue}»
            <button type="button" onClick={handleClear} className="ml-2 text-muted-foreground hover:text-foreground">✕</button>
          </p>
        )}
        {!value && isNew && (
          <p className="text-[11px] text-muted-foreground">Будет создана новая копилка</p>
        )}
      </div>
    </div>
  );
}

export function GoalsWidget({ categories }: Props) {
  const [goals, setGoals] = useState<GoalProgress[]>([]);
  const [kopilkas, setKopilkas] = useState<Kopilka[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [editGoal, setEditGoal] = useState<Goal | null>(null);

  // Kopilka selector state for create form
  const [formKopilkaId, setFormKopilkaId] = useState<number | null>(null);
  const [formKopilkaText, setFormKopilkaText] = useState("");

  // Kopilka selector state for edit modal
  const [editKopilkaId, setEditKopilkaId] = useState<number | null>(null);
  const [editKopilkaText, setEditKopilkaText] = useState("");

  // Manual fact (user-entered actual saved amount) for save goals
  const [formManualOn, setFormManualOn] = useState(false);
  const [formManualText, setFormManualText] = useState("");
  const [editManualOn, setEditManualOn] = useState(false);
  const [editManualText, setEditManualText] = useState("");

  const load = useCallback(async () => {
    try {
      const [data, kops] = await Promise.all([
        invoke<GoalProgress[]>("get_goals_with_progress"),
        invoke<Kopilka[]>("get_kopilkas"),
      ]);
      setGoals(data);
      setKopilkas(kops);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const handler = () => load();
    window.addEventListener("buchcard:goal-created", handler);
    window.addEventListener("buchcard:data-changed", handler);
    return () => {
      window.removeEventListener("buchcard:goal-created", handler);
      window.removeEventListener("buchcard:data-changed", handler);
    };
  }, [load]);

  // Keep name in sync with form fields unless user has manually changed it
  const [nameTouched, setNameTouched] = useState(false);
  useEffect(() => {
    if (!nameTouched && form.date_to) {
      setForm(f => ({ ...f, name: autoName(f.goal_type, f.category, f.date_to) }));
    }
  }, [form.goal_type, form.category, form.date_to, nameTouched]);

  // Resolve kopilka_id: use selected one or create new on save
  async function resolveKopilkaId(kopilkaId: number | null, text: string): Promise<number | null> {
    if (kopilkaId !== null) return kopilkaId;
    const trimmed = text.trim();
    if (!trimmed) return null;
    // Create new kopilka with the typed name as both name and initial alias
    return await invoke<number>("create_kopilka", { name: trimmed, initialAlias: trimmed });
  }

  async function handleCreate() {
    const budget = parseFloat(form.budget.replace(/\s/g, "").replace(",", "."));
    if (!form.name.trim() || isNaN(budget) || budget <= 0 || !form.date_from || !form.date_to) return;
    setSaving(true);
    try {
      const manualOn = form.goal_type === "save" && formManualOn;
      const manualSpent = manualOn
        ? (parseFloat(formManualText.replace(/\s/g, "").replace(",", ".")) || 0)
        : null;
      // When the fact is entered manually, kopilka linking is optional.
      const kopilkaId = form.goal_type === "save"
        ? await resolveKopilkaId(formKopilkaId, formKopilkaText)
        : null;

      await invoke("create_goal", {
        name: form.name.trim(),
        goalType: form.goal_type,
        category: form.goal_type === "limit" ? form.category : "",
        budget,
        dateFrom: form.date_from,
        dateTo: form.date_to,
        kopilkaId,
        manualSpent,
      });
      setShowForm(false);
      setForm(DEFAULT_FORM());
      setFormKopilkaId(null);
      setFormKopilkaText("");
      setFormManualOn(false);
      setFormManualText("");
      setNameTouched(false);
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    await invoke("delete_goal", { id });
    setDeleteId(null);
    await load();
  }

  async function handleUpdate() {
    if (!editGoal) return;
    setSaving(true);
    try {
      const manualOn = editGoal.goal_type === "save" && editManualOn;
      const manualSpent = manualOn
        ? (parseFloat(editManualText.replace(/\s/g, "").replace(",", ".")) || 0)
        : null;
      const kopilkaId = editGoal.goal_type === "save"
        ? await resolveKopilkaId(editKopilkaId, editKopilkaText)
        : null;

      await invoke("update_goal", {
        id: editGoal.id,
        name: editGoal.name.trim(),
        goalType: editGoal.goal_type,
        category: editGoal.goal_type === "limit" ? editGoal.category : "",
        budget: editGoal.budget,
        dateFrom: editGoal.date_from,
        dateTo: editGoal.date_to,
        kopilkaId,
        manualSpent,
      });
      setEditGoal(null);
      await load();
    } finally {
      setSaving(false);
    }
  }

  function openEditModal(goal: Goal) {
    setEditGoal({ ...goal });
    if (goal.kopilka_id) {
      const k = kopilkas.find(k => k.id === goal.kopilka_id);
      setEditKopilkaId(goal.kopilka_id);
      setEditKopilkaText(k?.name ?? "");
    } else {
      setEditKopilkaId(null);
      setEditKopilkaText("");
    }
    if (goal.manual_spent != null) {
      setEditManualOn(true);
      setEditManualText(String(goal.manual_spent));
    } else {
      setEditManualOn(false);
      setEditManualText("");
    }
  }

  const expenseCategories = categories.filter(c => c.name !== "Доход");

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">Цели</h3>
        <button
          onClick={() => { setShowForm(true); setForm(DEFAULT_FORM()); setFormKopilkaId(null); setFormKopilkaText(""); setFormManualOn(false); setFormManualText(""); setNameTouched(false); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Добавить цель
        </button>
      </div>

      {goals.length === 0 && !showForm && (
        <div className="flex items-center gap-3 rounded-xl border border-dashed border-border px-5 py-6 text-center justify-center">
          <Target className="h-5 w-5 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground/60">Нет активных целей. Добавьте лимит расходов или цель накопления.</p>
        </div>
      )}

      {goals.map(({ goal, spent, pct }) => {
        const left = daysLeft(goal.date_to);
        const isExpired = left < 0;
        const barPct = Math.min(pct, 100);
        const isSave = goal.goal_type === "save";
        const catColors = Object.fromEntries(categories.map(c => [c.name, c.color]));
        const catColor = catColors[goal.category];
        const kopilka = goal.kopilka_id ? kopilkas.find(k => k.id === goal.kopilka_id) : null;
        return (
          <div key={goal.id} className="rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`flex items-center justify-center h-7 w-7 rounded-lg shrink-0 ${isSave ? "bg-sky-500/10" : ""}`}
                  style={{ background: isSave ? undefined : catColor ? `${catColor}20` : undefined }}
                >
                  {isSave
                    ? <PiggyBank className="h-4 w-4 text-sky-400" />
                    : <Target className="h-4 w-4" style={{ color: catColor ?? "#9E9E9E" }} />
                  }
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium leading-none truncate">{goal.name}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {fmtDate(goal.date_from)} — {fmtDate(goal.date_to)}
                    {isExpired ? <span className="ml-1 text-muted-foreground/50">· завершена</span>
                      : <span className="ml-1">· {left === 0 ? "последний день" : `ещё ${left} дн.`}</span>
                    }
                    {goal.manual_spent != null
                      ? <span className="ml-1.5 text-sky-400/70">· факт вручную</span>
                      : kopilka && (
                        <span className="ml-1.5 text-sky-400/70">· {kopilka.name}</span>
                      )}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => openEditModal(goal)}
                  className="text-muted-foreground/30 hover:text-primary transition-colors p-0.5"
                  title="Редактировать"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setDeleteId(goal.id)}
                  className="text-muted-foreground/30 hover:text-red-400 transition-colors p-0.5"
                  title="Удалить"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <span className={`text-base font-bold ${TextColor(goal.goal_type, pct)}`}>
                  {formatCurrency(spent)}
                </span>
                <span className="text-xs text-muted-foreground">
                  из <span className="text-foreground font-medium">{formatCurrency(goal.budget)}</span>
                </span>
              </div>
              <div className="relative h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${BarColor(goal.goal_type, pct)}`}
                  style={{ width: `${barPct}%` }}
                />
              </div>
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>{pct.toFixed(0)}%{isSave ? " накоплено" : " использовано"}</span>
                {!isExpired && !isSave && pct < 100 && (
                  <span>осталось {formatCurrency(goal.budget - spent)}</span>
                )}
                {!isExpired && isSave && (
                  <span>осталось накопить {formatCurrency(Math.max(0, goal.budget - spent))}</span>
                )}
                {pct >= 100 && !isSave && (
                  <span className="text-red-400 font-medium">превышен на {formatCurrency(spent - goal.budget)}</span>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* Create form modal */}
      {showForm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
          onClick={() => setShowForm(false)}
        >
          <div
            className="bg-card border border-border rounded-2xl shadow-2xl w-96 p-6 space-y-4 max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold">Новая цель</h3>

            {/* Type selector */}
            <div>
              <p className="text-xs text-muted-foreground mb-2">Тип</p>
              <div className="grid grid-cols-2 gap-2">
                {(["limit", "save"] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setForm(f => ({ ...f, goal_type: t, category: "" }))}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
                      form.goal_type === t
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground hover:border-primary/50"
                    }`}
                  >
                    {t === "limit" ? <Target className="h-4 w-4" /> : <PiggyBank className="h-4 w-4" />}
                    {t === "limit" ? "Лимит расходов" : "Накопить"}
                  </button>
                ))}
              </div>
            </div>

            {/* Category (only for limit) */}
            {form.goal_type === "limit" && (
              <div>
                <p className="text-xs text-muted-foreground mb-1.5">Категория</p>
                <select
                  value={form.category}
                  onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="">Все расходы</option>
                  {expenseCategories.map(c => (
                    <option key={c.name} value={c.name}>{c.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Kopilka selector (only for save) */}
            {form.goal_type === "save" && !formManualOn && (
              <div>
                <p className="text-xs text-muted-foreground mb-1.5">Копилка</p>
                <KopilkaSelector
                  kopilkas={kopilkas}
                  value={formKopilkaId}
                  inputValue={formKopilkaText}
                  onChange={(id, text) => { setFormKopilkaId(id); setFormKopilkaText(text); }}
                />
              </div>
            )}

            {/* Manual fact toggle (only for save) */}
            {form.goal_type === "save" && (
              <div className="rounded-lg border border-border/60 p-2.5 space-y-2">
                <label className="flex items-center gap-2 cursor-pointer text-xs">
                  <input
                    type="checkbox"
                    checked={formManualOn}
                    onChange={e => setFormManualOn(e.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                  <span className="text-foreground">Указать факт вручную</span>
                </label>
                {formManualOn ? (
                  <div>
                    <input
                      type="number"
                      min={0}
                      value={formManualText}
                      onChange={e => setFormManualText(e.target.value)}
                      placeholder="Уже накоплено, ₽"
                      className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <p className="text-[11px] text-muted-foreground mt-1">Это значение будет показано как прогресс, без автоподсчёта.</p>
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">Иначе прогресс считается автоматически по копилке.</p>
                )}
              </div>
            )}

            {/* Budget */}
            <div>
              <p className="text-xs text-muted-foreground mb-1.5">
                {form.goal_type === "limit" ? "Лимит, ₽" : "Цель накопления, ₽"}
              </p>
              <input
                type="number"
                min={1}
                value={form.budget}
                onChange={e => setForm(f => ({ ...f, budget: e.target.value }))}
                placeholder="5 000"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            {/* Period */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-muted-foreground mb-1.5">Начало</p>
                <input
                  type="date"
                  value={form.date_from}
                  onChange={e => setForm(f => ({ ...f, date_from: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1.5">Конец</p>
                <input
                  type="date"
                  value={form.date_to}
                  onChange={e => setForm(f => ({ ...f, date_to: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>

            {/* Name */}
            <div>
              <p className="text-xs text-muted-foreground mb-1.5">Название</p>
              <input
                type="text"
                value={form.name}
                onChange={e => { setForm(f => ({ ...f, name: e.target.value })); setNameTouched(true); }}
                placeholder="Автоматически"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setShowForm(false)}
                className="flex-1 px-3 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent transition-colors"
              >
                Отмена
              </button>
              <button
                onClick={handleCreate}
                disabled={saving || !form.budget || !form.date_from || !form.date_to}
                className="flex-1 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {saving ? "Создаём..." : "Создать"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit modal */}
      {editGoal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
          onClick={() => setEditGoal(null)}
        >
          <div
            className="bg-card border border-border rounded-2xl shadow-2xl w-96 p-6 space-y-4 max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold">Редактировать цель</h3>

            <div>
              <p className="text-xs text-muted-foreground mb-2">Тип</p>
              <div className="grid grid-cols-2 gap-2">
                {(["limit", "save"] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setEditGoal(g => g ? { ...g, goal_type: t, category: "" } : g)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
                      editGoal.goal_type === t
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground hover:border-primary/50"
                    }`}
                  >
                    {t === "limit" ? <Target className="h-4 w-4" /> : <PiggyBank className="h-4 w-4" />}
                    {t === "limit" ? "Лимит расходов" : "Накопить"}
                  </button>
                ))}
              </div>
            </div>

            {editGoal.goal_type === "limit" && (
              <div>
                <p className="text-xs text-muted-foreground mb-1.5">Категория</p>
                <select
                  value={editGoal.category}
                  onChange={e => setEditGoal(g => g ? { ...g, category: e.target.value } : g)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="">Все расходы</option>
                  {expenseCategories.map(c => (
                    <option key={c.name} value={c.name}>{c.name}</option>
                  ))}
                </select>
              </div>
            )}

            {editGoal.goal_type === "save" && !editManualOn && (
              <div>
                <p className="text-xs text-muted-foreground mb-1.5">Копилка</p>
                <KopilkaSelector
                  kopilkas={kopilkas}
                  value={editKopilkaId}
                  inputValue={editKopilkaText}
                  onChange={(id, text) => { setEditKopilkaId(id); setEditKopilkaText(text); }}
                />
              </div>
            )}

            {editGoal.goal_type === "save" && (
              <div className="rounded-lg border border-border/60 p-2.5 space-y-2">
                <label className="flex items-center gap-2 cursor-pointer text-xs">
                  <input
                    type="checkbox"
                    checked={editManualOn}
                    onChange={e => setEditManualOn(e.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                  <span className="text-foreground">Указать факт вручную</span>
                </label>
                {editManualOn ? (
                  <div>
                    <input
                      type="number"
                      min={0}
                      value={editManualText}
                      onChange={e => setEditManualText(e.target.value)}
                      placeholder="Уже накоплено, ₽"
                      className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <p className="text-[11px] text-muted-foreground mt-1">Это значение будет показано как прогресс, без автоподсчёта.</p>
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">Иначе прогресс считается автоматически по копилке.</p>
                )}
              </div>
            )}

            <div>
              <p className="text-xs text-muted-foreground mb-1.5">
                {editGoal.goal_type === "limit" ? "Лимит, ₽" : "Цель накопления, ₽"}
              </p>
              <input
                type="number"
                min={1}
                value={editGoal.budget}
                onChange={e => setEditGoal(g => g ? { ...g, budget: parseFloat(e.target.value) || 0 } : g)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-muted-foreground mb-1.5">Начало</p>
                <input
                  type="date"
                  value={editGoal.date_from}
                  onChange={e => setEditGoal(g => g ? { ...g, date_from: e.target.value } : g)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1.5">Конец</p>
                <input
                  type="date"
                  value={editGoal.date_to}
                  onChange={e => setEditGoal(g => g ? { ...g, date_to: e.target.value } : g)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1.5">Название</p>
              <input
                type="text"
                value={editGoal.name}
                onChange={e => setEditGoal(g => g ? { ...g, name: e.target.value } : g)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setEditGoal(null)}
                className="flex-1 px-3 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent transition-colors"
              >
                Отмена
              </button>
              <button
                onClick={handleUpdate}
                disabled={saving || !editGoal.name.trim() || !editGoal.budget || !editGoal.date_from || !editGoal.date_to}
                className="flex-1 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {saving ? "Сохраняем..." : "Сохранить"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteId !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm"
          onClick={() => setDeleteId(null)}
        >
          <div className="bg-card border border-border rounded-xl shadow-xl p-5 w-72 space-y-4" onClick={e => e.stopPropagation()}>
            <p className="text-sm font-medium">Удалить цель?</p>
            <p className="text-xs text-muted-foreground">Данные о прогрессе не удаляются — только сама цель.</p>
            <div className="flex gap-2">
              <button onClick={() => setDeleteId(null)} className="flex-1 px-3 py-1.5 rounded-lg border border-border text-xs hover:bg-accent transition-colors">Отмена</button>
              <button onClick={() => handleDelete(deleteId)} className="flex-1 px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs hover:bg-red-600 transition-colors">Удалить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
