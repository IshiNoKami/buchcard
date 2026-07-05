use anyhow::Result;
use calamine::{open_workbook_auto, Reader};
use sha1::{Digest, Sha1};
use std::path::Path;

use crate::db::Transaction;
use crate::normalizer::normalize_merchant;

pub(crate) fn tx_hash(date: &str, amount: f64, description: &str) -> String {
    let prefix: String = description.chars().take(40).collect();
    let key = format!("{}|{}|{}", date, amount, prefix);
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    hex::encode(hasher.finalize())
}

fn parse_amount(raw: &str) -> Option<f64> {
    let s = raw
        .replace('\u{00A0}', "")
        .replace(' ', "")
        .replace(',', ".");
    s.parse::<f64>().ok()
}

fn parse_date(raw: &str) -> Option<String> {
    let s = raw.trim();
    // Совкомбанк: "27.05.2026 12:34:56" или "27.05.2026"
    let date_part = &s[..s.len().min(10)];
    if date_part.len() == 10 {
        let parts: Vec<&str> = date_part.split('.').collect();
        if parts.len() == 3 {
            return Some(format!("{}-{}-{}", parts[2], parts[1], parts[0]));
        }
    }
    None
}

pub fn parse_xls(filepath: &Path) -> Result<Vec<Transaction>> {
    let mut workbook = open_workbook_auto(filepath)?;
    let sheet_name = workbook.sheet_names()[0].clone();
    let range = workbook.worksheet_range(&sheet_name)?;

    let mut rows: Vec<Transaction> = Vec::new();

    for (i, row) in range.rows().enumerate() {
        if i < 2 { continue; } // Совкомбанк: 2 строки заголовка

        let ncols = row.len();
        if ncols < 3 { continue; }

        let date_raw = row[0].to_string();
        let amount_raw = row[1].to_string();
        let description = row[ncols - 1].to_string().trim().to_string();

        if description.is_empty() { continue; }

        let date = match parse_date(&date_raw) { Some(d) => d, None => continue };
        let amount_raw_val = match parse_amount(&amount_raw) { Some(a) => a, None => continue };

        if amount_raw_val == 0.0 { continue; }

        let is_income = amount_raw_val > 0.0;
        let amount = amount_raw_val.abs();

        let merchant_key = if is_income {
            "Доход".to_string()
        } else {
            normalize_merchant(&description)
        };
        let hash = tx_hash(&date, amount, &description);

        rows.push(Transaction {
            id: None,
            import_id: None,
            date,
            amount,
            merchant_key,
            category: if is_income {
                crate::categorizer::income_category(&description).to_string()
            } else {
                String::new()
            },
            description,
            tx_hash: hash,
            is_income,
        });
    }

    rows.sort_by(|a, b| a.date.cmp(&b.date));
    Ok(rows)
}

/// Одно описание — начало другого (банк по-разному обрезает в разных выгрузках).
/// Минимум 8 общих символов, чтобы не склеивать случайные совпадения.
fn is_truncation_pair(a: &str, b: &str) -> bool {
    let min = a.len().min(b.len());
    min >= 8 && (a.starts_with(b) || b.starts_with(a))
}

pub fn filter_new(
    txs: Vec<Transaction>,
    existing_hashes: &std::collections::HashSet<String>,
    existing_sigs: &[(String, f64, String)],
) -> Vec<Transaction> {
    txs.into_iter()
        .filter(|tx| {
            if existing_hashes.contains(&tx.tx_hash) {
                return false;
            }
            // Дубль с усечённым описанием: та же дата и сумма, описания — префиксы друг друга
            let dl = tx.description.to_lowercase();
            let truncated_dup = existing_sigs.iter().any(|(date, amount, desc)| {
                date == &tx.date
                    && (amount - tx.amount).abs() < 0.005
                    && is_truncation_pair(&dl, desc)
            });
            !truncated_dup
        })
        .collect()
}
