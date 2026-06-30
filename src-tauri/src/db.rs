use anyhow::Result;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use crate::normalizer::normalize_merchant;

pub fn db_path() -> PathBuf {
    let mut p = dirs_next::data_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("buchcard");
    std::fs::create_dir_all(&p).ok();
    p.push("buchcard.db");
    p
}

pub fn open() -> Result<Connection> {
    let conn = Connection::open(db_path())?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    Ok(conn)
}

pub fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS imports (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            filename    TEXT NOT NULL,
            period_from TEXT NOT NULL,
            period_to   TEXT NOT NULL,
            imported_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS categories (
            name  TEXT PRIMARY KEY,
            color TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS merchant_cache (
            merchant_key TEXT PRIMARY KEY,
            category     TEXT NOT NULL,
            source       TEXT NOT NULL,
            confidence   REAL,
            reasoning    TEXT,
            updated_at   TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS transactions (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            import_id    INTEGER REFERENCES imports(id),
            date         TEXT NOT NULL,
            amount       REAL NOT NULL,
            description  TEXT NOT NULL,
            merchant_key TEXT NOT NULL,
            category     TEXT NOT NULL,
            tx_hash      TEXT NOT NULL UNIQUE,
            is_income    INTEGER NOT NULL DEFAULT 0
        );
    ")?;
    conn.execute_batch("ALTER TABLE transactions ADD COLUMN is_income INTEGER NOT NULL DEFAULT 0").ok();
    conn.execute_batch("ALTER TABLE imports ADD COLUMN balance REAL").ok();

    let default_cats = vec![
        ("Доход", "#22C55E"),
        ("Продукты", "#4CAF50"),
        ("Кафе/Рестораны", "#FF9800"),
        ("Транспорт/Такси", "#2196F3"),
        ("ЖКХ + Связь", "#9C27B0"),
        ("Копилка/Сбережения", "#00BCD4"),
        ("Покупки/Маркетплейс", "#F44336"),
        ("Одежда/Обувь", "#EC4899"),
        ("Здоровье", "#E91E63"),
        ("Подписки/Сервисы", "#607D8B"),
        ("Развлечения", "#FF5722"),
        ("Спорт", "#8BC34A"),
        ("Питомцы", "#F59E0B"),
        ("Автоуслуги", "#64748B"),
        ("Переводы", "#795548"),
        ("Прочее", "#9E9E9E"),
    ];
    for (name, color) in default_cats {
        conn.execute(
            "INSERT OR IGNORE INTO categories (name, color) VALUES (?1, ?2)",
            params![name, color],
        )?;
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Category {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Import {
    pub id: i64,
    pub filename: String,
    pub period_from: String,
    pub period_to: String,
    pub imported_at: String,
    pub balance: Option<f64>,
}

pub fn get_imports(conn: &Connection) -> Result<Vec<Import>> {
    let mut stmt = conn.prepare(
        "SELECT id, filename, period_from, period_to, imported_at, balance FROM imports ORDER BY period_from DESC"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Import {
            id: row.get(0)?,
            filename: row.get(1)?,
            period_from: row.get(2)?,
            period_to: row.get(3)?,
            imported_at: row.get(4)?,
            balance: row.get(5)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_categories(conn: &Connection) -> Result<Vec<Category>> {
    let mut stmt = conn.prepare("SELECT name, color FROM categories ORDER BY name")?;
    let rows = stmt.query_map([], |row| {
        Ok(Category { name: row.get(0)?, color: row.get(1)? })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Transaction {
    pub id: Option<i64>,
    pub import_id: Option<i64>,
    pub date: String,
    pub amount: f64,
    pub description: String,
    pub merchant_key: String,
    pub category: String,
    pub tx_hash: String,
    pub is_income: bool,
}

pub fn get_transactions(conn: &Connection) -> Result<Vec<Transaction>> {
    let mut stmt = conn.prepare(
        "SELECT id, import_id, date, amount, description, merchant_key, category, tx_hash, is_income
         FROM transactions ORDER BY date DESC"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Transaction {
            id: row.get(0)?,
            import_id: row.get(1)?,
            date: row.get(2)?,
            amount: row.get(3)?,
            description: row.get(4)?,
            merchant_key: row.get(5)?,
            category: row.get(6)?,
            tx_hash: row.get(7)?,
            is_income: row.get::<_, i64>(8).map(|v| v != 0).unwrap_or(false),
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn known_hashes(conn: &Connection) -> Result<std::collections::HashSet<String>> {
    let mut stmt = conn.prepare("SELECT tx_hash FROM transactions")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn known_merchant_keys(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT merchant_key FROM merchant_cache")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn cache_lookup(conn: &Connection, merchant_key: &str) -> Result<Option<MerchantCache>> {
    let mut stmt = conn.prepare(
        "SELECT category, source, confidence, reasoning FROM merchant_cache WHERE merchant_key = ?1"
    )?;
    let mut rows = stmt.query_map(params![merchant_key], |row| {
        Ok(MerchantCache {
            merchant_key: merchant_key.to_string(),
            category: row.get(0)?,
            source: row.get(1)?,
            confidence: row.get(2)?,
            reasoning: row.get(3)?,
        })
    })?;
    Ok(rows.next().and_then(|r| r.ok()))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MerchantCache {
    pub merchant_key: String,
    pub category: String,
    pub source: String,
    pub confidence: Option<f64>,
    pub reasoning: Option<String>,
}

pub fn upsert_merchant(conn: &Connection, mc: &MerchantCache) -> Result<()> {
    conn.execute("
        INSERT INTO merchant_cache (merchant_key, category, source, confidence, reasoning)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(merchant_key) DO UPDATE SET
            category=excluded.category, source=excluded.source,
            confidence=excluded.confidence, reasoning=excluded.reasoning,
            updated_at=datetime('now')
    ", params![mc.merchant_key, mc.category, mc.source, mc.confidence, mc.reasoning])?;
    Ok(())
}

pub fn create_import(conn: &Connection, filename: &str, period_from: &str, period_to: &str, balance: Option<f64>) -> Result<i64> {
    conn.execute(
        "INSERT INTO imports (filename, period_from, period_to, balance) VALUES (?1, ?2, ?3, ?4)",
        params![filename, period_from, period_to, balance],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn commit_transactions(conn: &Connection, import_id: i64, txs: &[Transaction]) -> Result<usize> {
    let mut inserted = 0;
    for tx in txs {
        let is_income_int: i64 = if tx.is_income { 1 } else { 0 };
        match conn.execute("
            INSERT OR IGNORE INTO transactions
                (import_id, date, amount, description, merchant_key, category, tx_hash, is_income)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ", params![import_id, tx.date, tx.amount, tx.description, tx.merchant_key, tx.category, tx.tx_hash, is_income_int]) {
            Ok(n) => inserted += n,
            Err(_) => {}
        }
    }
    Ok(inserted)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Settings {
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    pub advance_day: Option<u8>,
    pub advance_amount: Option<f64>,
    pub salary_day: Option<u8>,
    pub salary_amount: Option<f64>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            endpoint: "http://localhost:11434".into(),
            api_key: String::new(),
            model: "qwen2.5:14b".into(),
            advance_day: None,
            advance_amount: None,
            salary_day: None,
            salary_amount: None,
        }
    }
}

pub fn get_settings(conn: &Connection) -> Result<Settings> {
    let mut s = Settings::default();
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?)))?;
    for row in rows.flatten() {
        match row.0.as_str() {
            "endpoint"       => s.endpoint        = row.1,
            "api_key"        => s.api_key         = row.1,
            "model"          => s.model           = row.1,
            "advance_day"    => s.advance_day     = row.1.parse().ok(),
            "advance_amount" => s.advance_amount  = row.1.parse().ok(),
            "salary_day"     => s.salary_day      = row.1.parse().ok(),
            "salary_amount"  => s.salary_amount   = row.1.parse().ok(),
            _ => {}
        }
    }
    Ok(s)
}

pub fn save_settings(conn: &Connection, s: &Settings) -> Result<()> {
    let upsert = |k: &str, v: &str| -> Result<()> {
        conn.execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![k, v],
        )?;
        Ok(())
    };
    upsert("endpoint", &s.endpoint)?;
    upsert("api_key",  &s.api_key)?;
    upsert("model",    &s.model)?;
    upsert("advance_day",    &s.advance_day.map(|v| v.to_string()).unwrap_or_default())?;
    upsert("advance_amount", &s.advance_amount.map(|v| v.to_string()).unwrap_or_default())?;
    upsert("salary_day",     &s.salary_day.map(|v| v.to_string()).unwrap_or_default())?;
    upsert("salary_amount",  &s.salary_amount.map(|v| v.to_string()).unwrap_or_default())?;
    Ok(())
}

pub fn add_category(conn: &Connection, name: &str, color: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO categories (name, color) VALUES (?1, ?2)",
        params![name, color],
    )?;
    Ok(())
}

pub fn delete_transaction(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM transactions WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn delete_import(conn: &Connection, import_id: i64) -> Result<usize> {
    let deleted = conn.execute("DELETE FROM transactions WHERE import_id = ?1", params![import_id])?;
    conn.execute("DELETE FROM imports WHERE id = ?1", params![import_id])?;
    Ok(deleted)
}

// ─── Analytics (used by AI chat) ──────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct SpendingSummary {
    pub total_expense: f64,
    pub total_income: f64,
    pub net: f64,
    pub tx_count: i64,
    pub from_date: String,
    pub to_date: String,
    pub days_in_period: i64,
    pub daily_avg: f64,
    pub monthly_projection: f64,
}

#[derive(Debug, Serialize)]
pub struct CategoryTotal {
    pub category: String,
    pub total: f64,
    pub count: i64,
    pub pct: f64,
}

#[derive(Debug, Serialize)]
pub struct MonthlyTotal {
    pub month: String,
    pub total_expense: f64,
    pub total_income: f64,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct MerchantTotal {
    pub merchant_key: String,
    pub category: String,
    pub total: f64,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct DataPeriod {
    pub first_date: String,
    pub last_date: String,
    pub total_transactions: i64,
}

pub fn get_data_period(conn: &Connection) -> Result<DataPeriod> {
    let (first, last, count): (String, String, i64) = conn.query_row(
        "SELECT COALESCE(MIN(date),''), COALESCE(MAX(date),''), COUNT(*) FROM transactions",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    Ok(DataPeriod { first_date: first, last_date: last, total_transactions: count })
}

pub fn get_spending_summary(conn: &Connection, from: &str, to: &str) -> Result<SpendingSummary> {
    let (expense, income, count, days): (f64, f64, i64, i64) = conn.query_row(
        "SELECT
            COALESCE(SUM(CASE WHEN is_income=0 THEN amount ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN is_income=1 THEN amount ELSE 0 END), 0),
            COUNT(*),
            CAST(JULIANDAY(?2) - JULIANDAY(?1) + 1 AS INTEGER)
         FROM transactions WHERE date >= ?1 AND date <= ?2",
        params![from, to],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let days = days.max(1);
    let daily_avg = (expense / days as f64 * 100.0).round() / 100.0;
    let monthly_projection = (daily_avg * 30.0 * 100.0).round() / 100.0;
    Ok(SpendingSummary {
        total_expense: expense,
        total_income: income,
        net: income - expense,
        tx_count: count,
        from_date: from.to_string(),
        to_date: to.to_string(),
        days_in_period: days,
        daily_avg,
        monthly_projection,
    })
}

pub fn get_category_totals(conn: &Connection, from: &str, to: &str) -> Result<Vec<CategoryTotal>> {
    let total: f64 = conn.query_row(
        "SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ?1 AND date <= ?2",
        params![from, to],
        |row| row.get(0),
    ).unwrap_or(0.0);

    let mut stmt = conn.prepare(
        "SELECT category, SUM(amount) as total, COUNT(*) as cnt
         FROM transactions WHERE date >= ?1 AND date <= ?2
         GROUP BY category ORDER BY total DESC"
    )?;
    let rows = stmt.query_map(params![from, to], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?, row.get::<_, i64>(2)?))
    })?;
    Ok(rows.filter_map(|r| r.ok()).map(|(cat, cat_total, count)| CategoryTotal {
        pct: if total > 0.0 { (cat_total / total * 100.0 * 10.0).round() / 10.0 } else { 0.0 },
        category: cat,
        total: cat_total,
        count,
    }).collect())
}

pub fn get_monthly_totals(conn: &Connection, months: i64) -> Result<Vec<MonthlyTotal>> {
    let neg_months = format!("-{}", months);
    let mut stmt = conn.prepare(
        "SELECT strftime('%Y-%m', date) as month, COALESCE(SUM(amount), 0), COUNT(*)
         FROM transactions
         WHERE date >= date('now', ?1 || ' months')
         GROUP BY month ORDER BY month"
    )?;
    let rows = stmt.query_map(params![neg_months], |row| {
        Ok(MonthlyTotal {
            month: row.get(0)?,
            total_expense: row.get(1)?,
            total_income: 0.0,
            count: row.get(2)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// One-time migration: re-apply normalize_merchant to all stored descriptions.
/// Runs only once (guarded by 'merchant_renorm_v2' settings key).
pub fn renormalize_merchant_keys(conn: &Connection) -> Result<()> {
    let done = conn.query_row(
        "SELECT value FROM settings WHERE key = 'merchant_renorm_v2'",
        [],
        |row| row.get::<_, String>(0),
    ).map(|v| v == "1").unwrap_or(false);
    if done { return Ok(()); }

    let pairs: Vec<(i64, String)> = {
        let mut stmt = conn.prepare("SELECT id, description FROM transactions")?;
        let v: Vec<(i64, String)> = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .filter_map(|r| r.ok())
            .collect();
        v
    };

    for (id, desc) in pairs {
        let new_key = normalize_merchant(&desc);
        conn.execute("UPDATE transactions SET merchant_key = ?1 WHERE id = ?2", params![new_key, id])?;
    }

    conn.execute(
        "INSERT INTO settings(key,value) VALUES('merchant_renorm_v2','1')
         ON CONFLICT(key) DO UPDATE SET value='1'",
        [],
    )?;
    Ok(())
}

pub fn get_merchant_totals(conn: &Connection, from: &str, to: &str, limit: i64) -> Result<Vec<MerchantTotal>> {
    let mut stmt = conn.prepare(
        "SELECT merchant_key, category, SUM(amount) as total, COUNT(*) as cnt
         FROM transactions WHERE date >= ?1 AND date <= ?2 AND merchant_key != ''
         GROUP BY merchant_key ORDER BY total DESC LIMIT ?3"
    )?;
    let rows = stmt.query_map(params![from, to, limit], |row| {
        Ok(MerchantTotal {
            merchant_key: row.get(0)?,
            category: row.get(1)?,
            total: row.get(2)?,
            count: row.get(3)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}
