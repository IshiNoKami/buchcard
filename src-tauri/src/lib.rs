// capabilities: dialog:allow-open shell:allow-open
mod categorizer;
mod commands;
mod db;
mod importer;
mod normalizer;
mod pdf_parser;

use commands::AppState;
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let conn = db::open().expect("Failed to open DB");
    db::init(&conn).expect("Failed to init DB");
    db::init_goals(&conn).expect("Failed to init goals table");
    db::init_kopilkas(&conn).expect("Failed to init kopilkas tables");
    db::renormalize_merchant_keys(&conn).ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState(Mutex::new(conn)))
        .invoke_handler(tauri::generate_handler![
            commands::get_transactions,
            commands::get_categories,
            commands::get_imports,
            commands::add_category,
            commands::set_category_excluded,
            commands::get_settings,
            commands::save_settings,
            commands::fetch_models,
            commands::start_ollama,
            commands::ping_ollama,
            commands::chat_with_ai,
            commands::summarize_conversation,
            commands::parse_file,
            commands::categorize_transactions,
            commands::commit_import,
            commands::delete_transaction,
            commands::delete_import,
            commands::parse_pdf_preview,
            commands::pdf_rows_to_transactions,
            commands::get_goals_with_progress,
            commands::create_goal,
            commands::delete_goal,
            commands::update_goal,
            commands::get_kopilkas,
            commands::create_kopilka,
            commands::add_kopilka_alias,
            commands::find_unmatched_kopilka_descriptions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
