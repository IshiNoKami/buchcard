use anyhow::Result;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

use crate::db::Transaction;

// MCC code → app category mapping
const MCC_CATEGORY: &[(u16, &str)] = &[
    (742,  "Питомцы"),
    (4111, "Транспорт/Такси"),
    (4131, "Транспорт/Такси"),
    (4789, "Транспорт/Такси"),
    (5137, "Одежда/Обувь"),
    (5139, "Одежда/Обувь"),
    (5297, "Продукты"),
    (5298, "Продукты"),
    (5300, "Продукты"),
    (5309, "Покупки/Маркетплейс"),
    (5331, "Покупки/Маркетплейс"),
    (5399, "Прочее"),
    (5411, "Продукты"),
    (5412, "Продукты"),
    (5422, "Продукты"),
    (5441, "Кафе/Рестораны"),
    (5451, "Продукты"),
    (5462, "Кафе/Рестораны"),
    (5499, "Продукты"),
    (5521, "Автоуслуги"),
    (5531, "Автоуслуги"),
    (5532, "Автоуслуги"),
    (5533, "Автоуслуги"),
    (5611, "Одежда/Обувь"),
    (5621, "Одежда/Обувь"),
    (5631, "Одежда/Обувь"),
    (5641, "Одежда/Обувь"),
    (5651, "Одежда/Обувь"),
    (5655, "Спорт"),
    (5661, "Одежда/Обувь"),
    (5681, "Одежда/Обувь"),
    (5691, "Одежда/Обувь"),
    (5697, "Одежда/Обувь"),
    (5698, "Одежда/Обувь"),
    (5699, "Одежда/Обувь"),
    (5715, "Продукты"),
    (5811, "Кафе/Рестораны"),
    (5812, "Кафе/Рестораны"),
    (5813, "Кафе/Рестораны"),
    (5814, "Кафе/Рестораны"),
    (5931, "Одежда/Обувь"),
    (5940, "Спорт"),
    (5941, "Спорт"),
    (5948, "Одежда/Обувь"),
    (5949, "Одежда/Обувь"),
    (5995, "Питомцы"),
    (7296, "Одежда/Обувь"),
    (7372, "Прочее"),
    (7531, "Автоуслуги"),
    (7534, "Автоуслуги"),
    (7535, "Автоуслуги"),
    (7538, "Автоуслуги"),
    (7542, "Автоуслуги"),
    (7992, "Спорт"),
    (7997, "Спорт"),
    (8999, "Прочее"),
    (3990, "Подписки/Сервисы"),
];

static RE_MCC: OnceLock<Regex> = OnceLock::new();

pub fn mcc_match(description: &str) -> Option<String> {
    let re = RE_MCC.get_or_init(|| Regex::new(r"(?i)MCC\s*(\d{4})").unwrap());
    let code: u16 = re.captures(description)?.get(1)?.as_str().parse().ok()?;
    MCC_CATEGORY.iter().find(|(c, _)| *c == code).map(|(_, cat)| cat.to_string())
}

const CATEGORY_RULES: &[(&str, &[&str])] = &[
    ("Продукты", &["yarche", "lenta", "universam abrikos", "evo_fresh", "evo fresh",
        "interspar", "pyaterochka", "monetka", "mariya-ra", "mariya ra", "samokat",
        "green house", "bristol", "magnit", "diksi", "perekrestok", "vkusvill",
        "azbuka", "farmer"]),
    ("Кафе/Рестораны", &["make_love_pizza", "make love pizza", "konditerskiy",
        "domashnyaya kukhnya", "domashnyaya", "shef", "antrekot", "vkusnoitochka",
        "sibirskie bliny", "kalina", "beloe ozero", "nam pho", "restor panda",
        "tomyambar", "sibir imbir", "kincugi", "kintsugi", "elka", "izumrudnyj gorod",
        "slavica", "bezumno", "dodo", "pekarnya", "omela", "belyj krolik", "kvas",
        "cafe", "coffee", "mcdonalds", "kfc", "burger", "sushi"]),
    ("Транспорт/Такси", &["yandex*4121*go", "yandex go", "yandex*go", "whoosh",
        "taximaxim", "trc", "uber", "maxim"]),
    ("ЖКХ + Связь", &["ком. услуги", "дом-сервис", "my.ensb", "ростелеком",
        "rostelecom", "yota", "мтс", "билайн", "мегафон", "tele2", "ultravds",
        "vds", "hosting", "электроэнерг", "водоканал", "my ensb"]),
    ("Копилка/Сбережения", &["копилка", "накопительный"]),
    ("Покупки/Маркетплейс", &["ozon", "wildberries", "wb ", "petshop", "chitaj gorod",
        "amazon", "aliexpress", "lamoda", "mvideo", "eldorado", "dns", "fixprice"]),
    ("Здоровье", &["аптека", "apteka", "pharmacy", "doktor", "doctor",
        "медицин", "clinic", "стомат", "дмс", "страховани", "больниц",
        "moy doktor", "перевод франшизы по продукту дмс"]),
    ("Подписки/Сервисы", &["yandex*4816", "yandex plus", "yandex 360", "netflix",
        "spotify", "apple", "google play", "telegram", "vk music", "okko",
        "кинопоиск", "оплата по подписке"]),
    ("Развлечения", &["кино", "cinema", "театр", "museum", "музей", "лотере",
        "goodwin", "ticketmaster", "афиша"]),
    ("Спорт", &["gym", "фитнес", "fitness", "sport", "бассейн", "yoga", "super gym"]),
    ("Переводы", &["перевод сбп", "перевод ден. средств", "перевод согласно",
        "перевод ден средств",
        // Газпромбанк
        "перевод с карты на карту", "sbp c2c"]),
    // Газпромбанк: банковские комиссии
    ("Прочее", &["комиссия за предоставление услуги"]),
];

/// Входящие переводы (между своими счетами, от людей, СБП) — не доход,
/// а взаимозачёт: категория «Переводы» (по умолчанию снята с учёта).
const INCOME_TRANSFER_KEYWORDS: &[&str] = &[
    "зачисление перевода",
    "перевод со счета",
    "перевод со счёта",
    "перевод собственных средств",
    "перевод ден. средств",
    "перевод ден средств",
    "перевод с карты на карту",
];

/// Категория для входящей (is_income) транзакции: реальный доход или перевод.
pub fn income_category(description: &str) -> &'static str {
    let d = description.to_lowercase();
    if INCOME_TRANSFER_KEYWORDS.iter().any(|k| d.contains(k)) {
        "Переводы"
    } else {
        "Доход"
    }
}

pub fn keyword_match(merchant_key: &str, raw_description: &str) -> Option<String> {
    let mk = merchant_key.to_lowercase();
    let rd = raw_description.to_lowercase();
    for (cat, keywords) in CATEGORY_RULES {
        for kw in *keywords {
            if mk.contains(kw) || rd.contains(kw) {
                return Some(cat.to_string());
            }
        }
    }
    None
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct OllamaLlmResponse {
    pub category: String,
    pub confidence: f64,
    pub reasoning: String,
}


pub async fn llm_classify_async(
    raw_description: &str,
    merchant_key: &str,
    categories: &[String],
    endpoint: &str,
    api_key: &str,
    model: &str,
) -> Result<OllamaLlmResponse> {
    let cats_text = categories.iter().map(|c| format!("- {c}")).collect::<Vec<_>>().join("\n");

    let prompt = format!(
        "Категоризируй банковскую транзакцию.\n\
         Описание: \"{raw_description}\"\n\
         Мерчант: \"{merchant_key}\"\n\
         Категории:\n{cats_text}\n\
         Ответь ТОЛЬКО JSON: {{\"category\": \"<категория>\", \"confidence\": <0.0-1.0>, \"reasoning\": \"<1 предложение>\"}}"
    );

    #[derive(Serialize)]
    struct OllamaRequest<'a> {
        model: &'a str,
        messages: Vec<OllamaMessage<'a>>,
        format: &'a str,
        stream: bool,
    }
    #[derive(Serialize)]
    struct OllamaMessage<'a> {
        role: &'a str,
        content: String,
    }

    let req = OllamaRequest {
        model,
        messages: vec![OllamaMessage { role: "user", content: prompt }],
        format: "json",
        stream: false,
    };

    let endpoint = endpoint.replace("localhost", "127.0.0.1");
    let url = format!("{}/api/chat", endpoint.trim_end_matches('/'));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .build()?;

    let mut builder = client.post(&url).json(&req);
    if !api_key.is_empty() {
        builder = builder.header("Authorization", format!("Bearer {}", api_key));
    }

    let resp: serde_json::Value = builder.send().await?.json().await?;

    let content = resp["message"]["content"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("no content in ollama response"))?;

    Ok(serde_json::from_str(content)?)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CategorizedTx {
    pub tx: Transaction,
    pub source: String,
    pub confidence: Option<f64>,
    pub reasoning: Option<String>,
}

