use regex::Regex;
use std::sync::OnceLock;
use strsim::jaro_winkler;

static RE_SBP: OnceLock<Regex> = OnceLock::new();
static RE_TAGS: OnceLock<Regex> = OnceLock::new();
static RE_LONG_DIGITS: OnceLock<Regex> = OnceLock::new();
static RE_NON_LETTER: OnceLock<Regex> = OnceLock::new();
static RE_SPACES: OnceLock<Regex> = OnceLock::new();
// Extracts city from Sovcombank auth format: "...{amount}RUR,{City},MCC..."
static RE_CITY: OnceLock<Regex> = OnceLock::new();

pub fn normalize_merchant(raw: &str) -> String {
    let re_sbp = RE_SBP.get_or_init(|| {
        Regex::new(r"(?i)^оплата\s+по\s+сбп\s+\w+\s+").unwrap()
    });
    let re_mobile = Regex::new(r"(?i)^оплата\s+в\s+мобильном\s+приложении\s+").unwrap();
    let re_tags = RE_TAGS.get_or_init(|| Regex::new(r"[*#@][\w\d]+").unwrap());
    let re_digits = RE_LONG_DIGITS.get_or_init(|| Regex::new(r"\d{4,}").unwrap());
    let re_non = RE_NON_LETTER.get_or_init(|| {
        Regex::new(r"[^\p{L}\s]").unwrap()
    });
    let re_sp = RE_SPACES.get_or_init(|| Regex::new(r"\s+").unwrap());
    let re_city = RE_CITY.get_or_init(|| {
        // Matches "{amount}RUR,{City},MCC" — city is always between currency and MCC
        Regex::new(r"(?i)(?:rur|usd|eur|byn|cny),([A-Za-z][A-Za-z-]*)").unwrap()
    });

    let raw_lower = raw.to_lowercase();

    // Priority 1: Sovcombank "Платеж АВТОРИЗАЦИЯ №..." with backslash merchant path
    // Format: "...\COUNTRY\CITY\MERCHANT\ID\" — merchant is always at index 3
    if raw_lower.starts_with("платеж авторизация №") && raw.contains('\\') {
        let parts: Vec<&str> = raw.split('\\').map(str::trim).collect();
        if let Some(&merchant) = parts.get(3) {
            if !merchant.is_empty() && merchant.chars().any(|c| c.is_alphabetic()) {
                let s = merchant.to_lowercase();
                let s = re_non.replace_all(&s, " ");
                let s = re_sp.replace_all(s.trim(), " ");
                let result = s.split_whitespace().take(5).collect::<Vec<_>>().join(" ");
                if !result.is_empty() {
                    return result;
                }
            }
        }
    }

    // Priority 2: other backslash-delimited merchant paths — take last alphabetic segment
    if raw.contains('\\') {
        if let Some(merchant) = raw.split('\\').map(str::trim)
            .filter(|s| s.len() > 2 && s.chars().any(|c| c.is_alphabetic()))
            .last()
        {
            let s = merchant.to_lowercase();
            let s = re_non.replace_all(&s, " ");
            let s = re_sp.replace_all(s.trim(), " ");
            return s.split_whitespace().take(5).collect::<Vec<_>>().join(" ");
        }
    }

    // Priority 3: Sovcombank auth format without merchant path — fallback to city
    // "Платеж АВТОРИЗАЦИЯ ...,769.01RUR,Tomsk,MCC 5812" → "tomsk"
    if raw_lower.contains("авторизация") || raw_lower.contains("платеж") {
        if let Some(caps) = re_city.captures(raw) {
            if let Some(city) = caps.get(1) {
                let s = city.as_str().to_lowercase();
                if !s.is_empty() {
                    return s;
                }
            }
        }
    }

    let s = raw.to_lowercase();
    let s = re_sbp.replace(&s, "");
    let s = re_mobile.replace(&s, "");
    let s = re_tags.replace_all(&s, "");
    let s = re_digits.replace_all(&s, "");
    let s = re_non.replace_all(&s, " ");
    let s = re_sp.replace_all(s.trim(), " ");

    let result = s.split_whitespace()
        .take(5)
        .collect::<Vec<_>>()
        .join(" ");

    // Fallback: if normalization ate everything meaningful, use first 5 words of lowercased raw
    if result.len() < 3 {
        let raw_clean = re_non.replace_all(&raw_lower, " ");
        let raw_clean = re_sp.replace_all(raw_clean.trim(), " ");
        let fallback = raw_clean.split_whitespace().take(5).collect::<Vec<_>>().join(" ");
        // If the original was pure digits (card number, account), keep it as-is to avoid empty key
        if fallback.is_empty() {
            let digits_only: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
            if !digits_only.is_empty() {
                return format!("card {}", &digits_only[..digits_only.len().min(8)]);
            }
            return "прочее".to_string();
        }
        return fallback;
    }

    result
}

const SIMILARITY_THRESHOLD: f64 = 0.88;

pub struct MerchantIndex {
    keys: Vec<String>,
}

impl MerchantIndex {
    pub fn new(known: Vec<String>) -> Self {
        Self { keys: known }
    }

    pub fn resolve(&mut self, key: &str) -> String {
        if self.keys.contains(&key.to_string()) {
            return key.to_string();
        }
        let best = self.keys.iter().max_by(|a, b| {
            jaro_winkler(key, a)
                .partial_cmp(&jaro_winkler(key, b))
                .unwrap()
        });
        if let Some(b) = best {
            if jaro_winkler(key, b) >= SIMILARITY_THRESHOLD {
                return b.clone();
            }
        }
        self.keys.push(key.to_string());
        key.to_string()
    }
}
