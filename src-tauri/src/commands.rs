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

// TCP ping to check if Ollama port is open — uses explicit 127.0.0.1 to avoid
// IPv6 resolution of "localhost" when Ollama only binds to IPv4
#[tauri::command]
pub async fn ping_ollama(endpoint: String) -> bool {
    let port: u16 = endpoint
        .trim_end_matches('/')
        .rsplit(':')
        .next()
        .and_then(|p| p.parse().ok())
        .unwrap_or(11434);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::net::TcpStream::connect(addr),
    ).await.map(|r| r.is_ok()).unwrap_or(false)
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
    drop(conn);

    let total_count = all.len();
    let new_txs = filter_new(all, &hashes);
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
                "name": "get_spending_summary",
                "description": "Возвращает итого расходов, доходов и количество транзакций за указанный период. Поля: total_expense (сумма расходов), days_in_period (точное количество дней в периоде), daily_avg (среднедневной расход), monthly_projection (прогноз расходов на 30 дней на основе daily_avg). ИСПОЛЬЗУЙ monthly_projection для оценки месячных расходов — не считай самостоятельно.",
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
                "description": "Возвращает динамику расходов и доходов по месяцам",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "months": { "type": "integer", "description": "Количество месяцев назад (например 6)" }
                    },
                    "required": ["months"]
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
        }
    ])
}

fn execute_tool(name: &str, args: &serde_json::Value, conn: &rusqlite::Connection) -> String {
    let from = args["from_date"].as_str().unwrap_or("2000-01-01");
    let to   = args["to_date"].as_str().unwrap_or("2099-12-31");

    match name {
        "get_data_period" => {
            match db::get_data_period(conn) {
                Ok(p) => serde_json::to_string(&p).unwrap_or_default(),
                Err(e) => format!("{{\"error\": \"{}\"}}", e),
            }
        }
        "get_spending_summary" => {
            match db::get_spending_summary(conn, from, to) {
                Ok(s) => serde_json::to_string(&s).unwrap_or_default(),
                Err(e) => format!("{{\"error\": \"{}\"}}", e),
            }
        }
        "get_category_breakdown" => {
            match db::get_category_totals(conn, from, to) {
                Ok(v) => serde_json::to_string(&v).unwrap_or_default(),
                Err(e) => format!("{{\"error\": \"{}\"}}", e),
            }
        }
        "get_monthly_trends" => {
            let months = args["months"].as_i64().unwrap_or(6);
            match db::get_monthly_totals(conn, months) {
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
        _ => format!("{{\"error\": \"unknown tool: {}\"}}", name),
    }
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
         У тебя есть инструменты для чтения данных банковской выписки пользователя.\n\
         Правила:\n\
         1. ВСЕГДА начинай с вызова get_data_period — он покажет реальный период данных в базе.\n\
         2. Используй только даты из этого реального периода в последующих запросах.\n\
         3. После получения нужных данных — сразу давай конкретный ответ, не вызывай лишних инструментов.\n\
         4. Отвечай на русском языке. Суммы в рублях (₽).\n\
         5. Будь конкретен: называй точные цифры из данных.\n\
         6. ВАЖНО для оценки месячных расходов: используй поле monthly_projection из get_spending_summary — это готовый прогноз на месяц. НЕ вычисляй его самостоятельно.\n\
         7. Всегда указывай точное количество дней анализа (поле days_in_period) чтобы пользователь понимал на каком периоде основана оценка.",
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

    let emit_err = |e: reqwest::Error| -> String {
        let s = e.to_string();
        if e.is_connect() || s.contains("10054") || s.contains("10061") || s.contains("refused") {
            "⚠️ Ollama не запущен.\nОткройте Настройки и нажмите «Запустить Ollama».".to_string()
        } else {
            format!("Ошибка соединения: {}", s)
        }
    };

    // Tool-calling loop — one call per round, stream: false to inspect tool_calls
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
            "stream": false
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

        let resp: serde_json::Value = match http_resp.json().await {
            Ok(v) => v,
            Err(e) => {
                let _ = app.emit("chat-token", format!("Ошибка разбора ответа: {}", e));
                let _ = app.emit("chat-done", "");
                return Ok(());
            }
        };

        let msg = &resp["message"];
        let has_tool_calls = msg["tool_calls"].as_array()
            .map(|a| !a.is_empty())
            .unwrap_or(false);

        if !has_tool_calls {
            // Final answer — emit word by word for natural feel
            let text = msg["content"].as_str().unwrap_or("").to_string();
            if text.is_empty() {
                let _ = app.emit("chat-token", "Не удалось сформировать ответ. Попробуйте ещё раз.");
            } else {
                for word in text.split_inclusive(' ') {
                    let _ = app.emit("chat-token", word);
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            }
            let _ = app.emit("chat-done", "");
            return Ok(());
        }

        // Process tool calls
        let tool_calls = msg["tool_calls"].as_array().unwrap().to_vec();
        ollama_msgs.push(serde_json::json!({
            "role": "assistant",
            "content": msg["content"].as_str().unwrap_or(""),
            "tool_calls": &tool_calls
        }));

        for tc in &tool_calls {
            let fn_obj = &tc["function"];
            let name = fn_obj["name"].as_str().unwrap_or("");
            let args = if fn_obj["arguments"].is_string() {
                serde_json::from_str(fn_obj["arguments"].as_str().unwrap_or("{}"))
                    .unwrap_or(serde_json::json!({}))
            } else {
                fn_obj["arguments"].clone()
            };

            let result = {
                let conn = state.0.lock().map_err(|e| e.to_string())?;
                execute_tool(name, &args, &conn)
            };

            ollama_msgs.push(serde_json::json!({
                "role": "tool",
                "content": result
            }));
        }
    }

    let _ = app.emit("chat-token", "Превышен лимит запросов к инструментам. Попробуйте ещё раз.");
    let _ = app.emit("chat-done", "");
    Ok(())
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
    let new_txs = filter_new(all, &hashes);
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

    let import_id = db::create_import(&conn, &filename, period_from, period_to, balance)
        .map_err(|e| e.to_string())?;
    db::commit_transactions(&conn, import_id, &txs).map_err(|e| e.to_string())
}
