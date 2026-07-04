use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

use crate::categorizer::CategorizedTx;
use crate::db::{self, Category, Import, MerchantCache, Settings, Transaction};
use crate::importer::{filter_new, parse_xls, tx_hash};
use crate::pdf_parser::{ConfirmedPdfRow, ParsedPdf};
use crate::normalizer::MerchantIndex;

pub struct AppState(pub Mutex<rusqlite::Connection>);

// ─── Dashboard ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_transactions(state: State<AppState>) -> Result<Vec<Transaction>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::get_transactions(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_categories(state: State<AppState>) -> Result<Vec<Category>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::get_categories(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_imports(state: State<AppState>) -> Result<Vec<Import>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::get_imports(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_category(name: String, color: String, state: State<AppState>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::add_category(&conn, &name, &color).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_category_excluded(name: String, excluded: bool, state: State<AppState>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::set_category_excluded(&conn, &name, excluded).map_err(|e| e.to_string())
}

// ─── Settings ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Result<Settings, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::get_settings(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_settings(settings: Settings, state: State<AppState>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::save_settings(&conn, &settings).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct ModelInfo {
    pub name: String,
}

#[tauri::command]
pub async fn fetch_models(endpoint: String, api_key: String) -> Result<Vec<ModelInfo>, String> {
    // On Windows localhost resolves to ::1 (IPv6) first; Ollama only binds to 127.0.0.1
    let endpoint = endpoint.replace("localhost", "127.0.0.1");
    let url = format!("{}/api/tags", endpoint.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(&url);
    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", api_key));
    }
    let resp = req.send().await.map_err(|e| {
        let s = e.to_string();
        if e.is_connect() || s.contains("10054") || s.contains("10061") || s.contains("refused") {
            if endpoint.contains("ollama.com") {
                "Не удалось подключиться к Ollama Cloud. Проверьте интернет-соединение.".to_string()
            } else {
                "Ollama не запущен. Запустите его: ollama serve".to_string()
            }
        } else {
            s
        }
    })?;
    let status = resp.status();
    if status.as_u16() == 401 {
        return Err("Неверный API ключ. Проверьте ключ на ollama.com/settings/keys".to_string());
    }
    if !status.is_success() {
        return Err(format!("Сервер вернул ошибку: {}", status));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let models = body["models"]
        .as_array()
        .ok_or("no models field")?
        .iter()
        .filter_map(|m| m["name"].as_str().map(|n| ModelInfo { name: n.to_string() }))
        .collect();
    Ok(models)
}

#[tauri::command]
pub fn start_ollama() -> Result<String, String> {
    #[cfg(windows)]
    {
        let base = std::path::PathBuf::from(
            std::env::var("LOCALAPPDATA").unwrap_or_default()
        ).join("Programs").join("Ollama");

        let tray = base.join("Ollama.exe");
        let cli  = base.join("ollama.exe");

        if !tray.exists() && !cli.exists() {
            // Try PATH before giving up
            let r = std::process::Command::new("ollama")
                .arg("serve")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
            return match r {
                Ok(_) => Ok("ollama (PATH)".to_string()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound =>
                    Err("Ollama не установлен. Скачайте на ollama.com/download".to_string()),
                Err(e) => Err(e.to_string()),
            };
        }

        // Kill any zombie/stuck Ollama instances first so the fresh start succeeds
        let _ = std::process::Command::new("taskkill")
            .args(["/f", "/im", "Ollama.exe"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        let _ = std::process::Command::new("taskkill")
            .args(["/f", "/im", "ollama.exe"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();

        // Brief pause to let OS release the port
        std::thread::sleep(std::time::Duration::from_millis(800));

        let exe = if tray.exists() { &tray } else { &cli };
        let mut cmd = std::process::Command::new(exe);
        // CLI needs "serve" arg; tray app starts server automatically
        if exe == &cli {
            cmd.arg("serve");
        }
        cmd.stdin(std::process::Stdio::null())
           .stdout(std::process::Stdio::null())
           .stderr(std::process::Stdio::null())
           .spawn()
           .map_err(|e| e.to_string())?;

        Ok(exe.to_string_lossy().to_string())
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("ollama")
            .arg("serve")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "Ollama не установлен. Скачайте на ollama.com/download".to_string()
                } else {
                    e.to_string()
                }
            })?;
        Ok("ollama serve".to_string())
    }
}

// Reachability check for Ollama. Local endpoints use a fast TCP probe on
// 127.0.0.1 (avoids IPv6 "localhost" resolution issues). Remote/cloud endpoints
// (e.g. https://ollama.com) can't be TCP-pinged on localhost, so we do a short
// HTTP probe instead — any HTTP response means the server is reachable.
#[tauri::command]
pub async fn ping_ollama(endpoint: String) -> bool {
    let ep = endpoint.trim_end_matches('/').to_string();
    let is_local = ep.contains("localhost") || ep.contains("127.0.0.1");

    if is_local {
        let port: u16 = ep
            .rsplit(':')
            .next()
            .and_then(|p| p.parse().ok())
            .unwrap_or(11434);
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        return tokio::time::timeout(
            std::time::Duration::from_secs(2),
            tokio::net::TcpStream::connect(addr),
        ).await.map(|r| r.is_ok()).unwrap_or(false);
    }

    // Remote / cloud: HTTP probe. Even a 401/403 proves the host answers.
    let url = format!("{}/api/version", ep);
    match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
    {
        Ok(client) => client.get(&url).send().await.is_ok(),
        Err(_) => false,
    }
}

// ─── Mutations ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn delete_transaction(id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::delete_transaction(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_import(import_id: i64, state: State<AppState>) -> Result<usize, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::delete_import(&conn, import_id).map_err(|e| e.to_string())
}

// ─── PDF Import ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn parse_pdf_preview(path: String) -> Result<ParsedPdf, String> {
    crate::pdf_parser::parse_sovkombank_pdf(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pdf_rows_to_transactions(
    rows: Vec<ConfirmedPdfRow>,
    state: State<AppState>,
) -> Result<ParseResult, String> {
    let all: Vec<Transaction> = rows
        .into_iter()
        .map(|r| {
            let merchant_key = if r.is_income {
                "Доход".to_string()
            } else {
                crate::normalizer::normalize_merchant(&r.description)
            };
            let tx_hash = tx_hash(&r.date, r.amount, &r.description);
            Transaction {
                id: None,
                import_id: None,
                date: r.date,
                amount: r.amount,
                description: r.description,
                merchant_key,
                category: if r.is_income { "Доход".to_string() } else { String::new() },
                tx_hash,
                is_income: r.is_income,
            }
        })
        .collect();

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let hashes = db::known_hashes(&conn).map_err(|e| e.to_string())?;
    let sigs = db::known_signatures(&conn).map_err(|e| e.to_string())?;
    drop(conn);

    let total_count = all.len();
    let new_txs = filter_new(all, &hashes, &sigs);
    let new_count = new_txs.len();
    Ok(ParseResult { new_count, total_count, transactions: new_txs })
}

// ─── AI Chat ──────────────────────────────────────────────────────────────────

#[derive(Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

fn ollama_tools() -> serde_json::Value {
    serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "get_data_period",
                "description": "Возвращает реальный диапазон дат транзакций в базе (первая и последняя дата). Вызывай ПЕРВЫМ чтобы узнать за какой период есть данные.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "resolve_period",
                "description": "Превращает словесный период в точные даты from_date/to_date. ВСЕГДА используй этот инструмент вместо самостоятельного вычисления дат. Не считай даты в уме.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "period": {
                            "type": "string",
                            "enum": ["this_month", "last_month", "last_7_days", "last_30_days", "last_90_days", "this_year", "last_year", "last_n_months", "all"],
                            "description": "Словесный период: this_month=текущий месяц, last_month=прошлый месяц, last_7_days/last_30_days/last_90_days=последние N дней, this_year=текущий год, last_year=прошлый год, last_n_months=последние n месяцев (укажи n), all=весь период"
                        },
                        "n": { "type": "integer", "description": "Число месяцев для last_n_months (например 3)" }
                    },
                    "required": ["period"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_spending_summary",
                "description": "Возвращает итого расходов, доходов и количество транзакций за период. Поля: total_expense (сумма расходов), total_income (сумма доходов), net (доход минус расход), days_in_period (точное число дней), daily_avg (среднедневной расход), monthly_projection (готовый прогноз расходов на 30 дней). ИСПОЛЬЗУЙ monthly_projection для оценки месячных расходов — НЕ считай сам. Можно передать category чтобы получить эти же цифры по одной категории.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "from_date": { "type": "string", "description": "Начало периода YYYY-MM-DD" },
                        "to_date":   { "type": "string", "description": "Конец периода YYYY-MM-DD" },
                        "category":  { "type": "string", "description": "Необязательно: название категории для фильтра (например 'Кафе/Рестораны')" }
                    },
                    "required": ["from_date", "to_date"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "compare_periods",
                "description": "Сравнивает расходы за два периода и возвращает готовую разницу. Поля результата: period_a, period_b (полные summary), delta_expense (period_b минус period_a), pct_change (% изменения). Используй когда нужно сравнить 'этот месяц с прошлым' и т.п. НЕ вычисляй разницу сам.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "from_a": { "type": "string", "description": "Начало периода A (более раннего) YYYY-MM-DD" },
                        "to_a":   { "type": "string", "description": "Конец периода A YYYY-MM-DD" },
                        "from_b": { "type": "string", "description": "Начало периода B (более позднего) YYYY-MM-DD" },
                        "to_b":   { "type": "string", "description": "Конец периода B YYYY-MM-DD" },
                        "category": { "type": "string", "description": "Необязательно: категория для сравнения" }
                    },
                    "required": ["from_a", "to_a", "from_b", "to_b"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_category_breakdown",
                "description": "Возвращает расходы по категориям с процентами за период",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "from_date": { "type": "string", "description": "Начало периода YYYY-MM-DD" },
                        "to_date":   { "type": "string", "description": "Конец периода YYYY-MM-DD" }
                    },
                    "required": ["from_date", "to_date"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_monthly_trends",
                "description": "Возвращает помесячную динамику расходов (total_expense) и доходов (total_income) за указанный диапазон дат. Используй даты из get_data_period.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "from_date": { "type": "string", "description": "Начало периода YYYY-MM-DD" },
                        "to_date":   { "type": "string", "description": "Конец периода YYYY-MM-DD" }
                    },
                    "required": ["from_date", "to_date"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "propose_goal",
                "description": "Предложить пользователю создать финансовую цель прямо в чате. Вызывай в двух случаях: (1) пользователь сам упоминает желание накопить или ограничить расходы; (2) анализ бюджета выявил категорию с высокими расходами, где разумное ограничение улучшит финансовое положение — тогда предложи цель сам, объяснив логику. Пользователь увидит карточку с кнопкой подтверждения и сможет принять или отклонить. Вызывай ПОСЛЕ получения данных — чтобы предложить реалистичную, обоснованную цифру, а не случайную.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "goal_type": {
                            "type": "string",
                            "enum": ["limit", "save"],
                            "description": "limit = ограничение расходов по категории, save = цель накопления"
                        },
                        "name": {
                            "type": "string",
                            "description": "Краткое название цели, например 'Лимит на кафе' или 'Накопить на отпуск'"
                        },
                        "category": {
                            "type": "string",
                            "description": "Категория расходов (только для goal_type=limit). Используй точные названия категорий из get_category_breakdown."
                        },
                        "budget": {
                            "type": "number",
                            "description": "Сумма в рублях (лимит расходов или цель накопления)"
                        },
                        "date_from": {
                            "type": "string",
                            "description": "Дата начала цели YYYY-MM-DD"
                        },
                        "date_to": {
                            "type": "string",
                            "description": "Дата окончания цели YYYY-MM-DD"
                        }
                    },
                    "required": ["goal_type", "name", "budget", "date_from", "date_to"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_top_merchants",
                "description": "Возвращает топ мерчантов/магазинов по сумме расходов",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "from_date": { "type": "string", "description": "Начало периода YYYY-MM-DD" },
                        "to_date":   { "type": "string", "description": "Конец периода YYYY-MM-DD" },
                        "limit":     { "type": "integer", "description": "Сколько мерчантов вернуть (по умолчанию 10)" }
                    },
                    "required": ["from_date", "to_date"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_credits_info",
                "description": "Кредиты и кредитные карты пользователя: остатки долга, ставки, ежемесячные платежи, прогноз переплаты, даты погашения, утилизация карт, льготные периоды. Вызывай при вопросах о кредитах, долгах, досрочном погашении, 'что выгоднее гасить или копить'.",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_goals_info",
                "description": "Активные финансовые цели пользователя: лимиты расходов и цели накопления, их бюджеты, текущий прогресс (сколько потрачено/накоплено), сроки. Вызывай при вопросах о целях, накоплениях, планах.",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }
        }
    ])
}

/// Resolve a spoken period ("last_month", "this_year"…) into exact dates.
/// Keeps all date math in Rust so the model never has to compute dates itself.
fn resolve_period_dates(period: &str, n: i64, today: chrono::NaiveDate) -> (String, String, String) {
    use chrono::{Datelike, Duration, Months};
    let fmt = |d: chrono::NaiveDate| d.format("%Y-%m-%d").to_string();
    match period {
        "this_month" => {
            let start = today.with_day(1).unwrap_or(today);
            (fmt(start), fmt(today), "текущий месяц".into())
        }
        "last_month" => {
            let first_this = today.with_day(1).unwrap_or(today);
            let last_end = first_this - Duration::days(1);
            let last_start = last_end.with_day(1).unwrap_or(last_end);
            (fmt(last_start), fmt(last_end), "прошлый месяц".into())
        }
        "last_7_days"  => (fmt(today - Duration::days(6)),  fmt(today), "последние 7 дней".into()),
        "last_30_days" => (fmt(today - Duration::days(29)), fmt(today), "последние 30 дней".into()),
        "last_90_days" => (fmt(today - Duration::days(89)), fmt(today), "последние 90 дней".into()),
        "this_year" => {
            let start = chrono::NaiveDate::from_ymd_opt(today.year(), 1, 1).unwrap_or(today);
            (fmt(start), fmt(today), "текущий год".into())
        }
        "last_year" => {
            let start = chrono::NaiveDate::from_ymd_opt(today.year() - 1, 1, 1).unwrap_or(today);
            let end   = chrono::NaiveDate::from_ymd_opt(today.year() - 1, 12, 31).unwrap_or(today);
            (fmt(start), fmt(end), "прошлый год".into())
        }
        "last_n_months" => {
            let months = n.clamp(1, 120) as u32;
            let start = today.checked_sub_months(Months::new(months)).unwrap_or(today);
            (fmt(start), fmt(today), format!("последние {} мес.", months))
        }
        _ => ("2000-01-01".into(), "2099-12-31".into(), "весь период".into()),
    }
}

fn round1(x: f64) -> f64 { (x * 10.0).round() / 10.0 }

#[derive(Clone, Serialize)]
struct GoalProposal {
    goal_type: String,
    name: String,
    category: Option<String>,
    budget: f64,
    date_from: String,
    date_to: String,
}

/// Human-readable status shown in the chat UI while a given tool runs.
fn tool_status(name: &str) -> &'static str {
    match name {
        "get_data_period"        => "Проверяю доступные данные…",
        "resolve_period"         => "Определяю период…",
        "get_spending_summary"   => "Считаю расходы…",
        "get_category_breakdown" => "Разбираю траты по категориям…",
        "get_top_merchants"      => "Ищу крупнейшие траты…",
        "get_monthly_trends"     => "Смотрю динамику по месяцам…",
        "compare_periods"        => "Сравниваю периоды…",
        "propose_goal"           => "Формирую предложение цели…",
        "get_credits_info"       => "Смотрю кредиты…",
        "get_goals_info"         => "Проверяю цели…",
        _                        => "Анализирую данные…",
    }
}

fn execute_tool(name: &str, args: &serde_json::Value, conn: &rusqlite::Connection, app: &AppHandle) -> String {
    let from = args["from_date"].as_str().unwrap_or("2000-01-01");
    let to   = args["to_date"].as_str().unwrap_or("2099-12-31");
    let category = args["category"].as_str().filter(|s| !s.is_empty());

    match name {
        "get_data_period" => {
            match db::get_data_period(conn) {
                Ok(p) => serde_json::to_string(&p).unwrap_or_default(),
                Err(e) => format!("{{\"error\": \"{}\"}}", e),
            }
        }
        "resolve_period" => {
            let period = args["period"].as_str().unwrap_or("all");
            let n = args["n"].as_i64().unwrap_or(3);
            let today = chrono::Local::now().date_naive();
            let (f, t, label) = resolve_period_dates(period, n, today);
            serde_json::json!({ "from_date": f, "to_date": t, "label": label }).to_string()
        }
        "get_spending_summary" => {
            match db::get_spending_summary(conn, from, to, category) {
                Ok(s) => serde_json::to_string(&s).unwrap_or_default(),
                Err(e) => format!("{{\"error\": \"{}\"}}", e),
            }
        }
        "compare_periods" => {
            let fa = args["from_a"].as_str().unwrap_or(from);
            let ta = args["to_a"].as_str().unwrap_or(to);
            let fb = args["from_b"].as_str().unwrap_or(from);
            let tb = args["to_b"].as_str().unwrap_or(to);
            match (
                db::get_spending_summary(conn, fa, ta, category),
                db::get_spending_summary(conn, fb, tb, category),
            ) {
                (Ok(a), Ok(b)) => {
                    let delta_expense = ((b.total_expense - a.total_expense) * 100.0).round() / 100.0;
                    let pct = if a.total_expense.abs() > 0.001 {
                        round1((b.total_expense - a.total_expense) / a.total_expense * 100.0)
                    } else { 0.0 };
                    serde_json::json!({
                        "period_a": a,
                        "period_b": b,
                        "delta_expense": delta_expense,
                        "pct_change": pct,
                        "note": "delta_expense = period_b.total_expense - period_a.total_expense; положительное = расходы выросли"
                    }).to_string()
                }
                _ => "{\"error\": \"не удалось сравнить периоды\"}".to_string(),
            }
        }
        "get_category_breakdown" => {
            match db::get_category_totals(conn, from, to) {
                Ok(v) => serde_json::to_string(&v).unwrap_or_default(),
                Err(e) => format!("{{\"error\": \"{}\"}}", e),
            }
        }
        "get_monthly_trends" => {
            match db::get_monthly_totals(conn, from, to) {
                Ok(v) => serde_json::to_string(&v).unwrap_or_default(),
                Err(e) => format!("{{\"error\": \"{}\"}}", e),
            }
        }
        "get_top_merchants" => {
            let limit = args["limit"].as_i64().unwrap_or(10);
            match db::get_merchant_totals(conn, from, to, limit) {
                Ok(v) => serde_json::to_string(&v).unwrap_or_default(),
                Err(e) => format!("{{\"error\": \"{}\"}}", e),
            }
        }
        "propose_goal" => {
            let goal_type = args["goal_type"].as_str().unwrap_or("limit").to_string();
            let name_val  = args["name"].as_str().unwrap_or("Новая цель").to_string();
            let category  = args["category"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string());
            let budget    = args["budget"].as_f64().unwrap_or(0.0);
            let date_from = args["date_from"].as_str().unwrap_or("").to_string();
            let date_to   = args["date_to"].as_str().unwrap_or("").to_string();
            let _ = app.emit("chat-goal-proposal", GoalProposal {
                goal_type, name: name_val, category, budget, date_from, date_to,
            });
            // Явно сигнализируем модели что инструмент выполнен и нужно дать финальный ответ,
            // не вызывая больше никаких инструментов.
            "{\"status\": \"proposal_sent\", \"instruction\": \"Карточка с предложением цели показана пользователю. Дай короткий финальный ответ (2-3 предложения) — подтверди что именно предложил и почему. Больше инструменты не вызывай.\"}".to_string()
        }
        "get_credits_info" => {
            match db::get_credits(conn) {
                Ok(credits) => {
                    let statuses: Vec<CreditStatus> = credits
                        .into_iter()
                        .filter(|c| !c.archived)
                        .map(|c| build_credit_status(conn, c))
                        .collect();
                    if statuses.is_empty() {
                        "{\"info\": \"У пользователя нет активных кредитов и карт\"}".to_string()
                    } else {
                        serde_json::to_string(&statuses).unwrap_or_default()
                    }
                }
                Err(e) => format!("{{\"error\": \"{}\"}}", e),
            }
        }
        "get_goals_info" => {
            match db::get_goals(conn) {
                Ok(goals) => {
                    let progress: Vec<serde_json::Value> = goals
                        .iter()
                        .map(|g| {
                            let spent = db::get_goal_spent(conn, g).unwrap_or(0.0);
                            let pct = if g.budget > 0.0 { round1(spent / g.budget * 100.0) } else { 0.0 };
                            serde_json::json!({ "goal": g, "spent": spent, "pct": pct })
                        })
                        .collect();
                    if progress.is_empty() {
                        "{\"info\": \"У пользователя нет активных целей\"}".to_string()
                    } else {
                        serde_json::to_string(&progress).unwrap_or_default()
                    }
                }
                Err(e) => format!("{{\"error\": \"{}\"}}", e),
            }
        }
        _ => format!("{{\"error\": \"unknown tool: {}\"}}", name),
    }
}

/// Fallback context window if we can't read the model's real one via /api/show.
const DEFAULT_CTX: i64 = 8192;
/// Cap for LOCAL models — a huge window blows up KV-cache VRAM on consumer GPUs.
const LOCAL_CTX_CAP: i64 = 8192;
/// Cap for CLOUD models — they run on Ollama's hardware, so we can allow more.
const CLOUD_CTX_CAP: i64 = 32768;

/// Read a model's real context length via /api/show. Ollama reports it under
/// "model_info" as "<arch>.context_length" (e.g. "qwen2.context_length").
async fn fetch_model_ctx(
    client: &reqwest::Client,
    base: &str,
    model: &str,
    auth: &Option<String>,
) -> Option<i64> {
    let url = format!("{}/api/show", base);
    let mut req = client.post(&url).json(&serde_json::json!({ "name": model }));
    if let Some(h) = auth { req = req.header("Authorization", h); }
    let v: serde_json::Value = req.send().await.ok()?.json().await.ok()?;
    let mi = v.get("model_info")?.as_object()?;
    for (k, val) in mi {
        if k.ends_with(".context_length") || k == "context_length" {
            if let Some(n) = val.as_i64() {
                return Some(n);
            }
        }
    }
    None
}

/// Context-window fill reported to the UI after each answer.
#[derive(Serialize, Clone)]
struct ContextUsage {
    used: i64,
    max: i64,
}

/// Mutable state accumulated while reading one streamed round from Ollama.
#[derive(Default)]
struct StreamRound {
    content: String,
    tool_calls: Vec<serde_json::Value>,
    streamed_any: bool,
    error: Option<String>,
    prompt_tokens: i64,
    eval_tokens: i64,
}

#[tauri::command]
pub async fn chat_with_ai(
    messages: Vec<ChatMessage>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let settings = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        db::get_settings(&conn).map_err(|e| e.to_string())?
    };

    let endpoint = settings.endpoint.replace("localhost", "127.0.0.1");
    let url = format!("{}/api/chat", endpoint.trim_end_matches('/'));

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let system_content = format!(
        "Ты финансовый ассистент приложения Buchcard. Сегодня: {}.\n\
         У тебя есть инструменты для чтения данных банковской выписки. Все вычисления делают инструменты — твоя задача выбрать нужный и пересказать результат.\n\
         \n\
         СЕМАНТИКА ДАННЫХ:\n\
         - Все суммы в рублях, положительные числа, уже округлены.\n\
         - total_expense = сумма РАСХОДОВ (потраченные деньги, is_income=false).\n\
         - total_income = сумма ДОХОДОВ (полученные деньги, is_income=true).\n\
         - net = total_income - total_expense. net > 0 значит доходы больше расходов.\n\
         - get_category_breakdown и get_top_merchants возвращают ТОЛЬКО расходы.\n\
         - monthly_projection = готовый прогноз расходов на 30 дней.\n\
         \n\
         ЖЁСТКИЕ ПРАВИЛА (нарушение = ошибка):\n\
         1. НИКОГДА не вычисляй даты в уме. Для любого словесного периода ('этот месяц', 'за год', 'последние 3 месяца') вызови resolve_period и возьми готовые from_date/to_date.\n\
         2. НИКОГДА не считай суммы, разницы, проценты и проекции сам. Бери готовые поля из инструментов. Для сравнения периодов используй compare_periods (в нём есть delta_expense и pct_change).\n\
         3. Первым делом вызови get_data_period чтобы понимать, за какой период вообще есть данные. Если пользователь просит период, где данных нет — честно скажи об этом.\n\
         4. После получения нужных данных сразу давай ответ, без лишних вызовов.\n\
         7. Если анализ показывает категорию с аномально высокими расходами (>30% бюджета или явный пик) — предложи конкретную цель-ограничение через propose_goal. Объясни кратко почему, затем вызови инструмент. Не создавай цели молча — сначала объясни, потом вызывай.\n\
         8. У тебя есть данные о кредитах (get_credits_info: остатки, ставки, платежи, переплата) и целях (get_goals_info: прогресс лимитов и накоплений). При вопросах о долгах, досрочном погашении, 'гасить или копить' — СНАЧАЛА вызови эти инструменты, потом советуй с реальными цифрами.\n\
         5. Отвечай на русском, суммы в ₽. Называй точные цифры и указывай период анализа (days_in_period).\n\
         6. Не путай расходы и доходы.",
        today
    );

    let mut ollama_msgs: Vec<serde_json::Value> = vec![
        serde_json::json!({"role": "system", "content": system_content})
    ];
    for m in &messages {
        ollama_msgs.push(serde_json::json!({"role": m.role, "content": m.content}));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;

    let auth_header: Option<String> = if !settings.api_key.is_empty() {
        Some(format!("Bearer {}", settings.api_key))
    } else {
        None
    };

    // Use the model's REAL context window (capped for VRAM/perf) so the fill %
    // is accurate. Local models are capped low to protect GPU memory; cloud
    // models run remotely so we allow a larger window.
    let base = endpoint.trim_end_matches('/').to_string();
    let is_cloud = !endpoint.contains("127.0.0.1");
    let ctx_cap = if is_cloud { CLOUD_CTX_CAP } else { LOCAL_CTX_CAP };
    let effective_ctx = fetch_model_ctx(&client, &base, &settings.model, &auth_header)
        .await
        .unwrap_or(DEFAULT_CTX)
        .clamp(2048, ctx_cap);

    let emit_err = |e: reqwest::Error| -> String {
        let s = e.to_string();
        if e.is_connect() || s.contains("10054") || s.contains("10061") || s.contains("refused") {
            "⚠️ Ollama не запущен.\nОткройте Настройки и нажмите «Запустить Ollama».".to_string()
        } else {
            format!("Ошибка соединения: {}", s)
        }
    };

    use futures_util::StreamExt;

    let _ = app.emit("chat-status", "Думаю…");

    // Tool-calling loop. Every round streams (stream:true): content tokens are
    // forwarded to the UI in real time, tool_calls are accumulated from the stream.
    for round in 0..8_usize {
        // After 5 rounds of tool calls, nudge model to stop calling tools and answer
        if round == 5 {
            ollama_msgs.push(serde_json::json!({
                "role": "user",
                "content": "У тебя достаточно данных. Дай финальный ответ на основе полученной информации."
            }));
        }

        let body = serde_json::json!({
            "model": settings.model,
            "messages": ollama_msgs,
            "tools": ollama_tools(),
            "stream": true,
            // Ollama defaults num_ctx to ~4096. With the system prompt, 7 tool
            // definitions, prior answers and tool results, a follow-up question
            // easily overflows that and the model returns an empty response.
            // effective_ctx = the model's real window, capped for VRAM/perf.
            "options": { "num_ctx": effective_ctx }
        });

        let mut req = client.post(&url).json(&body);
        if let Some(ref h) = auth_header { req = req.header("Authorization", h); }

        let http_resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                let _ = app.emit("chat-token", emit_err(e));
                let _ = app.emit("chat-done", "");
                return Ok(());
            }
        };

        // Read the newline-delimited JSON stream chunk by chunk.
        // Buffer as raw bytes so multibyte UTF-8 (Cyrillic) is never split.
        let mut stream = http_resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        let mut round = StreamRound::default();

        let handle_line = |line: &str, st: &mut StreamRound| {
            let v: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => return,
            };
            // Ollama reports failures (e.g. context overflow) as a top-level "error".
            if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                st.error = Some(err.to_string());
                return;
            }
            // Final chunk carries token accounting for the whole request.
            if v.get("done").and_then(|d| d.as_bool()) == Some(true) {
                if let Some(pe) = v.get("prompt_eval_count").and_then(|x| x.as_i64()) {
                    st.prompt_tokens = pe;
                }
                if let Some(ec) = v.get("eval_count").and_then(|x| x.as_i64()) {
                    st.eval_tokens = ec;
                }
            }
            let msg = &v["message"];
            if let Some(tc) = msg["tool_calls"].as_array() {
                for t in tc { st.tool_calls.push(t.clone()); }
            }
            if let Some(content) = msg["content"].as_str() {
                if !content.is_empty() {
                    st.content.push_str(content);
                    let _ = app.emit("chat-token", content);
                    st.streamed_any = true;
                }
            }
        };

        while let Some(chunk) = stream.next().await {
            let bytes = match chunk {
                Ok(b) => b,
                Err(e) => {
                    let _ = app.emit("chat-token", emit_err(e));
                    let _ = app.emit("chat-done", "");
                    return Ok(());
                }
            };
            buf.extend_from_slice(&bytes);

            while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]);
                let line = line.trim();
                if line.is_empty() { continue; }
                handle_line(line, &mut round);
            }
        }
        // Trailing line without a final newline
        let leftover = String::from_utf8_lossy(&buf);
        let leftover = leftover.trim();
        if !leftover.is_empty() {
            handle_line(leftover, &mut round);
        }

        // Ollama returned an error mid-stream (e.g. context overflow, paid model).
        if let Some(err) = round.error {
            if round.streamed_any { let _ = app.emit("chat-reset", ""); }
            let el = err.to_lowercase();
            let no_tools = el.contains("does not support tools") || el.contains("support tools");
            let is_paid = el.contains("subscription") || el.contains("upgrade")
                || el.contains("requires a") || el.contains("paid");
            let hint = if no_tools {
                // Model can't do tool calling — useless for this assistant. Hide it.
                let _ = app.emit("chat-model-unavailable", settings.model.clone());
                "\n\nЭта модель не поддерживает инструменты (tool calling), а ассистенту они нужны, \
                 чтобы читать твою выписку. Выбери модель с поддержкой инструментов — например \
                 qwen2.5:14b, qwen3.5 или llama3.1. Модель скрыта из списка автоматически."
            } else if is_paid {
                // Tell the UI which model is paid so it can hide it from the list.
                let _ = app.emit("chat-model-unavailable", settings.model.clone());
                "\n\nЭта модель доступна только по платной подписке Ollama Cloud. \
                 Выберите бесплатную модель в Настройках — платные скрыты из списка автоматически."
            } else if el.contains("context") || el.contains("memory") || el.contains("ctx") {
                " (переполнен контекст — начните новый диалог кнопкой очистки)"
            } else {
                ""
            };
            let _ = app.emit("chat-token", format!("⚠️ {}{}", err, hint));
            let _ = app.emit("chat-done", "");
            return Ok(());
        }

        // No tool calls → this round WAS the final answer, already streamed live.
        if round.tool_calls.is_empty() {
            if !round.streamed_any {
                let _ = app.emit("chat-token", "Не удалось сформировать ответ. Попробуйте ещё раз.");
            }
            // Report context fill so the UI can show it / trigger compaction.
            let used = round.prompt_tokens + round.eval_tokens;
            let _ = app.emit("chat-context", ContextUsage { used, max: effective_ctx });
            let _ = app.emit("chat-done", "");
            return Ok(());
        }

        // Tool calls present. If the model streamed interim "thinking" text before
        // deciding to call a tool, tell the UI to discard it (it isn't the answer).
        if round.streamed_any {
            let _ = app.emit("chat-reset", "");
        }

        // Record the assistant turn (with its tool_calls) into the conversation.
        let StreamRound { content: assistant_content, tool_calls, .. } = round;
        ollama_msgs.push(serde_json::json!({
            "role": "assistant",
            "content": assistant_content,
            "tool_calls": &tool_calls
        }));

        // Execute each tool, surfacing a status for the UI.
        for tc in &tool_calls {
            let fn_obj = &tc["function"];
            let name = fn_obj["name"].as_str().unwrap_or("");
            let _ = app.emit("chat-status", tool_status(name));
            let args = if fn_obj["arguments"].is_string() {
                serde_json::from_str(fn_obj["arguments"].as_str().unwrap_or("{}"))
                    .unwrap_or(serde_json::json!({}))
            } else {
                fn_obj["arguments"].clone()
            };

            let result = {
                let conn = state.0.lock().map_err(|e| e.to_string())?;
                execute_tool(name, &args, &conn, &app)
            };

            ollama_msgs.push(serde_json::json!({
                "role": "tool",
                "content": result
            }));
        }

        // Tools done — model will now generate; show a neutral status until tokens arrive.
        let _ = app.emit("chat-status", "Формулирую ответ…");
    }

    let _ = app.emit("chat-token", "Превышен лимит запросов к инструментам. Попробуйте ещё раз.");
    let _ = app.emit("chat-done", "");
    Ok(())
}

/// Compress an older slice of the conversation into a compact summary so the
/// dialogue can continue without overflowing the context window. One-shot,
/// no tools, no streaming. Called by the UI when context fills up.
#[tauri::command]
pub async fn summarize_conversation(
    messages: Vec<ChatMessage>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let settings = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        db::get_settings(&conn).map_err(|e| e.to_string())?
    };

    let endpoint = settings.endpoint.replace("localhost", "127.0.0.1");
    let url = format!("{}/api/chat", endpoint.trim_end_matches('/'));
    // Summarization must fit the whole older history, so allow a bigger window
    // for cloud models (local stays capped for VRAM).
    let is_cloud = !endpoint.contains("127.0.0.1");
    let sum_ctx = if is_cloud { CLOUD_CTX_CAP } else { LOCAL_CTX_CAP };

    let convo = messages.iter()
        .map(|m| {
            let who = if m.role == "user" { "Пользователь" } else { "Ассистент" };
            format!("{}: {}", who, m.content)
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let prompt = format!(
        "Сожми диалог финансового ассистента ниже в краткую сводку (5-8 предложений). \
         ОБЯЗАТЕЛЬНО сохрани конкретику: заявленные цели накопления (сумма и дата), \
         названные суммы и категории расходов, факты о пользователе (состав семьи, планы), \
         данные из выписки и достигнутые договорённости/рекомендации. \
         Пиши по-русски, от третьего лица, без вступлений и заголовков — только суть.\n\n\
         ДИАЛОГ:\n{}",
        convo
    );

    let body = serde_json::json!({
        "model": settings.model,
        "messages": [{ "role": "user", "content": prompt }],
        "stream": false,
        "options": { "num_ctx": sum_ctx }
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.post(&url).json(&body);
    if !settings.api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", settings.api_key));
    }

    let resp: serde_json::Value = req.send().await
        .map_err(|e| e.to_string())?
        .json().await
        .map_err(|e| e.to_string())?;

    let summary = resp["message"]["content"].as_str().unwrap_or("").trim().to_string();
    if summary.is_empty() {
        return Err("пустая сводка".to_string());
    }
    Ok(summary)
}

// ─── Import Wizard ────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ParseResult {
    pub new_count: usize,
    pub total_count: usize,
    pub transactions: Vec<Transaction>,
}

#[tauri::command]
pub fn parse_file(path: String, state: State<AppState>) -> Result<ParseResult, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let all = parse_xls(Path::new(&path)).map_err(|e| e.to_string())?;
    let total_count = all.len();
    let hashes = db::known_hashes(&conn).map_err(|e| e.to_string())?;
    let sigs = db::known_signatures(&conn).map_err(|e| e.to_string())?;
    let new_txs = filter_new(all, &hashes, &sigs);
    let new_count = new_txs.len();
    Ok(ParseResult { new_count, total_count, transactions: new_txs })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProgressEvent {
    pub merchant_key: String,
    pub category: String,
    pub source: String,
    pub confidence: Option<f64>,
    pub done: usize,
    pub total: usize,
}

#[tauri::command]
pub async fn categorize_transactions(
    transactions: Vec<Transaction>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<CategorizedTx>, String> {
    use std::collections::HashMap;
    use std::sync::Arc;

    let categories: Vec<String> = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        db::get_categories(&conn).map_err(|e| e.to_string())?.into_iter().map(|c| c.name).collect()
    };
    let known_keys = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        db::known_merchant_keys(&conn).map_err(|e| e.to_string())?
    };
    let settings = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        db::get_settings(&conn).map_err(|e| e.to_string())?
    };

    let total = transactions.len();
    let mut results: Vec<Option<CategorizedTx>> = vec![None; total];
    // mk → (sample tx for description, all indices sharing this mk)
    let mut llm_queue: HashMap<String, (Transaction, Vec<usize>)> = HashMap::new();
    let mut merchant_index = MerchantIndex::new(known_keys);

    // ── Pass 1: keyword / MCC / cache — sequential, no network ───────────────
    for (i, tx) in transactions.iter().enumerate() {
        if tx.is_income {
            results[i] = Some(CategorizedTx {
                tx: tx.clone(), source: "keyword".to_string(),
                confidence: Some(1.0), reasoning: None,
            });
            continue;
        }
        let mk = merchant_index.resolve(&tx.merchant_key);

        if let Some(cat) = crate::categorizer::keyword_match(&mk, &tx.description) {
            {
                let conn = state.0.lock().map_err(|e| e.to_string())?;
                db::upsert_merchant(&conn, &MerchantCache {
                    merchant_key: mk.clone(), category: cat.clone(),
                    source: "keyword".to_string(), confidence: Some(1.0),
                    reasoning: Some("keyword match".to_string()),
                }).ok();
            }
            results[i] = Some(CategorizedTx {
                tx: Transaction { merchant_key: mk, category: cat, ..tx.clone() },
                source: "keyword".to_string(), confidence: Some(1.0),
                reasoning: Some("keyword match".to_string()),
            });
        } else if let Some(cat) = crate::categorizer::mcc_match(&tx.description) {
            {
                let conn = state.0.lock().map_err(|e| e.to_string())?;
                db::upsert_merchant(&conn, &MerchantCache {
                    merchant_key: mk.clone(), category: cat.clone(),
                    source: "mcc".to_string(), confidence: Some(0.95), reasoning: None,
                }).ok();
            }
            results[i] = Some(CategorizedTx {
                tx: Transaction { merchant_key: mk, category: cat, ..tx.clone() },
                source: "mcc".to_string(), confidence: Some(0.95), reasoning: None,
            });
        } else {
            let cached = {
                let conn = state.0.lock().map_err(|e| e.to_string())?;
                db::cache_lookup(&conn, &mk).map_err(|e| e.to_string())?
            };
            if let Some(c) = cached {
                results[i] = Some(CategorizedTx {
                    tx: Transaction { merchant_key: mk, category: c.category.clone(), ..tx.clone() },
                    source: c.source, confidence: c.confidence, reasoning: c.reasoning,
                });
            } else {
                // Queue for LLM — deduplicated: one LLM call per unique merchant_key
                let entry = llm_queue.entry(mk.clone()).or_insert_with(|| (tx.clone(), vec![]));
                entry.1.push(i);
            }
        }
    }

    let p1_done = results.iter().filter(|r| r.is_some()).count();
    let _ = app.emit("categorize-progress", ProgressEvent {
        merchant_key: String::new(), category: String::new(),
        source: "cache".to_string(), confidence: None,
        done: p1_done, total,
    });

    // ── Pass 2: parallel LLM, max 4 concurrent, 1 call per unique merchant ───
    if !llm_queue.is_empty() {
        let sem  = Arc::new(tokio::sync::Semaphore::new(4));
        let cats = Arc::new(categories);
        let ep   = Arc::new(settings.endpoint);
        let ak   = Arc::new(settings.api_key);
        let md   = Arc::new(settings.model);

        let mut join_set: tokio::task::JoinSet<(
            String, Transaction, Vec<usize>,
            anyhow::Result<crate::categorizer::OllamaLlmResponse>,
        )> = tokio::task::JoinSet::new();

        let llm_total = llm_queue.len();
        for (mk, (tx, indices)) in llm_queue {
            let sem  = sem.clone();
            let cats = cats.clone();
            let ep   = ep.clone();
            let ak   = ak.clone();
            let md   = md.clone();
            let desc = tx.description.clone();
            let mk2  = mk.clone();
            join_set.spawn(async move {
                let _permit = sem.acquire_owned().await.unwrap();
                let result = crate::categorizer::llm_classify_async(
                    &desc, &mk2, &cats, &ep, &ak, &md,
                ).await;
                (mk2, tx, indices, result)
            });
        }

        let mut llm_done = 0_usize;

        while let Some(join_result) = join_set.join_next().await {
            let (mk, tx, indices, llm_result) = join_result.map_err(|e| e.to_string())?;
            llm_done += 1;

            let (category, confidence, reasoning) = match llm_result {
                Ok(r) => {
                    let cat = if cats.contains(&r.category) { r.category } else { "Прочее".to_string() };
                    (cat, Some(r.confidence), Some(r.reasoning))
                }
                Err(e) => {
                    eprintln!("[LLM] error for {mk}: {e}");
                    ("Прочее".to_string(), Some(0.0), Some("ошибка классификации".to_string()))
                }
            };

            {
                let conn = state.0.lock().map_err(|e| e.to_string())?;
                db::upsert_merchant(&conn, &MerchantCache {
                    merchant_key: mk.clone(), category: category.clone(),
                    source: "llm".to_string(), confidence, reasoning: reasoning.clone(),
                }).ok();
            }

            for &i in &indices {
                results[i] = Some(CategorizedTx {
                    tx: Transaction { merchant_key: mk.clone(), category: category.clone(), ..tx.clone() },
                    source: "llm".to_string(), confidence, reasoning: reasoning.clone(),
                });
            }

            let _ = app.emit("categorize-progress", ProgressEvent {
                merchant_key: mk.clone(), category: category.clone(),
                source: "llm".to_string(), confidence,
                done: p1_done + llm_done,
                total: p1_done + llm_total,
            });
        } // while join_set
    }

    let _ = app.emit("categorize-progress", ProgressEvent {
        merchant_key: String::new(), category: String::new(),
        source: "done".to_string(), confidence: None, done: total, total,
    });

    let final_results = results.into_iter().enumerate().map(|(i, r)| {
        r.unwrap_or_else(|| CategorizedTx {
            tx: transactions[i].clone(),
            source: "error".to_string(), confidence: Some(0.0), reasoning: None,
        })
    }).collect();

    Ok(final_results)
}

#[derive(Deserialize)]
pub struct ApprovedTx {
    pub tx: Transaction,
    pub source: String,
    pub _confidence: Option<f64>,
    pub _reasoning: Option<String>,
}

#[tauri::command]
pub fn commit_import(
    filename: String,
    approved: Vec<ApprovedTx>,
    balance: Option<f64>,
    kopilka_id: Option<i64>,
    state: State<AppState>,
) -> Result<usize, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let txs: Vec<Transaction> = approved.iter().map(|a| a.tx.clone()).collect();

    let dates: Vec<&str> = txs.iter().map(|t| t.date.as_str()).collect();
    let period_from = dates.iter().min().copied().unwrap_or("");
    let period_to = dates.iter().max().copied().unwrap_or("");

    for a in &approved {
        if a.source == "user" {
            db::upsert_merchant(&conn, &db::MerchantCache {
                merchant_key: a.tx.merchant_key.clone(),
                category: a.tx.category.clone(),
                source: "user".to_string(),
                confidence: None,
                reasoning: None,
            }).ok();
        }
    }

    let import_id = db::create_import(&conn, &filename, period_from, period_to, balance, kopilka_id)
        .map_err(|e| e.to_string())?;
    db::commit_transactions(&conn, import_id, &txs).map_err(|e| e.to_string())
}

// ─── Goals ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_goals_with_progress(state: State<AppState>) -> Result<Vec<db::GoalProgress>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let goals = db::get_goals(&conn).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for goal in goals {
        let spent = db::get_goal_spent(&conn, &goal).map_err(|e| e.to_string())?;
        let pct = if goal.budget > 0.0 { spent / goal.budget * 100.0 } else { 0.0 };
        result.push(db::GoalProgress { goal, spent, pct });
    }
    Ok(result)
}

#[tauri::command]
pub fn create_goal(
    name: String,
    goal_type: String,
    category: String,
    budget: f64,
    date_from: String,
    date_to: String,
    kopilka_id: Option<i64>,
    manual_spent: Option<f64>,
    state: State<AppState>,
) -> Result<i64, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::create_goal(&conn, &name, &goal_type, &category, budget, &date_from, &date_to, kopilka_id, manual_spent)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_goal(id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::delete_goal(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_goal(
    id: i64,
    name: String,
    goal_type: String,
    category: String,
    budget: f64,
    date_from: String,
    date_to: String,
    kopilka_id: Option<i64>,
    manual_spent: Option<f64>,
    state: State<AppState>,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::update_goal(&conn, id, &name, &goal_type, &category, budget, &date_from, &date_to, kopilka_id, manual_spent)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_kopilkas(state: State<AppState>) -> Result<Vec<db::Kopilka>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::get_kopilkas(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_kopilka(name: String, initial_alias: String, state: State<AppState>) -> Result<i64, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::create_kopilka(&conn, &name, &initial_alias).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_kopilka_alias(kopilka_id: i64, alias: String, state: State<AppState>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::add_kopilka_alias(&conn, kopilka_id, &alias).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn find_unmatched_kopilka_descriptions(state: State<AppState>) -> Result<Vec<(String, i64, f64)>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::find_unmatched_kopilka_descriptions(&conn).map_err(|e| e.to_string())
}

// ─── Credits ────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct CreditStatus {
    pub credit: db::Credit,
    pub progress_pct: f64,
    pub paid_principal: f64,
    pub paid_interest: f64,
    // loan
    pub next_payment_amount: Option<f64>,
    pub next_payment_date: Option<String>,
    pub payoff_date: Option<String>,
    pub months_left: Option<i64>,
    pub interest_left: Option<f64>,
    // card
    pub available: Option<f64>,
    pub utilization_pct: Option<f64>,
    pub min_payment: Option<f64>,
    pub grace_until: Option<String>,
    pub grace_days_left: Option<i64>,
}

fn today_str() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn build_credit_status(conn: &rusqlite::Connection, credit: db::Credit) -> CreditStatus {
    let today = today_str();
    let payments = db::get_credit_payments(conn, credit.id).unwrap_or_default();
    let paid_interest: f64 = payments.iter().map(|p| p.interest_part).sum();
    let paid_principal: f64 = payments
        .iter()
        .filter(|p| p.kind == "payment")
        .map(|p| p.principal_part)
        .sum();

    if credit.kind == "card" {
        let limit = credit.principal;
        let debt = credit.current_balance;
        let available = (limit - debt).max(0.0);
        let utilization = if limit > 0.0 { debt / limit * 100.0 } else { 0.0 };
        let min_payment = credit
            .min_payment_pct
            .map(|pct| (debt * pct / 100.0).max(0.0));
        let (grace_until, grace_days_left) = match (credit.statement_day, credit.grace_days) {
            (Some(sd), Some(gd)) => crate::credit::grace_status(&today, sd, gd),
            _ => (None, None),
        };
        CreditStatus {
            credit,
            progress_pct: utilization,
            paid_principal,
            paid_interest,
            next_payment_amount: None,
            next_payment_date: None,
            payoff_date: None,
            months_left: None,
            interest_left: None,
            available: Some(available),
            utilization_pct: Some(utilization),
            min_payment,
            grace_until,
            grace_days_left,
        }
    } else {
        // loan
        let balance = credit.current_balance;
        let scheduled = credit.scheduled_payment.unwrap_or_else(|| {
            crate::credit::annuity_payment(balance, credit.rate_annual, credit.term_months.unwrap_or(0))
        });
        let proj = crate::credit::payoff_projection(
            balance,
            credit.rate_annual,
            scheduled,
            &today,
            credit.payment_day,
        );
        let interest_this = balance * crate::credit::monthly_rate(credit.rate_annual);
        let next_amount = scheduled.min(balance + interest_this).max(0.0);
        let next_date = credit
            .payment_day
            .and_then(|d| crate::credit::next_payment_date(&today, d));
        let progress = if credit.principal > 0.0 {
            ((credit.principal - balance) / credit.principal * 100.0).clamp(0.0, 100.0)
        } else {
            0.0
        };
        CreditStatus {
            credit,
            progress_pct: progress,
            paid_principal,
            paid_interest,
            next_payment_amount: Some(next_amount),
            next_payment_date: next_date,
            payoff_date: proj.payoff_date,
            months_left: Some(proj.months),
            interest_left: proj.total_interest.is_finite().then_some(proj.total_interest),
            available: None,
            utilization_pct: None,
            min_payment: None,
            grace_until: None,
            grace_days_left: None,
        }
    }
}

#[tauri::command]
pub fn get_credits(state: State<AppState>) -> Result<Vec<CreditStatus>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let credits = db::get_credits(&conn).map_err(|e| e.to_string())?;
    Ok(credits.into_iter().map(|c| build_credit_status(&conn, c)).collect())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_credit(
    name: String,
    kind: String,
    bank: String,
    principal: f64,
    current_balance: f64,
    rate_annual: f64,
    term_months: Option<i64>,
    monthly_payment: Option<f64>,
    payment_day: Option<i64>,
    start_date: String,
    grace_days: Option<i64>,
    statement_day: Option<i64>,
    min_payment_pct: Option<f64>,
    state: State<AppState>,
) -> Result<i64, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    // Плановый платёж: введённый пользователем (в банке он может быть выше из-за
    // страховок/фактических дней), иначе — расчётный аннуитет от остатка.
    let scheduled_payment = if kind == "loan" {
        monthly_payment
            .filter(|v| *v > 0.0)
            .or_else(|| term_months.map(|n| crate::credit::annuity_payment(current_balance, rate_annual, n)))
    } else {
        None
    };
    db::create_credit(
        &conn, &name, &kind, &bank, principal, current_balance, rate_annual, term_months,
        scheduled_payment, payment_day, &start_date, grace_days, statement_day, min_payment_pct,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_credit(
    id: i64,
    name: String,
    bank: String,
    principal: f64,
    current_balance: f64,
    rate_annual: f64,
    term_months: Option<i64>,
    monthly_payment: Option<f64>,
    payment_day: Option<i64>,
    start_date: String,
    grace_days: Option<i64>,
    statement_day: Option<i64>,
    min_payment_pct: Option<f64>,
    state: State<AppState>,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    // Введённый платёж приоритетнее расчётного аннуитета.
    let existing = db::get_credit(&conn, id).map_err(|e| e.to_string())?;
    let scheduled_payment = match existing {
        Some(c) if c.kind == "loan" => {
            monthly_payment
                .filter(|v| *v > 0.0)
                .or_else(|| term_months.map(|n| crate::credit::annuity_payment(current_balance, rate_annual, n)))
        }
        _ => None,
    };
    db::update_credit(
        &conn, id, &name, &bank, principal, current_balance, rate_annual, term_months,
        scheduled_payment, payment_day, &start_date, grace_days, statement_day, min_payment_pct,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_credit(id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::delete_credit(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn archive_credit(id: i64, archived: bool, state: State<AppState>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::set_credit_archived(&conn, id, archived).map_err(|e| e.to_string())
}

/// Записать операцию по кредиту/карте.
/// kind: 'payment' (внести платёж), 'charge' (трата по карте).
/// prepay_mode (для кредита при переплате): 'reduce_term' | 'reduce_payment'.
#[tauri::command]
pub fn add_credit_payment(
    credit_id: i64,
    date: String,
    amount: f64,
    kind: String,
    prepay_mode: Option<String>,
    note: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let credit = db::get_credit(&conn, credit_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Кредит не найден".to_string())?;
    let note = note.unwrap_or_default();

    if credit.kind == "card" {
        // Карта: charge увеличивает долг, payment уменьшает.
        let new_balance = if kind == "charge" {
            credit.current_balance + amount.abs()
        } else {
            (credit.current_balance - amount.abs()).max(0.0)
        };
        db::add_credit_payment(
            &conn, credit_id, &date, amount.abs(), 0.0, 0.0, &kind, new_balance, None, &note,
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Кредит: разбивка на проценты/тело.
    let (interest, principal) =
        crate::credit::split_payment(credit.current_balance, credit.rate_annual, amount);
    if principal <= 0.0 {
        return Err("Платёж не покрывает проценты — тело не гасится. Увеличьте сумму.".into());
    }
    let new_balance = (credit.current_balance - principal).max(0.0);

    // Досрочка «уменьшить платёж»: пересчитать аннуитет на остаток за прежний срок.
    let new_scheduled = match (prepay_mode.as_deref(), credit.scheduled_payment) {
        (Some("reduce_payment"), Some(old_sched)) if amount > old_sched + 0.01 && new_balance > 0.0 => {
            let today = today_str();
            let n_before = crate::credit::payoff_projection(
                credit.current_balance, credit.rate_annual, old_sched, &today, credit.payment_day,
            ).months;
            if n_before > 0 {
                Some(crate::credit::annuity_payment(new_balance, credit.rate_annual, n_before))
            } else {
                None
            }
        }
        _ => None, // 'reduce_term' и обычный платёж: плановый платёж не меняем
    };

    db::add_credit_payment(
        &conn, credit_id, &date, amount, interest, principal, "payment", new_balance, new_scheduled, &note,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_credit_payments(credit_id: i64, state: State<AppState>) -> Result<Vec<db::CreditPayment>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::get_credit_payments(&conn, credit_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_credit_schedule(credit_id: i64, state: State<AppState>) -> Result<Vec<crate::credit::ScheduleRow>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let credit = db::get_credit(&conn, credit_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Кредит не найден".to_string())?;
    if credit.kind != "loan" {
        return Ok(vec![]);
    }
    let scheduled = credit.scheduled_payment.unwrap_or_else(|| {
        crate::credit::annuity_payment(credit.current_balance, credit.rate_annual, credit.term_months.unwrap_or(0))
    });
    Ok(crate::credit::schedule(
        credit.current_balance,
        credit.rate_annual,
        scheduled,
        &today_str(),
        credit.payment_day,
    ))
}

// ─── Net Worth / Analytics ──────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct NetWorthParts {
    pub kopilka_total: f64,
    pub credit_debt: f64,
}

#[tauri::command]
pub fn get_net_worth_parts(state: State<AppState>) -> Result<NetWorthParts, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let kopilka_total = db::get_kopilka_saved_total(&conn).map_err(|e| e.to_string())?;
    let credit_debt: f64 = db::get_credits(&conn)
        .map_err(|e| e.to_string())?
        .iter()
        .filter(|c| !c.archived)
        .map(|c| c.current_balance)
        .sum();
    Ok(NetWorthParts { kopilka_total, credit_debt })
}

#[derive(Debug, Serialize)]
pub struct MonthCompareRow {
    pub category: String,
    pub current: f64,
    pub previous: f64,
    pub delta: f64,
    pub pct: Option<f64>, // None если previous == 0
}

#[derive(Debug, Serialize)]
pub struct MonthComparison {
    pub current_label: String,
    pub previous_label: String,
    pub total_current: f64,
    pub total_previous: f64,
    pub rows: Vec<MonthCompareRow>,
    pub has_previous: bool,
}

#[tauri::command]
pub fn get_month_comparison(state: State<AppState>) -> Result<MonthComparison, String> {
    use chrono::Datelike;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let today = chrono::Local::now().date_naive();
    let cur_from = today.with_day(1).unwrap();
    let prev_to = cur_from.pred_opt().unwrap();
    let prev_from = prev_to.with_day(1).unwrap();

    let fmt = |d: chrono::NaiveDate| d.format("%Y-%m-%d").to_string();
    let cur = db::get_category_totals(&conn, &fmt(cur_from), &fmt(today)).map_err(|e| e.to_string())?;
    let prev = db::get_category_totals(&conn, &fmt(prev_from), &fmt(prev_to)).map_err(|e| e.to_string())?;

    let months_ru = ["январь","февраль","март","апрель","май","июнь","июль","август","сентябрь","октябрь","ноябрь","декабрь"];
    let prev_map: std::collections::HashMap<String, f64> =
        prev.iter().map(|c| (c.category.clone(), c.total)).collect();
    let cur_map: std::collections::HashMap<String, f64> =
        cur.iter().map(|c| (c.category.clone(), c.total)).collect();

    // Объединить категории обоих месяцев
    let mut names: Vec<String> = cur_map.keys().chain(prev_map.keys()).cloned().collect();
    names.sort();
    names.dedup();

    // Не сравнивать доход и снятые с учёта категории (переводы, копилка)
    let excluded: std::collections::HashSet<String> = db::get_categories(&conn)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|c| c.excluded)
        .map(|c| c.name)
        .collect();

    let mut rows: Vec<MonthCompareRow> = names.into_iter()
        .filter(|n| n != "Доход" && !excluded.contains(n))
        .map(|name| {
            let c = *cur_map.get(&name).unwrap_or(&0.0);
            let p = *prev_map.get(&name).unwrap_or(&0.0);
            let pct = if p.abs() > 0.001 { Some(((c - p) / p * 100.0 * 10.0).round() / 10.0) } else { None };
            MonthCompareRow { category: name, current: c, previous: p, delta: c - p, pct }
        })
        .collect();
    rows.sort_by(|a, b| b.delta.abs().partial_cmp(&a.delta.abs()).unwrap_or(std::cmp::Ordering::Equal));

    let total_current: f64 = rows.iter().map(|r| r.current).sum();
    let total_previous: f64 = rows.iter().map(|r| r.previous).sum();

    Ok(MonthComparison {
        current_label: months_ru[cur_from.month0() as usize].to_string(),
        previous_label: months_ru[prev_from.month0() as usize].to_string(),
        total_current,
        total_previous,
        has_previous: total_previous > 0.001,
        rows,
    })
}

// ─── Planned items ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_planned_items(state: State<AppState>) -> Result<Vec<db::PlannedItem>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::get_planned_items(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_planned_item(name: String, amount: f64, date: String, kind: String, state: State<AppState>) -> Result<i64, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::create_planned_item(&conn, &name, amount, &date, &kind).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_planned_item(id: i64, name: String, amount: f64, date: String, kind: String, state: State<AppState>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::update_planned_item(&conn, id, &name, amount, &date, &kind).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_planned_item(id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::delete_planned_item(&conn, id).map_err(|e| e.to_string())
}

// ─── Cash-flow forecast ─────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ForecastPoint {
    pub date: String,
    pub balance: f64,
    pub event: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CashForecast {
    pub points: Vec<ForecastPoint>,
    pub min_balance: f64,
    pub min_date: String,
    pub has_gap: bool,
    pub daily_avg: f64,
}

/// Прогноз баланса на N дней вперёд. Баланс передаёт фронт (якорная логика там):
/// доходы — аванс/зарплата из настроек, расходы — платежи по кредитам + средний быт.
#[tauri::command]
pub fn get_cash_forecast(
    current_balance: f64,
    days: Option<i64>,
    state: State<AppState>,
) -> Result<CashForecast, String> {
    use chrono::{Datelike, Duration};
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let days = days.unwrap_or(30).clamp(7, 365);
    let today = chrono::Local::now().date_naive();

    let settings = db::get_settings(&conn).map_err(|e| e.to_string())?;

    // Плановые платежи по активным кредитам (сумма + день месяца)
    let loan_payments: Vec<(String, i64, f64)> = db::get_credits(&conn)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|c| !c.archived && c.kind == "loan" && c.current_balance > 0.005)
        .filter_map(|c| {
            let day = c.payment_day?;
            let status = build_credit_status(&conn, c.clone());
            let amount = status.next_payment_amount?;
            (amount > 0.0).then(|| (c.name, day, amount))
        })
        .collect();

    // Средний дневной расход за последние 7 дней (скользящее окно — пользователь
    // корректирует траты, месячное среднее слишком инертно).
    // Жёстко исключаем из быта, НЕЗАВИСИМО от тумблера категорий:
    //  - «Переводы» и «Копилка/Сбережения» — там взаимозачёты и внутренние движения;
    //  - транзакции накопительных счетов (kopilka-импорты);
    //  - транзакции, уже записанные как платежи по кредитам (платежи в прогнозе
    //    учитываются отдельными событиями из модуля кредитов — по введённым там
    //    суммам и датам, а не из выписки).
    const AVG_WINDOW_DAYS: i64 = 7;
    let from_avg = (today - Duration::days(AVG_WINDOW_DAYS)).format("%Y-%m-%d").to_string();
    let today_s = today.format("%Y-%m-%d").to_string();
    let spent_week: f64 = conn.query_row(
        "SELECT COALESCE(SUM(t.amount), 0)
         FROM transactions t
         LEFT JOIN imports i ON t.import_id = i.id
         LEFT JOIN categories c ON t.category = c.name
         WHERE t.is_income = 0
           AND t.date >= ?1 AND t.date <= ?2
           AND i.kopilka_id IS NULL
           AND COALESCE(c.excluded, 0) = 0
           AND t.category NOT IN ('Переводы', 'Копилка/Сбережения')
           AND NOT EXISTS (
               SELECT 1 FROM credit_payments cp
               WHERE cp.date = t.date AND ABS(cp.amount - t.amount) < 0.01
           )",
        rusqlite::params![from_avg, today_s],
        |r| r.get(0),
    ).unwrap_or(0.0);
    let daily_avg = spent_week / AVG_WINDOW_DAYS as f64;

    // Запланированные разовые события (отпуск, покупки, ожидаемые доходы).
    // Прошедшие даты игнорируем — они уже отражены в выписке.
    let planned: Vec<db::PlannedItem> = db::get_planned_items(&conn)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|p| p.date.as_str() > today_s.as_str())
        .collect();

    let mut balance = current_balance;
    let mut points: Vec<ForecastPoint> = Vec::with_capacity(days as usize);
    let mut min_balance = balance;
    let mut min_date = today_s.clone();

    for i in 1..=days {
        let d = today + Duration::days(i);
        let dom = d.day() as i64;
        let last_dom = {
            // клип дня платежа к последнему дню месяца (31-е в июне → 30-е)
            let (ny, nm) = if d.month() == 12 { (d.year() + 1, 1) } else { (d.year(), d.month() + 1) };
            chrono::NaiveDate::from_ymd_opt(ny, nm, 1).unwrap().pred_opt().unwrap().day() as i64
        };
        let hits = |day: i64| -> bool { dom == day.min(last_dom) };

        let mut events: Vec<String> = Vec::new();

        if let (Some(day), Some(amount)) = (settings.advance_day, settings.advance_amount) {
            if amount > 0.0 && hits(day as i64) {
                balance += amount;
                events.push("Аванс".to_string());
            }
        }
        if let (Some(day), Some(amount)) = (settings.salary_day, settings.salary_amount) {
            if amount > 0.0 && hits(day as i64) {
                balance += amount;
                events.push("Зарплата".to_string());
            }
        }
        for (name, day, amount) in &loan_payments {
            if hits(*day) {
                balance -= amount;
                events.push(format!("Платёж: {}", name));
            }
        }

        let date_key = d.format("%Y-%m-%d").to_string();
        for p in planned.iter().filter(|p| p.date == date_key) {
            if p.kind == "income" {
                balance += p.amount;
                events.push(p.name.clone());
            } else {
                balance -= p.amount;
                events.push(format!("План: {}", p.name));
            }
        }

        balance -= daily_avg;

        let date_s = d.format("%Y-%m-%d").to_string();
        if balance < min_balance {
            min_balance = balance;
            min_date = date_s.clone();
        }
        points.push(ForecastPoint {
            date: date_s,
            balance: (balance * 100.0).round() / 100.0,
            event: (!events.is_empty()).then(|| events.join(" · ")),
        });
    }

    Ok(CashForecast {
        points,
        min_balance: (min_balance * 100.0).round() / 100.0,
        min_date,
        has_gap: min_balance < 0.0,
        daily_avg: (daily_avg * 100.0).round() / 100.0,
    })
}

// ─── Reminders ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct Reminder {
    pub kind: String,   // 'loan_payment' | 'grace_expiry'
    pub title: String,
    pub body: String,
    pub key: String,    // стабильный ключ для анти-спама на фронте
}

#[tauri::command]
pub fn find_credit_payment_candidates(state: State<AppState>) -> Result<Vec<db::CreditPaymentCandidate>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::find_credit_payment_candidates(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_due_reminders(state: State<AppState>) -> Result<Vec<Reminder>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let today = today_str();
    let mut reminders = Vec::new();

    for credit in db::get_credits(&conn).map_err(|e| e.to_string())? {
        if credit.archived { continue; }

        if credit.kind == "loan" {
            let Some(day) = credit.payment_day else { continue };
            let Some(next) = crate::credit::next_payment_date(&today, day) else { continue };
            let days_until = (chrono::NaiveDate::parse_from_str(&next, "%Y-%m-%d").unwrap()
                - chrono::NaiveDate::parse_from_str(&today, "%Y-%m-%d").unwrap()).num_days();
            if days_until <= 1 {
                let status = build_credit_status(&conn, credit.clone());
                let amount = status.next_payment_amount.unwrap_or(0.0);
                let when = if days_until == 0 { "Сегодня" } else { "Завтра" };
                reminders.push(Reminder {
                    kind: "loan_payment".into(),
                    title: format!("{} платёж по кредиту", when),
                    body: format!("{} — {:.0} ₽", credit.name, amount),
                    key: format!("loan-{}-{}", credit.id, next),
                });
            }
        } else if let (Some(sd), Some(gd)) = (credit.statement_day, credit.grace_days) {
            if credit.current_balance <= 0.005 { continue; }
            let (until, days_left) = crate::credit::grace_status(&today, sd, gd);
            if let (Some(until), Some(days_left)) = (until, days_left) {
                if (0..=3).contains(&days_left) {
                    reminders.push(Reminder {
                        kind: "grace_expiry".into(),
                        title: "Льготный период истекает".into(),
                        body: format!(
                            "{}: осталось {} дн., долг {:.0} ₽",
                            credit.name, days_left, credit.current_balance
                        ),
                        key: format!("grace-{}-{}", credit.id, until),
                    });
                }
            }
        }
    }
    Ok(reminders)
}
