use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

use crate::categorizer::{categorize_one, CategorizedTx};
use crate::db::{self, Category, Import, Settings, Transaction};
use crate::importer::{filter_new, parse_xls};
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
                "description": "Возвращает итого расходов, доходов и количество транзакций за указанный период",
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
         5. Будь конкретен: называй точные цифры из данных.",
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
pub fn categorize_transactions(
    transactions: Vec<Transaction>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<CategorizedTx>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let categories: Vec<String> = db::get_categories(&conn)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|c| c.name)
        .collect();
    let known_keys = db::known_merchant_keys(&conn).map_err(|e| e.to_string())?;
    drop(conn);

    let settings = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        db::get_settings(&conn).map_err(|e| e.to_string())?
    };

    let total = transactions.len();
    let mut results = Vec::new();
    let mut merchant_index = MerchantIndex::new(known_keys);

    for (i, tx) in transactions.iter().enumerate() {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        let categorized = categorize_one(tx, &conn, &categories, &mut merchant_index,
            &settings.endpoint, &settings.api_key, &settings.model)
            .map_err(|e| e.to_string())?;
        drop(conn);

        let _ = app.emit("categorize-progress", ProgressEvent {
            merchant_key: categorized.tx.merchant_key.clone(),
            category: categorized.tx.category.clone(),
            source: categorized.source.clone(),
            confidence: categorized.confidence,
            done: i + 1,
            total,
        });

        results.push(categorized);
    }

    Ok(results)
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
    state: State<AppState>,
) -> Result<usize, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let txs: Vec<Transaction> = approved.iter().map(|a| a.tx.clone()).collect();

    let dates: Vec<&str> = txs.iter().map(|t| t.date.as_str()).collect();
    let period_from = dates.iter().min().copied().unwrap_or("");
    let period_to = dates.iter().max().copied().unwrap_or("");

    // Обновить merchant_cache для user-правок
    for a in &approved {
        if a.source == "user" {
            let mc = db::MerchantCache {
                merchant_key: a.tx.merchant_key.clone(),
                category: a.tx.category.clone(),
                source: "user".to_string(),
                confidence: None,
                reasoning: None,
            };
            db::upsert_merchant(&conn, &mc).ok();
        }
    }

    let import_id = db::create_import(&conn, &filename, period_from, period_to)
        .map_err(|e| e.to_string())?;
    db::commit_transactions(&conn, import_id, &txs).map_err(|e| e.to_string())
}
