use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::db::{MerchantCache, Transaction};

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
        "перевод ден средств"]),
];

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
    category: String,
    confidence: f64,
    reasoning: String,
}


pub fn llm_classify(
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

    let mut builder = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()?
        .post(&url)
        .json(&req);

    if !api_key.is_empty() {
        builder = builder.header("Authorization", format!("Bearer {}", api_key));
    }

    let resp: serde_json::Value = builder.send()?.json()?;

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

pub fn categorize_one(
    tx: &Transaction,
    conn: &rusqlite::Connection,
    categories: &[String],
    merchant_index: &mut crate::normalizer::MerchantIndex,
    endpoint: &str,
    api_key: &str,
    model: &str,
) -> Result<CategorizedTx> {
    let mk = merchant_index.resolve(&tx.merchant_key);

    // 1. Keyword match
    if let Some(cat) = keyword_match(&mk, &tx.description) {
        let mc = MerchantCache {
            merchant_key: mk.clone(),
            category: cat.clone(),
            source: "keyword".to_string(),
            confidence: Some(1.0),
            reasoning: Some("keyword match".to_string()),
        };
        crate::db::upsert_merchant(conn, &mc).ok();
        return Ok(CategorizedTx {
            tx: Transaction { merchant_key: mk, category: cat, ..tx.clone() },
            source: "keyword".to_string(),
            confidence: Some(1.0),
            reasoning: Some("keyword match".to_string()),
        });
    }

    // 2. Cache lookup
    if let Ok(Some(cached)) = crate::db::cache_lookup(conn, &mk) {
        return Ok(CategorizedTx {
            tx: Transaction { merchant_key: mk, category: cached.category.clone(), ..tx.clone() },
            source: cached.source.clone(),
            confidence: cached.confidence,
            reasoning: cached.reasoning.clone(),
        });
    }

    // 3. Ollama
    let (category, confidence, reasoning) = match llm_classify(&tx.description, &mk, categories, endpoint, api_key, model) {
        Ok(r) => {
            let cat = if categories.contains(&r.category) { r.category } else { "Прочее".to_string() };
            (cat, Some(r.confidence), Some(r.reasoning))
        }
        Err(e) => {
            eprintln!("[LLM] error for {mk}: {e}");
            ("Прочее".to_string(), Some(0.0), Some("ошибка классификации".to_string()))
        }
    };

    let mc = MerchantCache {
        merchant_key: mk.clone(),
        category: category.clone(),
        source: "llm".to_string(),
        confidence,
        reasoning: reasoning.clone(),
    };
    crate::db::upsert_merchant(conn, &mc).ok();

    Ok(CategorizedTx {
        tx: Transaction { merchant_key: mk, category: category.clone(), ..tx.clone() },
        source: "llm".to_string(),
        confidence,
        reasoning,
    })
}
