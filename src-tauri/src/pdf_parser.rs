use anyhow::{anyhow, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

// ── Public types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfRow {
    pub id: usize,
    pub date: String,         // "YYYY-MM-DD"
    pub amount: f64,          // always positive
    pub description: String,
    pub is_income: bool,
    pub warning: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ParsedPdf {
    pub filename: String,
    pub period_from: String,
    pub period_to: String,
    pub account: String,
    pub rows: Vec<PdfRow>,
    pub warnings: usize,
    pub total: usize,
    pub income_count: usize,
}

#[derive(Debug, Deserialize)]
pub struct ConfirmedPdfRow {
    pub date: String,
    pub amount: f64,
    pub description: String,
    pub is_income: bool,
}

// ── Regex statics ──────────────────────────────────────────────────────────────

fn re_date() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    // Support both 4-digit and 2-digit years (e.g. 07.07.2025 or 07.07.25)
    R.get_or_init(|| Regex::new(r"^(\d{2})\.(\d{2})\.(\d{2,4})").unwrap())
}

fn re_amount() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        // Broad match: post-filter via extract_amounts() rejects date-like false positives
        // English: 3,302.29 | 78606.00 | 143.65 | 0.00
        // Russian: 3 302,29 | 78606,00 | 143,65 | 0,00
        Regex::new(
            r"\b(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2}|\d{1,3}(?:[ \u{00A0}\u{202F}]\d{3})+,\d{2}|\d+,\d{2})\b"
        ).unwrap()
    })
}

fn re_account() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\b\d{16,20}\b").unwrap())
}

fn re_period() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(\d{2}\.\d{2}\.\d{4})\s*[–—\-]+\s*(\d{2}\.\d{2}\.\d{4})").unwrap()
    })
}

fn re_long_digits() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\b\d{3,}\b").unwrap())
}

// ── Helpers ────────────────────────────────────────────────────────────────────

fn dmy_to_iso(dmy: &str) -> Option<String> {
    let p: Vec<&str> = dmy.split('.').collect();
    if p.len() == 3 {
        let year = if p[2].len() == 2 {
            format!("20{}", p[2])
        } else {
            p[2].to_string()
        };
        Some(format!("{}-{}-{}", year, p[1], p[0]))
    } else {
        None
    }
}

fn parse_amount_str(s: &str) -> Option<f64> {
    if s.contains('.') {
        // English format: 1,500.00 or 500.00 — strip commas, keep period
        let clean: String = s.chars().filter(|&c| c.is_ascii_digit() || c == '.').collect();
        clean.parse::<f64>().ok()
    } else {
        // Russian format: 1 500,00 or 500,00 — strip spaces, replace comma with period
        let clean: String = s.chars().filter(|&c| c.is_ascii_digit() || c == ',').collect();
        clean.replace(',', ".").parse::<f64>().ok()
    }
}

// Skip optional ", HH:MM" or " HH:MM:SS" after a date
fn skip_time(s: &str) -> &str {
    let s = s.trim_start_matches(|c: char| c == ',' || c == ' ');
    let b = s.as_bytes();
    if b.len() >= 5
        && b[0].is_ascii_digit()
        && b[1].is_ascii_digit()
        && b[2] == b':'
        && b[3].is_ascii_digit()
        && b[4].is_ascii_digit()
    {
        let r = &s[5..];
        // Also skip optional ":SS"
        if r.starts_with(':') && r.len() >= 3
            && r.as_bytes()[1].is_ascii_digit()
            && r.as_bytes()[2].is_ascii_digit()
        {
            &r[3..]
        } else {
            r
        }
    } else {
        s
    }
}

// Extract amounts with post-filter: reject matches followed by '.' or digit
// (prevents "07.05" from "07.05.2026" or "7999,79" from "7999,793808")
fn extract_amounts(text: &str) -> Vec<f64> {
    re_amount()
        .find_iter(text)
        .filter_map(|m| {
            let after = &text[m.end()..];
            match after.chars().next() {
                Some('.') | Some(',') | Some('0'..='9') => None,
                _ => parse_amount_str(m.as_str()),
            }
        })
        .collect()
}

fn strip_amounts_and_numbers(s: &str) -> String {
    let s = re_amount().replace_all(s, " ");
    let s = re_long_digits().replace_all(&s, " ");
    let s = re_account().replace_all(&s, " ");
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_skip_line(line: &str) -> bool {
    let l = line.to_lowercase();

    // Table header rows
    if (l.contains("дебет") && l.contains("кредит"))
        || (l.contains("дата") && l.contains("назначение"))
        || l.contains("входящий остаток")
        || l.contains("исходящий остаток")
    {
        return true;
    }
    // Statement metadata
    if l.starts_with("выписка")
        || l.starts_with("клиент")
        || l.starts_with("период")
        || l.starts_with("номер счёт")
        || l.starts_with("номер счет")
        || l.starts_with("итого")
        || l.starts_with("оборот")
        || l.contains("страниц")
    {
        return true;
    }
    // Very short lines and separator lines
    if line.len() < 3 {
        return true;
    }
    if line
        .chars()
        .all(|c| matches!(c, '─' | '━' | '–' | '—' | '-' | '=' | '_' | ' '))
    {
        return true;
    }

    false
}

// ── Amount classification ──────────────────────────────────────────────────────
//
// Sovkombank table columns per row: [balance, debit, credit]
// One of debit/credit is typically 0,00.

fn classify_amounts(amounts: &[f64]) -> (f64, bool, Option<String>) {
    match amounts.len() {
        0 => (0.0, false, Some("Сумма не найдена — введите вручную".into())),
        1 => (amounts[0], false, None),
        2 => {
            let (a, b) = (amounts[0], amounts[1]);
            if b == 0.0 {
                (a, false, None)
            } else if a == 0.0 {
                (b, true, None)
            } else {
                // Both non-zero: larger is likely running balance
                let ratio = a.max(b) / a.min(b);
                if ratio > 2.5 {
                    // Smaller is the transaction amount; assume expense
                    (a.min(b), false, None)
                } else {
                    (a, false, Some("Проверьте сумму".into()))
                }
            }
        }
        _ => {
            // 3+ amounts: standard [balance, …, debit, credit]
            let debit = amounts[amounts.len() - 2];
            let credit = amounts[amounts.len() - 1];
            match (debit > 0.0, credit > 0.0) {
                (true, false) => (debit, false, None),
                (false, true) => (credit, true, None),
                (true, true) => (
                    debit,
                    false,
                    Some("Оба поля непустые — проверьте".into()),
                ),
                (false, false) => (0.0, false, Some("Нулевая сумма — введите вручную".into())),
            }
        }
    }
}

// ── State machine ──────────────────────────────────────────────────────────────

struct Builder {
    date: String,
    amounts: Vec<f64>,
    desc: Vec<String>,
}

fn finalize(b: Builder, id: usize) -> Option<PdfRow> {
    if b.date.is_empty() {
        return None;
    }
    let description = b
        .desc
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let (amount, is_income, warning) = classify_amounts(&b.amounts);
    Some(PdfRow {
        id,
        date: b.date,
        amount,
        description,
        is_income,
        warning,
    })
}

fn extract_rows(text: &str) -> Vec<PdfRow> {
    let mut rows: Vec<PdfRow> = Vec::new();
    let mut builder: Option<Builder> = None;

    for line in text.lines() {
        let line = line.trim().trim_matches('\x0c'); // strip form-feed
        if line.is_empty() || is_skip_line(line) {
            continue;
        }

        if let Some(caps) = re_date().captures(line) {
            // Flush previous transaction
            if let Some(b) = builder.take() {
                if let Some(row) = finalize(b, rows.len()) {
                    rows.push(row);
                }
            }

            let year_raw = &caps[3];
            let year = if year_raw.len() == 2 {
                format!("20{}", year_raw)
            } else {
                year_raw.to_string()
            };
            let date = format!("{}-{}-{}", year, &caps[2], &caps[1]);
            let rest = &line[caps[0].len()..];
            let rest = skip_time(rest);
            // Remove account number from the rest
            let rest_clean = re_account().replace_all(rest, " ").to_string();

            let amounts = extract_amounts(&rest_clean);

            let desc_part = strip_amounts_and_numbers(&rest_clean);
            let mut b = Builder {
                date,
                amounts,
                desc: Vec::new(),
            };
            if !desc_part.is_empty() {
                b.desc.push(desc_part);
            }
            builder = Some(b);
        } else if let Some(b) = builder.as_mut() {
            // Skip pure account-number lines
            if re_account().is_match(line)
                && line.chars().all(|c| c.is_ascii_digit() || c == ' ')
            {
                continue;
            }

            let amounts_here = extract_amounts(line);

            if amounts_here.is_empty() {
                // Pure description continuation
                b.desc.push(line.to_string());
            } else {
                b.amounts.extend_from_slice(&amounts_here);
                let desc_part = strip_amounts_and_numbers(line);
                if !desc_part.is_empty() {
                    b.desc.push(desc_part);
                }
            }
        }
    }

    // Flush last transaction
    if let Some(b) = builder.take() {
        if let Some(row) = finalize(b, rows.len()) {
            rows.push(row);
        }
    }

    rows
}

// ── Public entry point ─────────────────────────────────────────────────────────

pub fn parse_sovkombank_pdf(path: &str) -> Result<ParsedPdf> {
    let text = pdf_extract::extract_text(path).map_err(|e| {
        anyhow!(
            "Не удалось прочитать PDF: {}. \
             Убедитесь что файл не повреждён и не защищён паролем.",
            e
        )
    })?;

    if text.trim().is_empty() {
        return Err(anyhow!(
            "PDF не содержит текстового слоя. \
             Попробуйте экспортировать выписку заново в личном кабинете банка."
        ));
    }

    let filename = std::path::Path::new(path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let account = re_account()
        .find(&text)
        .map(|m| m.as_str().to_string())
        .unwrap_or_default();

    let (period_from, period_to) = re_period()
        .captures(&text)
        .and_then(|c| {
            let f = dmy_to_iso(c.get(1)?.as_str())?;
            let t = dmy_to_iso(c.get(2)?.as_str())?;
            Some((f, t))
        })
        .unwrap_or_default();

    let rows = extract_rows(&text);

    // Fall back to min/max dates from actual data if period not found in header
    let period_from = if period_from.is_empty() {
        rows.iter().map(|r| r.date.as_str()).min().unwrap_or("").to_string()
    } else {
        period_from
    };
    let period_to = if period_to.is_empty() {
        rows.iter().map(|r| r.date.as_str()).max().unwrap_or("").to_string()
    } else {
        period_to
    };

    let warnings = rows.iter().filter(|r| r.warning.is_some()).count();
    let income_count = rows.iter().filter(|r| r.is_income).count();
    let total = rows.len();

    Ok(ParsedPdf {
        filename,
        period_from,
        period_to,
        account,
        rows,
        warnings,
        total,
        income_count,
    })
}
