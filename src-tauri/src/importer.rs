use anyhow::Result;
use calamine::{open_workbook_auto, Reader};
use sha1::{Digest, Sha1};
use std::path::Path;

use crate::db::Transaction;
use crate::normalizer::normalize_merchant;

const INTERNAL_KEYWORDS: &[&str] = &[
    "перевод собственных средств",
    "зачисление перевода денежных средств",
    "заработная плата",
    "перевод со счета",
    "перечисление на счет копилки путешествия по опции",
];

fn is_internal(desc: &str) -> bool {
    let d = desc.to_lowercase();
    INTERNAL_KEYWORDS.iter().any(|kw| d.contains(kw))
}

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
        if is_internal(&description) { continue; }

        let date = match parse_date(&date_raw) { Some(d) => d, None => continue };
        let amount = match parse_amount(&amount_raw) { Some(a) => a, None => continue };

        if amount >= 0.0 { continue; } // только расходы
        let amount = -amount;

        let merchant_key = normalize_merchant(&description);
        let hash = tx_hash(&date, amount, &description);

        rows.push(Transaction {
            id: None,
            import_id: None,
            date,
            amount,
            description,
            merchant_key,
            category: String::new(),
            tx_hash: hash,
            is_income: false,
        });
    }

    rows.sort_by(|a, b| a.date.cmp(&b.date));
    Ok(rows)
}

pub fn filter_new(
    txs: Vec<Transaction>,
    existing_hashes: &std::collections::HashSet<String>,
) -> Vec<Transaction> {
    txs.into_iter()
        .filter(|tx| !existing_hashes.contains(&tx.tx_hash))
        .collect()
}
