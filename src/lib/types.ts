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
