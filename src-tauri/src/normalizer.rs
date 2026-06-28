use regex::Regex;
use std::sync::OnceLock;
use strsim::jaro_winkler;

static RE_SBP: OnceLock<Regex> = OnceLock::new();
static RE_TAGS: OnceLock<Regex> = OnceLock::new();
static RE_LONG_DIGITS: OnceLock<Regex> = OnceLock::new();
static RE_NON_LETTER: OnceLock<Regex> = OnceLock::new();
static RE_SPACES: OnceLock<Regex> = OnceLock::new();

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

    let s = raw.to_lowercase();
    let s = re_sbp.replace(&s, "");
    let s = re_mobile.replace(&s, "");
    let s = re_tags.replace_all(&s, "");
    let s = re_digits.replace_all(&s, "");
    let s = re_non.replace_all(&s, " ");
    let s = re_sp.replace_all(s.trim(), " ");

    // Первые 5 слов как стабильный ключ
    s.split_whitespace()
        .take(5)
        .collect::<Vec<_>>()
        .join(" ")
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
