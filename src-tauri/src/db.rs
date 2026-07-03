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
    conn.execute_batch("ALTER TABLE categories ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0").ok();

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

    // One-time: exclude ambiguous transfer/savings categories from accounting by
    // default. They distort income/expense (transfers may not be the user's money,
    // kopilka deposits are internal movements). The user can re-enable them via the
    // category filter — after this runs once, their choice is respected.
    let default_excl_done = conn.query_row(
        "SELECT value FROM settings WHERE key = 'default_excluded_v1'",
        [],
        |row| row.get::<_, String>(0),
    ).map(|v| v == "1").unwrap_or(false);
    if !default_excl_done {
        conn.execute(
            "UPDATE categories SET excluded = 1 WHERE name IN ('Переводы', 'Копилка/Сбережения')",
            [],
        ).ok();
        conn.execute(
            "INSERT INTO settings(key,value) VALUES('default_excluded_v1','1')
             ON CONFLICT(key) DO UPDATE SET value='1'",
            [],
        ).ok();
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Category {
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub excluded: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Import {
    pub id: i64,
    pub filename: String,
    pub period_from: String,
    pub period_to: String,
    pub imported_at: String,
    pub balance: Option<f64>,
    pub kopilka_id: Option<i64>,
}

pub fn get_imports(conn: &Connection) -> Result<Vec<Import>> {
    let mut stmt = conn.prepare(
        "SELECT id, filename, period_from, period_to, imported_at, balance, kopilka_id FROM imports ORDER BY period_from DESC"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Import {
            id: row.get(0)?,
            filename: row.get(1)?,
            period_from: row.get(2)?,
            period_to: row.get(3)?,
            imported_at: row.get(4)?,
            balance: row.get(5)?,
            kopilka_id: row.get(6)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_categories(conn: &Connection) -> Result<Vec<Category>> {
    let mut stmt = conn.prepare("SELECT name, color, COALESCE(excluded, 0) FROM categories ORDER BY name")?;
    let rows = stmt.query_map([], |row| {
        Ok(Category {
            name: row.get(0)?,
            color: row.get(1)?,
            excluded: row.get::<_, i64>(2)? != 0,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn set_category_excluded(conn: &Connection, name: &str, excluded: bool) -> Result<()> {
    conn.execute(
        "UPDATE categories SET excluded = ?1 WHERE name = ?2",
        params![if excluded { 1 } else { 0 }, name],
    )?;
    Ok(())
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

pub fn create_import(conn: &Connection, filename: &str, period_from: &str, period_to: &str, balance: Option<f64>, kopilka_id: Option<i64>) -> Result<i64> {
    conn.execute(
        "INSERT INTO imports (filename, period_from, period_to, balance, kopilka_id) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![filename, period_from, period_to, balance, kopilka_id],
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

/// Round money to 2 decimal places so the LLM never sees noisy float tails.
fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

#[derive(Debug, Serialize)]
pub struct SpendingSummary {
    pub category: Option<String>,
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

pub fn get_spending_summary(conn: &Connection, from: &str, to: &str, category: Option<&str>) -> Result<SpendingSummary> {
    // Day count depends only on the date range, never on the category filter,
    // so monthly_projection stays correct even for a single category.
    let days: i64 = conn.query_row(
        "SELECT CAST(JULIANDAY(?2) - JULIANDAY(?1) + 1 AS INTEGER)",
        params![from, to],
        |row| row.get(0),
    )?;
    let days = days.max(1);

    let (expense, income, count): (f64, f64, i64) = match category {
        Some(cat) => conn.query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN is_income=0 THEN amount ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN is_income=1 THEN amount ELSE 0 END), 0),
                COUNT(*)
             FROM transactions WHERE date >= ?1 AND date <= ?2 AND category = ?3",
            params![from, to, cat],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?,
        None => conn.query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN is_income=0 THEN amount ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN is_income=1 THEN amount ELSE 0 END), 0),
                COUNT(*)
             FROM transactions WHERE date >= ?1 AND date <= ?2",
            params![from, to],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?,
    };

    let daily_avg = round2(expense / days as f64);
    let monthly_projection = round2(daily_avg * 30.0);
    Ok(SpendingSummary {
        category: category.map(|c| c.to_string()),
        total_expense: round2(expense),
        total_income: round2(income),
        net: round2(income - expense),
        tx_count: count,
        from_date: from.to_string(),
        to_date: to.to_string(),
        days_in_period: days,
        daily_avg,
        monthly_projection,
    })
}

pub fn get_category_totals(conn: &Connection, from: &str, to: &str) -> Result<Vec<CategoryTotal>> {
    // denominator = only expense total so percentages are meaningful
    let total: f64 = conn.query_row(
        "SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE is_income=0 AND date >= ?1 AND date <= ?2",
        params![from, to],
        |row| row.get(0),
    ).unwrap_or(0.0);

    let mut stmt = conn.prepare(
        "SELECT category, SUM(amount) as total, COUNT(*) as cnt
         FROM transactions WHERE is_income=0 AND date >= ?1 AND date <= ?2
         GROUP BY category ORDER BY total DESC"
    )?;
    let rows = stmt.query_map(params![from, to], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?, row.get::<_, i64>(2)?))
    })?;
    Ok(rows.filter_map(|r| r.ok()).map(|(cat, cat_total, count)| CategoryTotal {
        pct: if total > 0.0 { (cat_total / total * 100.0 * 10.0).round() / 10.0 } else { 0.0 },
        category: cat,
        total: round2(cat_total),
        count,
    }).collect())
}

pub fn get_monthly_totals(conn: &Connection, from: &str, to: &str) -> Result<Vec<MonthlyTotal>> {
    let mut stmt = conn.prepare(
        "SELECT strftime('%Y-%m', date) as month,
                COALESCE(SUM(CASE WHEN is_income=0 THEN amount ELSE 0 END), 0) as total_expense,
                COALESCE(SUM(CASE WHEN is_income=1 THEN amount ELSE 0 END), 0) as total_income,
                COUNT(*) as cnt
         FROM transactions
         WHERE date >= ?1 AND date <= ?2
         GROUP BY month ORDER BY month"
    )?;
    let rows = stmt.query_map(params![from, to], |row| {
        Ok(MonthlyTotal {
            month: row.get(0)?,
            total_expense: round2(row.get(1)?),
            total_income: round2(row.get(2)?),
            count: row.get(3)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// One-time migration: re-apply normalize_merchant to all stored descriptions.
/// Runs only once (guarded by 'merchant_renorm_v2' settings key).
pub fn renormalize_merchant_keys(conn: &Connection) -> Result<()> {
    let done = conn.query_row(
        "SELECT value FROM settings WHERE key = 'merchant_renorm_v3'",
        [],
        |row| row.get::<_, String>(0),
    ).map(|v| v == "1").unwrap_or(false);
    if done { return Ok(()); }

    // Remove corrupt cache entries with an empty merchant_key — these caused
    // every unrecognised transaction (e.g. bare card numbers like "0466") to
    // inherit a wrong category.
    conn.execute("DELETE FROM merchant_cache WHERE TRIM(merchant_key) = ''", []).ok();

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
        "INSERT INTO settings(key,value) VALUES('merchant_renorm_v3','1')
         ON CONFLICT(key) DO UPDATE SET value='1'",
        [],
    )?;
    Ok(())
}

pub fn get_merchant_totals(conn: &Connection, from: &str, to: &str, limit: i64) -> Result<Vec<MerchantTotal>> {
    let mut stmt = conn.prepare(
        "SELECT merchant_key, category, SUM(amount) as total, COUNT(*) as cnt
         FROM transactions WHERE is_income=0 AND date >= ?1 AND date <= ?2 AND merchant_key != ''
         GROUP BY merchant_key ORDER BY total DESC LIMIT ?3"
    )?;
    let rows = stmt.query_map(params![from, to, limit], |row| {
        Ok(MerchantTotal {
            merchant_key: row.get(0)?,
            category: row.get(1)?,
            total: round2(row.get(2)?),
            count: row.get(3)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

// ─── Goals ────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Goal {
    pub id: i64,
    pub name: String,
    pub goal_type: String,  // "limit" | "save"
    pub category: String,   // category name for limit; "" = all expenses
    pub budget: f64,
    pub date_from: String,
    pub date_to: String,
    pub created_at: String,
    pub kopilka_id: Option<i64>,
    pub manual_spent: Option<f64>,  // user-entered actual fact; overrides auto calc
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GoalProgress {
    pub goal: Goal,
    pub spent: f64,
    pub pct: f64,
}

pub fn init_goals(conn: &Connection) -> Result<()> {
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS goals (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            goal_type  TEXT NOT NULL DEFAULT 'limit',
            category   TEXT NOT NULL DEFAULT '',
            budget     REAL NOT NULL,
            date_from  TEXT NOT NULL,
            date_to    TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ")?;
    // Migration: add kopilka_id if missing (ALTER TABLE ignores errors if column exists)
    let _ = conn.execute("ALTER TABLE goals ADD COLUMN kopilka_id INTEGER", []);
    let _ = conn.execute("ALTER TABLE goals ADD COLUMN manual_spent REAL", []);
    Ok(())
}

// ─── Kopilkas ─────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct Kopilka {
    pub id: i64,
    pub name: String,
    pub aliases: Vec<String>,
}

pub fn init_kopilkas(conn: &Connection) -> Result<()> {
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS kopilkas (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS kopilka_aliases (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            kopilka_id INTEGER NOT NULL REFERENCES kopilkas(id) ON DELETE CASCADE,
            alias      TEXT NOT NULL,
            UNIQUE(kopilka_id, alias)
        );
    ")?;
    // Add kopilka_id to imports if missing (migration)
    let _ = conn.execute("ALTER TABLE imports ADD COLUMN kopilka_id INTEGER REFERENCES kopilkas(id)", []);
    Ok(())
}

pub fn get_kopilkas(conn: &Connection) -> Result<Vec<Kopilka>> {
    let mut stmt = conn.prepare("SELECT id, name FROM kopilkas ORDER BY name")?;
    let kopilkas: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    let mut result = Vec::new();
    for (id, name) in kopilkas {
        let aliases = get_kopilka_aliases(conn, id)?;
        result.push(Kopilka { id, name, aliases });
    }
    Ok(result)
}

pub fn get_kopilka_aliases(conn: &Connection, kopilka_id: i64) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT alias FROM kopilka_aliases WHERE kopilka_id=?1")?;
    let result: Vec<String> = stmt.query_map([kopilka_id], |r| r.get(0))?.filter_map(|r| r.ok()).collect();
    Ok(result)
}

pub fn create_kopilka(conn: &Connection, name: &str, initial_alias: &str) -> Result<i64> {
    conn.execute("INSERT OR IGNORE INTO kopilkas (name) VALUES (?1)", [name])?;
    let id: i64 = conn.query_row(
        "SELECT id FROM kopilkas WHERE name=?1", [name], |r| r.get(0)
    )?;
    let _ = conn.execute(
        "INSERT OR IGNORE INTO kopilka_aliases (kopilka_id, alias) VALUES (?1, ?2)",
        params![id, initial_alias],
    );
    Ok(id)
}

pub fn add_kopilka_alias(conn: &Connection, kopilka_id: i64, alias: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO kopilka_aliases (kopilka_id, alias) VALUES (?1, ?2)",
        params![kopilka_id, alias],
    )?;
    Ok(())
}

/// Find unique income transaction descriptions not yet matched to any kopilka alias.
/// Returns Vec<(description, count)> sorted by frequency (most common first, up to 20).
pub fn find_unmatched_kopilka_descriptions(conn: &Connection) -> Result<Vec<(String, i64)>> {
    let known_aliases: Vec<String> = {
        let mut s = conn.prepare("SELECT LOWER(alias) FROM kopilka_aliases")?;
        let v: Vec<String> = s.query_map([], |r| r.get::<_, String>(0))?.filter_map(|r| r.ok()).collect();
        v
    };
    let mut stmt = conn.prepare(
        "SELECT description, COUNT(*) as cnt
         FROM transactions
         WHERE is_income=1
         GROUP BY description
         ORDER BY cnt DESC
         LIMIT 20"
    )?;
    let rows: Vec<(String, i64)> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
        .filter_map(|r| r.ok())
        .filter(|(desc, _)| {
            let d = desc.to_lowercase();
            !known_aliases.iter().any(|a| d.contains(a.as_str()))
        })
        .collect();
    Ok(rows)
}

pub fn get_goals(conn: &Connection) -> Result<Vec<Goal>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, goal_type, category, budget, date_from, date_to, created_at, kopilka_id, manual_spent
         FROM goals ORDER BY date_to ASC"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Goal {
            id:           row.get(0)?,
            name:         row.get(1)?,
            goal_type:    row.get(2)?,
            category:     row.get(3)?,
            budget:       row.get(4)?,
            date_from:    row.get(5)?,
            date_to:      row.get(6)?,
            created_at:   row.get(7)?,
            kopilka_id:   row.get(8)?,
            manual_spent: row.get(9)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn create_goal(
    conn: &Connection,
    name: &str,
    goal_type: &str,
    category: &str,
    budget: f64,
    date_from: &str,
    date_to: &str,
    kopilka_id: Option<i64>,
    manual_spent: Option<f64>,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO goals (name, goal_type, category, budget, date_from, date_to, kopilka_id, manual_spent)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![name, goal_type, category, budget, date_from, date_to, kopilka_id, manual_spent],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn delete_goal(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM goals WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn update_goal(
    conn: &Connection,
    id: i64,
    name: &str,
    goal_type: &str,
    category: &str,
    budget: f64,
    date_from: &str,
    date_to: &str,
    kopilka_id: Option<i64>,
    manual_spent: Option<f64>,
) -> Result<()> {
    conn.execute(
        "UPDATE goals SET name=?1, goal_type=?2, category=?3, budget=?4, date_from=?5, date_to=?6, kopilka_id=?7, manual_spent=?8 WHERE id=?9",
        params![name, goal_type, category, budget, date_from, date_to, kopilka_id, manual_spent, id],
    )?;
    Ok(())
}

pub fn get_goal_spent(conn: &Connection, goal: &Goal) -> Result<f64> {
    // A user-entered fact always wins over any automatic calculation.
    if let Some(manual) = goal.manual_spent {
        return Ok(manual);
    }
    let spent: f64 = if goal.goal_type == "save" {
        if let Some(kid) = goal.kopilka_id {
            // Check if there are imports tagged with this kopilka (import-based tracking)
            let tagged_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM imports WHERE kopilka_id=?1",
                [kid],
                |r| r.get(0),
            ).unwrap_or(0);

            if tagged_count > 0 {
                // Sum deposits (is_income=1) from the savings account imports within the date range
                conn.query_row(
                    "SELECT COALESCE(SUM(t.amount), 0)
                     FROM transactions t
                     JOIN imports i ON t.import_id = i.id
                     WHERE i.kopilka_id = ?1 AND t.is_income = 1
                     AND t.date >= ?2 AND t.date <= ?3",
                    params![kid, &goal.date_from, &goal.date_to],
                    |r| r.get(0),
                )?
            } else {
                // Fall back to alias-based matching
                let aliases = get_kopilka_aliases(conn, kid)?;
                if aliases.is_empty() {
                    0.0
                } else {
                    let mut total = 0.0f64;
                    for alias in &aliases {
                        let v: f64 = conn.query_row(
                            "SELECT COALESCE(SUM(amount),0) FROM transactions
                             WHERE is_income=0 AND date>=?1 AND date<=?2
                             AND LOWER(description) LIKE '%' || LOWER(?3) || '%'",
                            params![&goal.date_from, &goal.date_to, alias],
                            |r| r.get(0),
                        )?;
                        total += v;
                    }
                    total
                }
            }
        } else {
            let income: f64 = conn.query_row(
                "SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE is_income=1 AND date>=?1 AND date<=?2",
                params![&goal.date_from, &goal.date_to],
                |r| r.get(0),
            )?;
            let expense: f64 = conn.query_row(
                "SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE is_income=0 AND date>=?1 AND date<=?2",
                params![&goal.date_from, &goal.date_to],
                |r| r.get(0),
            )?;
            (income - expense).max(0.0)
        }
    } else if goal.category.is_empty() {
        conn.query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE is_income=0 AND date>=?1 AND date<=?2",
            params![&goal.date_from, &goal.date_to],
            |r| r.get(0),
        )?
    } else {
        conn.query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE is_income=0 AND category=?1 AND date>=?2 AND date<=?3",
            params![&goal.category, &goal.date_from, &goal.date_to],
            |r| r.get(0),
        )?
    };
    Ok(spent)
}
