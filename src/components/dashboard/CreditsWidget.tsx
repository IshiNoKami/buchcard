import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Trash2, Pencil, Landmark, CreditCard, CalendarClock, ListTree } from "lucide-react";
import { CreditStatus, Credit, ScheduleRow } from "@/lib/types";
import { formatCurrency, formatDate, cn } from "@/lib/utils";

type Kind = "loan" | "card";

const todayISO = () => new Date().toISOString().slice(0, 10);

const parseNum = (s: string): number => parseFloat(s.replace(/\s/g, "").replace(",", ".")) || 0;
const numOrNull = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  const v = parseFloat(t.replace(/\s/g, "").replace(",", "."));
  return isNaN(v) ? null : v;
};
const intOrNull = (s: string): number | null => {
  const v = numOrNull(s);
  return v == null ? null : Math.round(v);
};

const DEFAULT_FORM = () => ({
  kind: "loan" as Kind,
  name: "",
  bank: "",
  principal: "",
  current_balance: "",
  rate_annual: "",
  term_months: "",
  monthly_payment: "",
  payment_day: "",
  start_date: todayISO(),
  grace_days: "55",
  statement_day: "",
  min_payment_pct: "5",
});
type FormState = ReturnType<typeof DEFAULT_FORM>;

function utilColor(pct: number): string {
  if (pct >= 70) return "bg-red-500";
  if (pct >= 30) return "bg-amber-500";
  return "bg-emerald-500";
}

export function CreditsWidget() {
  const [credits, setCredits] = useState<CreditStatus[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [editId, setEditId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  // Payment modal
  const [payFor, setPayFor] = useState<CreditStatus | null>(null);
  const [payKind, setPayKind] = useState<"payment" | "charge">("payment");
  const [payAmount, setPayAmount] = useState("");
  const [prepayMode, setPrepayMode] = useState<"reduce_term" | "reduce_payment">("reduce_term");
  const [payErr, setPayErr] = useState("");

  // Schedule modal
  const [scheduleFor, setScheduleFor] = useState<CreditStatus | null>(null);
  const [scheduleRows, setScheduleRows] = useState<ScheduleRow[]>([]);

  const load = useCallback(async () => {
    try {
      setCredits(await invoke<CreditStatus[]>("get_credits"));
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

  function openCreate() {
    setForm(DEFAULT_FORM());
    setEditId(null);
    setShowForm(true);
  }

  function openEdit(c: Credit) {
    setForm({
      kind: c.kind,
      name: c.name,
      bank: c.bank,
      principal: String(c.principal),
      current_balance: String(c.current_balance),
      rate_annual: String(c.rate_annual),
      term_months: c.term_months != null ? String(c.term_months) : "",
      monthly_payment: c.scheduled_payment != null ? String(Math.round(c.scheduled_payment * 100) / 100) : "",
      payment_day: c.payment_day != null ? String(c.payment_day) : "",
      start_date: c.start_date.slice(0, 10),
      grace_days: c.grace_days != null ? String(c.grace_days) : "",
      statement_day: c.statement_day != null ? String(c.statement_day) : "",
      min_payment_pct: c.min_payment_pct != null ? String(c.min_payment_pct) : "",
    });
    setEditId(c.id);
    setShowForm(true);
  }

  async function handleSave() {
    const principal = parseNum(form.principal);
    if (!form.name.trim() || principal <= 0) return;
    const currentBalance = form.current_balance.trim() ? parseNum(form.current_balance) : principal;

    const common = {
      name: form.name.trim(),
      bank: form.bank.trim(),
      principal,
      currentBalance,
      rateAnnual: parseNum(form.rate_annual),
      termMonths: form.kind === "loan" ? intOrNull(form.term_months) : null,
      monthlyPayment: form.kind === "loan" ? numOrNull(form.monthly_payment) : null,
      paymentDay: intOrNull(form.payment_day),
      startDate: form.start_date,
      graceDays: form.kind === "card" ? intOrNull(form.grace_days) : null,
      statementDay: form.kind === "card" ? intOrNull(form.statement_day) : null,
      minPaymentPct: form.kind === "card" ? numOrNull(form.min_payment_pct) : null,
    };

    setSaving(true);
    try {
      if (editId != null) {
        await invoke("update_credit", { id: editId, ...common });
      } else {
        await invoke("create_credit", { kind: form.kind, ...common });
      }
      setShowForm(false);
      await load();
    } catch (e) {
      console.error(e);
      alert("Ошибка сохранения: " + String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    await invoke("delete_credit", { id });
    setDeleteId(null);
    await load();
  }

  // Loan: quick scheduled payment
  async function payScheduled(c: CreditStatus) {
    const amount = c.next_payment_amount ?? c.credit.scheduled_payment ?? 0;
    if (amount <= 0) return;
    try {
      await invoke("add_credit_payment", {
        creditId: c.credit.id,
        date: todayISO(),
        amount,
        kind: "payment",
        prepayMode: null,
        note: "Плановый платёж",
      });
      await load();
    } catch (e) {
      alert("Ошибка: " + String(e));
    }
  }

  function openPayModal(c: CreditStatus, kind: "payment" | "charge") {
    setPayFor(c);
    setPayKind(kind);
    setPrepayMode("reduce_term");
    setPayErr("");
    if (kind === "payment" && c.credit.kind === "card") {
      setPayAmount(c.min_payment != null ? String(Math.round(c.min_payment)) : "");
    } else if (kind === "payment") {
      setPayAmount(c.next_payment_amount != null ? String(Math.round(c.next_payment_amount)) : "");
    } else {
      setPayAmount("");
    }
  }

  async function submitPayment() {
    if (!payFor) return;
    const amount = parseNum(payAmount);
    if (amount <= 0) { setPayErr("Укажите сумму"); return; }
    const isLoan = payFor.credit.kind === "loan";
    const scheduled = payFor.credit.scheduled_payment ?? 0;
    const isPrepay = isLoan && payKind === "payment" && amount > scheduled + 0.01;
    try {
      await invoke("add_credit_payment", {
        creditId: payFor.credit.id,
        date: todayISO(),
        amount,
        kind: payKind,
        prepayMode: isPrepay ? prepayMode : null,
        note: payKind === "charge" ? "Трата" : "Платёж",
      });
      setPayFor(null);
      await load();
    } catch (e) {
      setPayErr(String(e).replace(/^.*Error: /, ""));
    }
  }

  async function openSchedule(c: CreditStatus) {
    setScheduleFor(c);
    try {
      setScheduleRows(await invoke<ScheduleRow[]>("get_credit_schedule", { creditId: c.credit.id }));
    } catch (e) {
      console.error(e);
      setScheduleRows([]);
    }
  }

  const isLoanForm = form.kind === "loan";

  // Сводка по активным обязательствам
  const active = credits.filter((c) => !c.credit.archived);
  const activeLoans = active.filter((c) => c.credit.kind === "loan");
  const totalDebt = active.reduce((s, c) => s + c.credit.current_balance, 0);
  const monthlyTotal = activeLoans.reduce((s, c) => s + (c.next_payment_amount ?? 0), 0);
  const overpayTotal = activeLoans.reduce((s, c) => s + (c.interest_left ?? 0), 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">Кредиты и карты</h3>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Добавить
        </button>
      </div>

      {credits.length === 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-dashed border-border px-5 py-6 text-center justify-center">
          <Landmark className="h-5 w-5 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground/60">Нет кредитов и карт. Добавьте кредит или кредитную карту.</p>
        </div>
      )}

      {/* Summary */}
      {active.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-xl border border-border bg-card p-3">
            <p className="text-[11px] text-muted-foreground">Общий долг</p>
            <p className="text-lg font-bold text-foreground leading-tight">{formatCurrency(totalDebt)}</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-3">
            <p className="text-[11px] text-muted-foreground">Платежи в месяц</p>
            <p className="text-lg font-bold text-sky-400 leading-tight">{formatCurrency(monthlyTotal)}</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-3">
            <p className="text-[11px] text-muted-foreground">Переплата (прогноз)</p>
            <p className="text-lg font-bold text-amber-400 leading-tight">{formatCurrency(overpayTotal)}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {credits.map((c) => {
        const isCard = c.credit.kind === "card";
        const barPct = Math.min(c.progress_pct, 100);
        return (
          <div key={c.credit.id} className={cn("rounded-xl border bg-card p-4 space-y-3", c.credit.archived ? "border-border/50 opacity-70" : "border-border")}>
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className={cn("flex items-center justify-center h-7 w-7 rounded-lg shrink-0", isCard ? "bg-violet-500/10" : "bg-sky-500/10")}>
                  {isCard ? <CreditCard className="h-4 w-4 text-violet-400" /> : <Landmark className="h-4 w-4 text-sky-400" />}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium leading-none truncate">
                    {c.credit.name}
                    {c.credit.archived && <span className="ml-1.5 text-[11px] text-emerald-400">· погашен</span>}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {c.credit.bank ? `${c.credit.bank} · ` : ""}
                    {c.credit.rate_annual}% годовых
                    {isCard ? " · карта" : c.months_left && c.months_left > 0 ? ` · осталось ${c.months_left} мес.` : ""}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!isCard && (
                  <button onClick={() => openSchedule(c)} className="text-muted-foreground/30 hover:text-sky-400 transition-colors p-0.5" title="График платежей">
                    <ListTree className="h-3.5 w-3.5" />
                  </button>
                )}
                <button onClick={() => openEdit(c.credit)} className="text-muted-foreground/30 hover:text-primary transition-colors p-0.5" title="Редактировать">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => setDeleteId(c.credit.id)} className="text-muted-foreground/30 hover:text-red-400 transition-colors p-0.5" title="Удалить">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Balance + progress */}
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <span className={cn("text-base font-bold", isCard ? "text-violet-400" : "text-sky-400")}>
                  {formatCurrency(c.credit.current_balance)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {isCard ? "долг из " : "осталось из "}
                  <span className="text-foreground font-medium">{formatCurrency(c.credit.principal)}</span>
                  {isCard ? " лимита" : ""}
                </span>
              </div>
              <div className="relative h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={cn("h-full rounded-full transition-all", isCard ? utilColor(c.progress_pct) : "bg-sky-500")}
                  style={{ width: `${barPct}%` }}
                />
              </div>

              {/* Loan details */}
              {!isCard && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1 text-[11px] text-muted-foreground">
                  {c.next_payment_amount != null && (
                    <span>Платёж: <span className="text-foreground font-medium">{formatCurrency(c.next_payment_amount)}</span></span>
                  )}
                  {c.next_payment_date && (
                    <span className="flex items-center gap-1"><CalendarClock className="h-3 w-3" />{formatDate(c.next_payment_date)}</span>
                  )}
                  {c.payoff_date && <span>Погашение: <span className="text-foreground">{formatDate(c.payoff_date)}</span></span>}
                  {c.interest_left != null && <span>Переплата: <span className="text-amber-400">{formatCurrency(c.interest_left)}</span></span>}
                </div>
              )}

              {/* Card details */}
              {isCard && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1 text-[11px] text-muted-foreground">
                  <span>Доступно: <span className="text-emerald-400 font-medium">{formatCurrency(c.available ?? 0)}</span></span>
                  <span>Утилизация: <span className="text-foreground">{(c.utilization_pct ?? 0).toFixed(0)}%</span></span>
                  {c.min_payment != null && <span>Мин. платёж: <span className="text-foreground">{formatCurrency(c.min_payment)}</span></span>}
                  {c.grace_until != null && c.grace_days_left != null && (
                    <span className={c.grace_days_left >= 0 ? "text-emerald-400" : "text-red-400"}>
                      {c.grace_days_left >= 0 ? `Грейс: ещё ${c.grace_days_left} дн.` : "Грейс истёк"}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Actions */}
            {!c.credit.archived && (
              <div className="flex gap-2 pt-0.5">
                {!isCard ? (
                  <>
                    <button
                      onClick={() => payScheduled(c)}
                      className="flex-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
                    >
                      Внёс платёж{c.next_payment_amount ? ` · ${formatCurrency(c.next_payment_amount)}` : ""}
                    </button>
                    <button
                      onClick={() => openPayModal(c, "payment")}
                      className="px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
                    >
                      Указать платёж
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => openPayModal(c, "payment")}
                      className="flex-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
                    >
                      Внёс платёж
                    </button>
                    <button
                      onClick={() => openPayModal(c, "charge")}
                      className="px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:border-red-400/50 transition-colors"
                    >
                      Добавить трату
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
      </div>

      {/* Create / Edit modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm" onClick={() => setShowForm(false)}>
          <div className="bg-card border border-border rounded-2xl shadow-2xl w-[26rem] p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold">{editId != null ? "Редактировать" : "Новый кредит / карта"}</h3>

            {/* Type selector (only on create) */}
            {editId == null && (
              <div>
                <p className="text-xs text-muted-foreground mb-2">Тип</p>
                <div className="grid grid-cols-2 gap-2">
                  {(["loan", "card"] as const).map((k) => (
                    <button
                      key={k}
                      onClick={() => setForm((f) => ({ ...f, kind: k }))}
                      className={cn(
                        "flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors",
                        form.kind === k ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:border-primary/50"
                      )}
                    >
                      {k === "loan" ? <Landmark className="h-4 w-4" /> : <CreditCard className="h-4 w-4" />}
                      {k === "loan" ? "Кредит" : "Карта"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label="Название" full>
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder={isLoanForm ? "Ипотека" : "Кредитка"} className={inputCls} />
              </Field>
              <Field label="Банк" full>
                <input value={form.bank} onChange={(e) => setForm((f) => ({ ...f, bank: e.target.value }))} placeholder="Совкомбанк" className={inputCls} />
              </Field>

              <Field label={isLoanForm ? "Сумма кредита, ₽" : "Кредитный лимит, ₽"}>
                <input type="text" inputMode="decimal" value={form.principal} onChange={(e) => setForm((f) => ({ ...f, principal: e.target.value }))} placeholder="1 000 000" className={inputCls} />
              </Field>
              <Field label={isLoanForm ? "Остаток долга, ₽" : "Текущий долг, ₽"}>
                <input type="text" inputMode="decimal" value={form.current_balance} onChange={(e) => setForm((f) => ({ ...f, current_balance: e.target.value }))} placeholder={isLoanForm ? "= сумме" : "0"} className={inputCls} />
              </Field>

              <Field label="Ставка, % годовых">
                <input type="text" inputMode="decimal" value={form.rate_annual} onChange={(e) => setForm((f) => ({ ...f, rate_annual: e.target.value }))} placeholder="20" className={inputCls} />
              </Field>
              {isLoanForm ? (
                <Field label="Срок, мес.">
                  <input type="text" inputMode="numeric" value={form.term_months} onChange={(e) => setForm((f) => ({ ...f, term_months: e.target.value }))} placeholder="60" className={inputCls} />
                </Field>
              ) : (
                <Field label="Мин. платёж, %">
                  <input type="text" inputMode="decimal" value={form.min_payment_pct} onChange={(e) => setForm((f) => ({ ...f, min_payment_pct: e.target.value }))} placeholder="5" className={inputCls} />
                </Field>
              )}

              {isLoanForm && (
                <Field label="Ежемесячный платёж, ₽" full>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={form.monthly_payment}
                    onChange={(e) => setForm((f) => ({ ...f, monthly_payment: e.target.value }))}
                    placeholder="пусто = рассчитать по ставке"
                    className={inputCls}
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Укажите сумму из банка (со страховками) — или оставьте пустым для авторасчёта.
                  </p>
                </Field>
              )}

              <Field label={isLoanForm ? "День платежа" : "День выписки"}>
                <input type="text" inputMode="numeric" value={isLoanForm ? form.payment_day : form.statement_day} onChange={(e) => setForm((f) => (isLoanForm ? { ...f, payment_day: e.target.value } : { ...f, statement_day: e.target.value }))} placeholder="10" className={inputCls} />
              </Field>
              {isLoanForm ? (
                <Field label="Дата выдачи">
                  <input type="date" value={form.start_date} onChange={(e) => setForm((f) => ({ ...f, start_date: e.target.value }))} className={inputCls} />
                </Field>
              ) : (
                <Field label="Льготный период, дн.">
                  <input type="text" inputMode="numeric" value={form.grace_days} onChange={(e) => setForm((f) => ({ ...f, grace_days: e.target.value }))} placeholder="55" className={inputCls} />
                </Field>
              )}
            </div>

            <div className="flex gap-2 pt-1">
              <button onClick={() => setShowForm(false)} className="flex-1 px-3 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent transition-colors">Отмена</button>
              <button onClick={handleSave} disabled={saving || !form.name.trim() || !form.principal} className="flex-1 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors">
                {saving ? "Сохраняем…" : editId != null ? "Сохранить" : "Добавить"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Payment modal */}
      {payFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm" onClick={() => setPayFor(null)}>
          <div className="bg-card border border-border rounded-2xl shadow-2xl w-80 p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold">
              {payKind === "charge" ? "Новая трата по карте" : "Внести платёж"} — {payFor.credit.name}
            </h3>
            <div>
              <p className="text-xs text-muted-foreground mb-1.5">Сумма, ₽</p>
              <input autoFocus type="text" inputMode="decimal" value={payAmount} onChange={(e) => { setPayAmount(e.target.value); setPayErr(""); }} placeholder="10 000" className={inputCls} />
            </div>

            {/* Prepayment mode for loans when amount > scheduled */}
            {payFor.credit.kind === "loan" && payKind === "payment" && parseNum(payAmount) > (payFor.credit.scheduled_payment ?? 0) + 0.01 && (
              <div>
                <p className="text-xs text-muted-foreground mb-2">Досрочное погашение — что уменьшить?</p>
                <div className="grid grid-cols-2 gap-2">
                  {([["reduce_term", "Срок"], ["reduce_payment", "Платёж"]] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      onClick={() => setPrepayMode(mode)}
                      className={cn("px-3 py-2 rounded-lg border text-xs transition-colors", prepayMode === mode ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:border-primary/50")}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {prepayMode === "reduce_term" ? "Платёж прежний, кредит гасится быстрее (выгоднее)." : "Срок прежний, ежемесячный платёж уменьшится."}
                </p>
              </div>
            )}

            {payErr && <p className="text-[11px] text-red-400">{payErr}</p>}

            <div className="flex gap-2 pt-1">
              <button onClick={() => setPayFor(null)} className="flex-1 px-3 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent transition-colors">Отмена</button>
              <button onClick={submitPayment} className="flex-1 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">
                {payKind === "charge" ? "Добавить трату" : "Записать платёж"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Schedule modal */}
      {scheduleFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm" onClick={() => setScheduleFor(null)}>
          <div className="bg-card border border-border rounded-2xl shadow-2xl w-[34rem] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3 border-b border-border">
              <h3 className="text-sm font-semibold">График платежей — {scheduleFor.credit.name}</h3>
              <p className="text-[11px] text-muted-foreground mt-0.5">Прогноз от текущего остатка. Всего {scheduleRows.length} платежей.</p>
            </div>
            <div className="overflow-y-auto flex-1">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-card border-b border-border text-muted-foreground">
                  <tr>
                    <th className="text-left font-normal py-2 px-3">#</th>
                    <th className="text-left font-normal py-2 px-2">Дата</th>
                    <th className="text-right font-normal py-2 px-2">Платёж</th>
                    <th className="text-right font-normal py-2 px-2">Проценты</th>
                    <th className="text-right font-normal py-2 px-2">Тело</th>
                    <th className="text-right font-normal py-2 px-3">Остаток</th>
                  </tr>
                </thead>
                <tbody>
                  {scheduleRows.map((r) => (
                    <tr key={r.n} className="border-b border-border/20">
                      <td className="py-1 px-3 text-muted-foreground">{r.n}</td>
                      <td className="py-1 px-2">{r.date ? formatDate(r.date) : "—"}</td>
                      <td className="py-1 px-2 text-right">{formatCurrency(r.payment)}</td>
                      <td className="py-1 px-2 text-right text-amber-400/80">{formatCurrency(r.interest)}</td>
                      <td className="py-1 px-2 text-right text-sky-400/80">{formatCurrency(r.principal)}</td>
                      <td className="py-1 px-3 text-right text-foreground">{formatCurrency(r.balance_after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-5 py-3 border-t border-border flex justify-end">
              <button onClick={() => setScheduleFor(null)} className="px-4 py-1.5 rounded-lg border border-border text-xs hover:bg-accent transition-colors">Закрыть</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm" onClick={() => setDeleteId(null)}>
          <div className="bg-card border border-border rounded-xl shadow-xl p-5 w-72 space-y-4" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-medium">Удалить кредит?</p>
            <p className="text-xs text-muted-foreground">Все записанные платежи по нему тоже будут удалены.</p>
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

const inputCls = "w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary";

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={full ? "col-span-2" : ""}>
      <p className="text-xs text-muted-foreground mb-1.5">{label}</p>
      {children}
    </div>
  );
}
