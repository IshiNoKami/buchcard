//! Парсер PDF-выписок Газпромбанка («ВЫПИСКА ПО КАРТЕ»).
//! Формат: таблица «Отчет по операциям», блок начинается парой дат
//! (дата операции + дата отражения), суммы в двух колонках «Приход/Расход»
//! (+X,XX -Y,YY — одна из них нулевая), описание многострочное.

use anyhow::{anyhow, Result};
use regex::Regex;
use std::sync::OnceLock;

use crate::pdf_parser::{ParsedPdf, PdfRow};

/// Маркер выписки Газпромбанка в извлечённом тексте.
pub fn is_gazprombank(text: &str) -> bool {
    let t = text.to_uppercase();
    t.contains("ГАЗПРОМБАНК") || t.contains("GAZPRUMM") || t.contains("GAZPROMBANK")
}

fn re_block_start() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^(\d{2}\.\d{2}\.\d{4})\s+(\d{2}\.\d{2}\.\d{4})\s*(.*)$").unwrap())
}

fn re_amounts_pair() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    // «+2 206,00 -0,00» в конце строки (пробелы могут быть неразрывными)
    R.get_or_init(|| {
        Regex::new(r"\+([\d \u{00A0}\u{202F}]+,\d{2})\s+-([\d \u{00A0}\u{202F}]+,\d{2})\s*$").unwrap()
    })
}

fn re_period() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"[Зз]а период\s+с?\s*(\d{2}\.\d{2}\.\d{4})\s*(?:по|-|–|—)\s*(\d{2}\.\d{2}\.\d{4})").unwrap()
    })
}

fn re_account() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\b(\d{20})\b").unwrap())
}

fn parse_amount(s: &str) -> Option<f64> {
    let clean: String = s
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == ',')
        .collect();
    clean.replace(',', ".").parse::<f64>().ok()
}

fn dmy_to_iso(dmy: &str) -> Option<String> {
    let p: Vec<&str> = dmy.split('.').collect();
    (p.len() == 3).then(|| format!("{}-{}-{}", p[2], p[1], p[0]))
}

/// Шумовые строки: шапки страниц, колонтитулы, подпись.
fn is_noise(line: &str) -> bool {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            r"^\d+\s*$",
            r"^ВЫПИСКА ПО КАРТЕ",
            r"^За период",
            r"^Выписка сформирована",
            r"^Держатель",
            r"^Дата\s*$",
            r"^Дата отражения",
            r"^Дата\s+Дата отражения",
            r"^совершения\s*$",
            r"^операции\s*$",
            r"^операции по Счету",
            r"^карты\s*$",
            r"^\(списания/зачисления",
            r"^денежных средств\)",
            r"^Содержание операции",
            r"^Коробов",
            r"^Вице-Президент",
            r"^и эффективности",
        ]
        .iter()
        .map(|p| Regex::new(p).unwrap())
        .collect()
    });
    let l = line.trim();
    patterns.iter().any(|p| p.is_match(l))
}

/// Контрольные суммы из шапки. pdf-extract перемешивает колонки переносами
/// («Поступления\nРасходы 13 984,80 руб.\n2 285,00 руб.»), поэтому берём
/// первые две суммы в окне после слова «Поступления»: первая — поступления,
/// вторая — расходы (порядок значений сохраняется).
fn header_totals(text: &str) -> (Option<f64>, Option<f64>) {
    static R_AMT: OnceLock<Regex> = OnceLock::new();
    let r_amt = R_AMT.get_or_init(|| Regex::new(r"([\d \u{00A0}\u{202F}]+,\d{2})\s*руб").unwrap());
    let start = match text.find("Поступления") {
        Some(i) => i,
        None => return (None, None),
    };
    let window = &text[start..text.len().min(start + 300)];
    let mut it = r_amt.captures_iter(window);
    let first = it.next().and_then(|c| parse_amount(&c[1]));
    let second = it.next().and_then(|c| parse_amount(&c[1]));
    (first, second)
}

struct Block {
    date: String, // дата совершения операции (ISO)
    lines: Vec<String>,
}

fn finalize_block(b: Block, id: usize) -> Option<PdfRow> {
    // Ищем пару сумм в любой строке блока (обычно первая, но раскладка
    // pdf-extract может отличаться от pdfplumber)
    let mut income = 0.0f64;
    let mut expense = 0.0f64;
    let mut found = false;
    let mut desc_parts: Vec<String> = Vec::new();

    for line in &b.lines {
        if !found {
            if let Some(c) = re_amounts_pair().captures(line) {
                income = parse_amount(&c[1]).unwrap_or(0.0);
                expense = parse_amount(&c[2]).unwrap_or(0.0);
                found = true;
                let head = line[..c.get(0).unwrap().start()].trim();
                if !head.is_empty() {
                    desc_parts.push(head.to_string());
                }
                continue;
            }
            let t = line.trim();
            if !t.is_empty() {
                desc_parts.push(t.to_string());
            }
        }
        // После пары сумм блок закончен — хвост (колонтитулы, дата подписи) игнорируем
    }

    let description = desc_parts.join(" ").split_whitespace().collect::<Vec<_>>().join(" ");
    if description.is_empty() && !found {
        return None;
    }

    let is_income = income > 0.0;
    let amount = if is_income { income } else { expense };
    Some(PdfRow {
        id,
        date: b.date,
        amount,
        description,
        is_income,
        warning: (!found).then(|| "Сумма не найдена — введите вручную".to_string()),
    })
}

fn extract_rows(text: &str) -> Vec<PdfRow> {
    let mut rows: Vec<PdfRow> = Vec::new();
    let mut in_table = false;
    let mut block: Option<Block> = None;

    for raw in text.lines() {
        let line = raw.trim().trim_matches('\x0c');
        if line.is_empty() {
            continue;
        }
        if line.starts_with("Отчет по операциям") {
            in_table = true;
            continue;
        }
        if !in_table || is_noise(line) {
            continue;
        }

        if let Some(c) = re_block_start().captures(line) {
            if let Some(b) = block.take() {
                if let Some(row) = finalize_block(b, rows.len()) {
                    rows.push(row);
                }
            }
            let date = dmy_to_iso(&c[1]).unwrap_or_default();
            let rest = c[3].trim().to_string();
            let mut b = Block { date, lines: Vec::new() };
            if !rest.is_empty() {
                b.lines.push(rest);
            }
            block = Some(b);
        } else if let Some(b) = block.as_mut() {
            b.lines.push(line.to_string());
        }
    }
    if let Some(b) = block.take() {
        if let Some(row) = finalize_block(b, rows.len()) {
            rows.push(row);
        }
    }
    rows
}

pub fn parse_gazprombank_text(text: &str, filename: &str) -> Result<ParsedPdf> {
    let (period_from, period_to) = re_period()
        .captures(text)
        .and_then(|c| Some((dmy_to_iso(&c[1])?, dmy_to_iso(&c[2])?)))
        .unwrap_or_default();

    let account = re_account()
        .find(text)
        .map(|m| m.as_str().to_string())
        .unwrap_or_default();

    let mut rows = extract_rows(text);

    // Валидация по контрольным суммам из шапки
    let (stated_in, stated_out) = header_totals(text);
    let sum_in: f64 = rows.iter().filter(|r| r.is_income).map(|r| r.amount).sum();
    let sum_out: f64 = rows.iter().filter(|r| !r.is_income).map(|r| r.amount).sum();
    if let Some(si) = stated_in {
        if (si - sum_in).abs() > 0.01 {
            for r in rows.iter_mut().filter(|r| r.is_income) {
                r.warning.get_or_insert_with(|| {
                    format!("Сумма поступлений не сходится с шапкой ({:.2} ≠ {:.2})", sum_in, si)
                });
            }
        }
    }
    if let Some(so) = stated_out {
        if (so - sum_out).abs() > 0.01 {
            for r in rows.iter_mut().filter(|r| !r.is_income) {
                r.warning.get_or_insert_with(|| {
                    format!("Сумма расходов не сходится с шапкой ({:.2} ≠ {:.2})", sum_out, so)
                });
            }
        }
    }

    let period_from = if period_from.is_empty() {
        rows.iter().map(|r| r.date.as_str()).min().unwrap_or("").to_string()
    } else { period_from };
    let period_to = if period_to.is_empty() {
        rows.iter().map(|r| r.date.as_str()).max().unwrap_or("").to_string()
    } else { period_to };

    let warnings = rows.iter().filter(|r| r.warning.is_some()).count();
    let income_count = rows.iter().filter(|r| r.is_income).count();
    let total = rows.len();

    Ok(ParsedPdf {
        filename: filename.to_string(),
        period_from,
        period_to,
        account,
        rows,
        warnings,
        total,
        income_count,
    })
}

/// Прямой парсинг файла (командой не используется — там текст извлекается
/// один раз для автодетекта; нужен тестам и как самостоятельная точка входа).
#[allow(dead_code)]
pub fn parse_gazprombank_pdf(path: &str) -> Result<ParsedPdf> {
    let text = pdf_extract::extract_text(path)
        .map_err(|e| anyhow!("Не удалось прочитать PDF: {}", e))?;
    if text.trim().is_empty() {
        return Err(anyhow!("PDF не содержит текстового слоя."));
    }
    let filename = std::path::Path::new(path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    parse_gazprombank_text(&text, &filename)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Реальная раскладка pdf-extract (сокращённый образец из настоящей выписки).
    const SAMPLE: &str = "\
S.W.I.F.T.: GAZPRUMM

40817810072110527478
Российский Рубль
************3976

ВЫПИСКА ПО КАРТЕ
За период с 05.06.2026 по 04.07.2026

Поступления
Расходы 13 984,80 руб.
2 285,00 руб.

Отчет по операциям за период с 05.06.2026 по 04.07.2026

Дата
совершения
операции
 Дата отражения
операции по Счету
карты
(списания/зачисления
денежных средств)
 Содержание операции Приход Расход

11.06.2026 11.06.2026 Зачисление на карту:
220001xxxxxxxx3976.
УН//№83168//заработная плата за ма
 +2 206,00 -0,00

25.06.2026 26.06.2026  Операция: ПЕРЕВОД С КАРТЫ НА
КАРТУ (СПИСАНИЕ) (ФИЛИАЛ
ГПБ). Сумма
операции: 2206.00. Валюта операции:
Российские рубли.
 +0,00 -2 206,00

ВЫПИСКА ПО КАРТЕ
За период 05.06.2026 - 04.07.2026

2
 Держатель Воропай Даниил Евгеньевич

26.06.2026 26.06.2026 Зачисление на карту:
УН//№91004//заработная плата за 1
 +11 778,80 -0,00

02.07.2026 02.07.2026 Комиссия за предоставление услуги
\"Информирование\" по карте *3976 за
07.2026
 +0,00 -79,00

Коробов В.К.
Вице-Президент - начальник Департамента развития
и эффективности каналов обслуживания

04.07.2026
";

    #[test]
    fn detects_bank() {
        assert!(is_gazprombank(SAMPLE));
        assert!(!is_gazprombank("Совкомбанк выписка по счёту"));
    }

    #[test]
    fn parses_sample() {
        let p = parse_gazprombank_text(SAMPLE, "test.pdf").unwrap();
        assert_eq!(p.total, 4);
        assert_eq!(p.period_from, "2026-06-05");
        assert_eq!(p.period_to, "2026-07-04");
        assert_eq!(p.account, "40817810072110527478");
        assert_eq!(p.income_count, 2);
        assert_eq!(p.warnings, 0, "контрольные суммы должны сойтись");

        assert_eq!(p.rows[0].date, "2026-06-11");
        assert!(p.rows[0].is_income);
        assert!((p.rows[0].amount - 2206.0).abs() < 0.001);

        assert!(!p.rows[1].is_income);
        assert!((p.rows[1].amount - 2206.0).abs() < 0.001);
        // Описание не съедено шумовыми паттернами и не содержит хвоста подписи
        assert!(p.rows[1].description.contains("операции: 2206.00"));

        assert!((p.rows[2].amount - 11778.8).abs() < 0.001);
        assert!(!p.rows[3].is_income);
        assert!((p.rows[3].amount - 79.0).abs() < 0.001);
        assert!(!p.rows[3].description.contains("Коробов"));
        assert!(!p.rows[3].description.contains("04.07.2026"));
    }

    #[test]
    fn totals_mismatch_warns() {
        let broken = SAMPLE.replace("+11 778,80 -0,00", "+11 000,00 -0,00");
        let p = parse_gazprombank_text(&broken, "test.pdf").unwrap();
        assert!(p.warnings > 0, "расхождение с шапкой должно давать предупреждение");
    }

    /// Разовый дамп реального PDF для калибровки парсера:
    /// cargo test --lib gazprombank_pdf::tests::dump_real -- --ignored --nocapture
    #[test]
    #[ignore]
    fn dump_real() {
        let path = r"C:\Users\ontar\Downloads\buchcard\выписка_газпром.pdf";
        let text = pdf_extract::extract_text(path).expect("extract");
        println!("=== BEGIN EXTRACTED ===\n{}\n=== END EXTRACTED ===", text);
    }

    #[test]
    #[ignore]
    fn parse_real() {
        let path = r"C:\Users\ontar\Downloads\buchcard\выписка_газпром.pdf";
        let parsed = parse_gazprombank_pdf(path).expect("parse");
        println!("{:#?}", parsed);
        assert_eq!(parsed.total, 4);
    }
}
