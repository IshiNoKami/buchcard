// capabilities: dialog:allow-open shell:allow-open
mod categorizer;
mod commands;
mod credit;
mod db;
mod gazprombank_pdf;
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
    db::init_credits(&conn).expect("Failed to init credits tables");
    db::init_planned(&conn).expect("Failed to init planned_items table");
    db::renormalize_merchant_keys(&conn).ok();
    db::dedupe_truncated_descriptions(&conn).ok();
    db::recat_income_transfers(&conn).ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
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
            commands::get_credits,
            commands::create_credit,
            commands::update_credit,
            commands::delete_credit,
            commands::archive_credit,
            commands::add_credit_payment,
            commands::get_credit_payments,
            commands::get_credit_schedule,
            commands::get_net_worth_parts,
            commands::get_month_comparison,
            commands::get_cash_forecast,
            commands::get_debt_strategy,
            commands::set_debt_alloc_pct,
            commands::get_due_reminders,
            commands::find_credit_payment_candidates,
            commands::get_planned_items,
            commands::create_planned_item,
            commands::update_planned_item,
            commands::delete_planned_item,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
