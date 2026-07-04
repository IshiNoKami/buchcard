export interface Transaction {
  id?: number;
  import_id?: number;
  date: string;
  amount: number;
  description: string;
  merchant_key: string;
  category: string;
  tx_hash: string;
  is_income: boolean;
}

export interface Category {
  name: string;
  color: string;
  excluded?: boolean;
}

export interface CategorizedTx {
  tx: Transaction;
  source: "keyword" | "llm" | "cache" | "user";
  confidence?: number;
  reasoning?: string;
}

export interface ProgressEvent {
  merchant_key: string;
  category: string;
  source: string;
  confidence?: number;
  done: number;
  total: number;
}

export interface Import {
  id: number;
  filename: string;
  period_from: string;
  period_to: string;
  imported_at: string;
  balance?: number;
  kopilka_id?: number | null;
}

export interface Settings {
  endpoint: string;
  api_key: string;
  model: string;
  advance_day?: number;
  advance_amount?: number;
  salary_day?: number;
  salary_amount?: number;
}

export interface Goal {
  id: number;
  name: string;
  goal_type: 'limit' | 'save';
  category: string;
  budget: number;
  date_from: string;
  date_to: string;
  created_at: string;
  kopilka_id?: number | null;
  manual_spent?: number | null;
}

export interface Kopilka {
  id: number;
  name: string;
  aliases: string[];
}

export interface Credit {
  id: number;
  name: string;
  kind: 'loan' | 'card';
  bank: string;
  principal: number;            // loan: сумма кредита; card: кредитный лимит
  current_balance: number;      // живой остаток долга
  rate_annual: number;
  term_months?: number | null;
  scheduled_payment?: number | null;
  payment_day?: number | null;
  start_date: string;
  grace_days?: number | null;
  statement_day?: number | null;
  min_payment_pct?: number | null;
  archived: boolean;
  created_at: string;
}

export interface CreditStatus {
  credit: Credit;
  progress_pct: number;
  paid_principal: number;
  paid_interest: number;
  // loan
  next_payment_amount?: number | null;
  next_payment_date?: string | null;
  payoff_date?: string | null;
  months_left?: number | null;
  interest_left?: number | null;
  // card
  available?: number | null;
  utilization_pct?: number | null;
  min_payment?: number | null;
  grace_until?: string | null;
  grace_days_left?: number | null;
}

export interface CreditPayment {
  id: number;
  credit_id: number;
  date: string;
  amount: number;
  interest_part: number;
  principal_part: number;
  kind: 'payment' | 'charge' | 'adjust';
  balance_after: number;
  note: string;
  created_at: string;
}

export interface ScheduleRow {
  n: number;
  date?: string | null;
  payment: number;
  interest: number;
  principal: number;
  balance_after: number;
}

export interface NetWorthParts {
  kopilka_total: number;
  credit_debt: number;
}

export interface MonthCompareRow {
  category: string;
  current: number;
  previous: number;
  delta: number;
  pct?: number | null;
}

export interface MonthComparison {
  current_label: string;
  previous_label: string;
  total_current: number;
  total_previous: number;
  rows: MonthCompareRow[];
  has_previous: boolean;
}

export interface ForecastPoint {
  date: string;
  balance: number;
  event?: string | null;
}

export interface CashForecast {
  points: ForecastPoint[];
  min_balance: number;
  min_date: string;
  has_gap: boolean;
  daily_avg: number;
}

export interface Reminder {
  kind: 'loan_payment' | 'grace_expiry';
  title: string;
  body: string;
  key: string;
}

export interface PlannedItem {
  id: number;
  name: string;
  amount: number;
  date: string;
  kind: 'expense' | 'income';
  created_at: string;
}

export interface StrategyOutcome {
  months: number;              // -1 = долг не гасится
  total_interest: number;
  debt_free_date?: string | null;
}

export interface DebtStrategy {
  has_loans: boolean;
  balance_known: boolean;
  monthly_flow: number;
  extra_available: number;
  buffer: number;
  limit_reason?: string | null;
  target?: { credit_id: number; name: string; rate_annual: number; reason: string } | null;
  card_alert?: string | null;
  order: { name: string; rate_annual: number; balance: number }[];
  baseline: StrategyOutcome;
  strategy: StrategyOutcome;
  saved_interest: number;
  months_saved: number;
  chart: { date: string; baseline: number; strategy: number }[];
  alloc_pct: number;
  monthly_plan: MonthPlan[];
}

export interface MonthPlanItem {
  name: string;
  scheduled: number;
  extra: number;
  balance_after: number;
}

export interface MonthPlan {
  date: string;
  total_extra: number;
  items: MonthPlanItem[];
}

export interface CreditPaymentCandidate {
  tx_id: number;
  date: string;
  amount: number;
  description: string;
  credit_id: number;
  credit_name: string;
}

export interface GoalProgress {
  goal: Goal;
  spent: number;
  pct: number;
}

export interface ParseResult {
  new_count: number;
  total_count: number;
  transactions: Transaction[];
}

export interface PdfRow {
  id: number;
  date: string;
  amount: number;
  description: string;
  is_income: boolean;
  warning?: string;
}

export interface ParsedPdf {
  filename: string;
  period_from: string;
  period_to: string;
  account: string;
  rows: PdfRow[];
  warnings: number;
  total: number;
  income_count: number;
}
