// capabilities: dialog:allow-open shell:allow-open
mod categorizer;
mod commands;
mod db;
mod importer;
mod normalizer;

use commands::AppState;
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let conn = db::open().expect("Failed to open DB");
    db::init(&conn).expect("Failed to init DB");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState(Mutex::new(conn)))
        .invoke_handler(tauri::generate_handler![
            commands::get_transactions,
            commands::get_categories,
            commands::get_imports,
            commands::add_category,
            commands::get_settings,
            commands::save_settings,
            commands::fetch_models,
            commands::start_ollama,
            commands::ping_ollama,
            commands::chat_with_ai,
            commands::parse_file,
            commands::categorize_transactions,
            commands::commit_import,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
