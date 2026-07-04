//! Финансовая математика по кредитам и кредитным картам.
//! Чистые функции без обращения к БД — вся арифметика проекта живёт в Rust.

use chrono::{Datelike, Months, NaiveDate};
use serde::Serialize;

/// Месячная ставка из годовой в процентах (20% годовых → 0.0166…).
pub fn monthly_rate(annual: f64) -> f64 {
    annual / 100.0 / 12.0
}

/// Аннуитетный платёж: P·r·(1+r)^n / ((1+r)^n − 1). При r≈0 → P/n.
pub fn annuity_payment(principal: f64, annual: f64, months: i64) -> f64 {
    if months <= 0 {
        return principal.max(0.0);
    }
    let r = monthly_rate(annual);
    if r.abs() < 1e-9 {
        return principal / months as f64;
    }
    let pow = (1.0 + r).powi(months as i32);
    principal * r * pow / (pow - 1.0)
}

/// Разбивка платежа: сначала проценты на остаток, остальное — в тело.
/// Возвращает (проценты, тело), тело не превышает остаток.
pub fn split_payment(balance: f64, annual: f64, payment: f64) -> (f64, f64) {
    let payment = payment.max(0.0);
    let interest = (balance.max(0.0) * monthly_rate(annual)).max(0.0).min(payment);
    let principal = (payment - interest).max(0.0).min(balance.max(0.0));
    (interest, principal)
}

#[derive(Debug, Serialize, Clone)]
pub struct Projection {
    /// Осталось платежей. -1 = платёж не покрывает проценты (долг не гасится).
    pub months: i64,
    pub total_interest: f64,
    pub payoff_date: Option<String>,
}

/// Прогноз погашения по текущему остатку и месячному платежу.
/// months = ceil( −ln(1 − B·r/M) / ln(1+r) ).
pub fn payoff_projection(
    balance: f64,
    annual: f64,
    monthly_payment: f64,
    from: &str,
    payment_day: Option<i64>,
) -> Projection {
    if balance <= 0.005 {
        return Projection { months: 0, total_interest: 0.0, payoff_date: None };
    }
    let r = monthly_rate(annual);
    let months = if r.abs() < 1e-9 {
        (balance / monthly_payment).ceil() as i64
    } else {
        let first_interest = balance * r;
        if monthly_payment <= first_interest + 1e-9 {
            // Платёж не покрывает даже проценты — кредит не гасится.
            return Projection { months: -1, total_interest: f64::INFINITY, payoff_date: None };
        }
        (-(1.0 - balance * r / monthly_payment).ln() / (1.0 + r).ln()).ceil() as i64
    };
    let total_interest = (monthly_payment * months as f64 - balance).max(0.0);
    let payoff_date = add_months_from(from, months, payment_day);
    Projection { months, total_interest, payoff_date }
}

#[derive(Debug, Serialize, Clone)]
pub struct ScheduleRow {
    pub n: i64,
    pub date: Option<String>,
    pub payment: f64,
    pub interest: f64,
    pub principal: f64,
    pub balance_after: f64,
}

/// Прогнозный график платежей вперёд от текущего остатка (cap 480 строк).
pub fn schedule(
    balance: f64,
    annual: f64,
    monthly_payment: f64,
    from: &str,
    payment_day: Option<i64>,
) -> Vec<ScheduleRow> {
    let mut rows = Vec::new();
    let r = monthly_rate(annual);
    let mut bal = balance;
    let mut n: i64 = 0;
    let cap = 480;
    while bal > 0.005 && n < cap {
        n += 1;
        let interest = bal * r;
        let mut principal = monthly_payment - interest;
        if principal <= 0.0 {
            break; // платёж не покрывает проценты
        }
        if principal > bal {
            principal = bal;
        }
        let pay = interest + principal;
        bal -= principal;
        rows.push(ScheduleRow {
            n,
            date: add_months_from(from, n, payment_day),
            payment: pay,
            interest,
            principal,
            balance_after: bal.max(0.0),
        });
    }
    rows
}

// ─── Стратегия погашения ────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SimLoan {
    pub balance: f64,
    pub rate_annual: f64,
    pub payment: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoanMonthDetail {
    pub scheduled_paid: f64, // фактический плановый платёж месяца (0, если кредит закрыт)
    pub extra_paid: f64,     // досрочка, ушедшая в этот кредит в этом месяце
    pub balance_after: f64,
}

#[derive(Debug)]
pub struct SimResult {
    /// Месяцев до полного погашения; -1, если долг не гасится.
    pub months: i64,
    pub total_interest: f64,
    /// Суммарный долг ПОСЛЕ каждого месяца (индекс 0 = после 1-го месяца).
    pub debt_by_month: Vec<f64>,
    /// Детализация: месяц → платежи/досрочка по каждому кредиту (в порядке входа).
    pub monthly_detail: Vec<Vec<LoanMonthDetail>>,
}

/// Помесячная симуляция гашения набора кредитов методом «лавина»:
/// минимальные платежи по всем, досрочка + высвободившиеся платежи закрытых
/// кредитов — в кредит с максимальной ставкой. Досрочка задаётся расписанием
/// по месяцам; для месяцев за пределами массива берётся последнее значение
/// (пустой массив = без досрочки).
pub fn simulate_repayment_schedule(loans: &[SimLoan], extra_by_month: &[f64]) -> SimResult {
    if loans.is_empty() {
        return SimResult { months: 0, total_interest: 0.0, debt_by_month: vec![], monthly_detail: vec![] };
    }
    let mut bals: Vec<f64> = loans.iter().map(|l| l.balance).collect();
    let mut order: Vec<usize> = (0..loans.len()).collect();
    order.sort_by(|&a, &b| {
        loans[b].rate_annual
            .partial_cmp(&loans[a].rate_annual)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut months: i64 = 0;
    let mut interest_total = 0.0;
    let mut debt_by_month: Vec<f64> = Vec::new();
    let mut monthly_detail: Vec<Vec<LoanMonthDetail>> = Vec::new();
    let tail_extra = extra_by_month.last().copied().unwrap_or(0.0);
    const CAP: i64 = 600;

    while bals.iter().any(|b| *b > 0.005) && months < CAP {
        months += 1;
        let mut pool = extra_by_month
            .get((months - 1) as usize)
            .copied()
            .unwrap_or(tail_extra)
            .max(0.0);
        let mut detail: Vec<LoanMonthDetail> = loans.iter()
            .map(|_| LoanMonthDetail { scheduled_paid: 0.0, extra_paid: 0.0, balance_after: 0.0 })
            .collect();

        for i in 0..loans.len() {
            if bals[i] <= 0.005 {
                // Кредит закрыт — его платёж работает на остальные (rollover)
                pool += loans[i].payment;
                continue;
            }
            let interest = bals[i] * monthly_rate(loans[i].rate_annual);
            interest_total += interest;
            let principal = (loans[i].payment - interest).max(0.0).min(bals[i]);
            bals[i] -= principal;
            let used = interest + principal;
            detail[i].scheduled_paid = used;
            if used < loans[i].payment {
                pool += loans[i].payment - used; // хвост последнего платежа
            }
        }

        // Досрочка в самый дорогой открытый кредит
        for &i in &order {
            if pool <= 0.005 { break; }
            if bals[i] > 0.005 {
                let pay = pool.min(bals[i]);
                bals[i] -= pay;
                pool -= pay;
                detail[i].extra_paid += pay;
            }
        }

        for i in 0..loans.len() {
            detail[i].balance_after = bals[i].max(0.0);
        }
        monthly_detail.push(detail);
        debt_by_month.push(bals.iter().sum::<f64>().max(0.0));
    }

    let months = if bals.iter().any(|b| *b > 0.005) { -1 } else { months };
    SimResult { months, total_interest: interest_total, debt_by_month, monthly_detail }
}

/// Упрощённый вариант с постоянной ежемесячной досрочкой.
pub fn simulate_repayment(loans: &[SimLoan], extra_monthly: f64) -> (i64, f64) {
    let r = simulate_repayment_schedule(loans, &[extra_monthly]);
    (r.months, r.total_interest)
}

/// Льготный период карты: до какой даты действует и сколько дней осталось.
/// Считаем от последней даты выписки (statement_day) + grace_days.
pub fn grace_status(from: &str, statement_day: i64, grace_days: i64) -> (Option<String>, Option<i64>) {
    let today = match parse_date(from) {
        Some(d) => d,
        None => return (None, None),
    };
    let this = set_day_clamped(today, statement_day as u32);
    let last_stmt = if this <= today {
        this
    } else {
        match today.checked_sub_months(Months::new(1)) {
            Some(d) => set_day_clamped(d, statement_day as u32),
            None => return (None, None),
        }
    };
    let until = last_stmt + chrono::Duration::days(grace_days.max(0));
    let days_left = (until - today).num_days();
    (Some(until.format("%Y-%m-%d").to_string()), Some(days_left))
}

/// Дата через n месяцев от указанной (для дат освобождения от долгов).
pub fn date_after_months(from: &str, n: i64) -> Option<String> {
    add_months_from(from, n, None)
}

/// Ближайшая будущая (или сегодняшняя) дата с днём = payment_day.
pub fn next_payment_date(from: &str, payment_day: i64) -> Option<String> {
    let today = parse_date(from)?;
    let this = set_day_clamped(today, payment_day as u32);
    let d = if this >= today {
        this
    } else {
        let next = today.checked_add_months(Months::new(1))?;
        set_day_clamped(next, payment_day as u32)
    };
    Some(d.format("%Y-%m-%d").to_string())
}

// ─── helpers ────────────────────────────────────────────────────────────────

fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(&s[..s.len().min(10)], "%Y-%m-%d").ok()
}

fn last_day_of_month(year: i32, month: u32) -> u32 {
    let (ny, nm) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    let first_next = NaiveDate::from_ymd_opt(ny, nm, 1).unwrap();
    first_next.pred_opt().unwrap().day()
}

fn set_day_clamped(d: NaiveDate, day: u32) -> NaiveDate {
    let last = last_day_of_month(d.year(), d.month());
    let day = day.clamp(1, last);
    NaiveDate::from_ymd_opt(d.year(), d.month(), day).unwrap_or(d)
}

fn add_months_from(from: &str, n: i64, payment_day: Option<i64>) -> Option<String> {
    if n < 0 {
        return None;
    }
    let base = parse_date(from)?;
    let d = base.checked_add_months(Months::new(n as u32))?;
    let d = match payment_day {
        Some(day) => set_day_clamped(d, day as u32),
        None => d,
    };
    Some(d.format("%Y-%m-%d").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn annuity_reference() {
        let m = annuity_payment(1_000_000.0, 20.0, 60);
        assert!((m - 26_493.88).abs() < 0.5, "got {m}");
    }

    #[test]
    fn annuity_zero_rate() {
        let m = annuity_payment(120_000.0, 0.0, 12);
        assert!((m - 10_000.0).abs() < 1e-6, "got {m}");
    }

    #[test]
    fn payoff_matches_term() {
        let m = annuity_payment(1_000_000.0, 20.0, 60);
        let p = payoff_projection(1_000_000.0, 20.0, m, "2026-01-01", Some(1));
        assert_eq!(p.months, 60);
        assert!((p.total_interest - 589_633.0).abs() < 5.0, "got {}", p.total_interest);
    }

    #[test]
    fn split_first_payment() {
        let (interest, principal) = split_payment(1_000_000.0, 20.0, 26_493.88);
        assert!((interest - 16_666.67).abs() < 0.5, "interest {interest}");
        assert!((principal - 9_827.21).abs() < 0.5, "principal {principal}");
    }

    #[test]
    fn payment_below_interest_never_pays_off() {
        let p = payoff_projection(1_000_000.0, 20.0, 1_000.0, "2026-01-01", Some(1));
        assert_eq!(p.months, -1);
    }

    #[test]
    fn schedule_ends_at_zero() {
        let m = annuity_payment(300_000.0, 15.0, 24);
        let rows = schedule(300_000.0, 15.0, m, "2026-01-01", Some(10));
        assert_eq!(rows.len(), 24);
        assert!(rows.last().unwrap().balance_after < 1.0);
    }

    #[test]
    fn simulation_matches_projection_without_extra() {
        // Один кредит без досрочки — симуляция сходится с аналитикой
        let m = annuity_payment(300_000.0, 18.0, 36);
        let loans = [SimLoan { balance: 300_000.0, rate_annual: 18.0, payment: m }];
        let (months, interest) = simulate_repayment(&loans, 0.0);
        let proj = payoff_projection(300_000.0, 18.0, m, "2026-01-01", None);
        assert_eq!(months, proj.months);
        assert!((interest - proj.total_interest).abs() < m, "sim {interest} vs proj {}", proj.total_interest);
    }

    #[test]
    fn extra_payment_saves_interest_and_time() {
        let loans = [
            SimLoan { balance: 250_000.0, rate_annual: 25.0, payment: 9_000.0 },
            SimLoan { balance: 100_000.0, rate_annual: 12.0, payment: 5_000.0 },
        ];
        let (m0, i0) = simulate_repayment(&loans, 0.0);
        let (m1, i1) = simulate_repayment(&loans, 10_000.0);
        assert!(m1 < m0, "months {m1} !< {m0}");
        assert!(i1 < i0, "interest {i1} !< {i0}");
    }

    #[test]
    fn rollover_accelerates_after_first_closes() {
        // После закрытия мелкого кредита его платёж должен уходить в крупный:
        // сравниваем с "без rollover" = сумма независимых проекций по месяцам
        let small = SimLoan { balance: 20_000.0, rate_annual: 30.0, payment: 5_000.0 };
        let big   = SimLoan { balance: 200_000.0, rate_annual: 20.0, payment: 6_000.0 };
        let (months, _) = simulate_repayment(&[small.clone(), big.clone()], 0.0);
        let solo_big = payoff_projection(big.balance, big.rate_annual, big.payment, "2026-01-01", None);
        assert!(months < solo_big.months, "rollover must beat solo big: {months} !< {}", solo_big.months);
    }

    #[test]
    fn schedule_zeroes_equals_baseline_and_trajectory_declines() {
        let loans = [
            SimLoan { balance: 150_000.0, rate_annual: 22.0, payment: 7_000.0 },
            SimLoan { balance: 50_000.0, rate_annual: 15.0, payment: 3_000.0 },
        ];
        let base = simulate_repayment_schedule(&loans, &[]);
        let (m, i) = simulate_repayment(&loans, 0.0);
        assert_eq!(base.months, m);
        assert!((base.total_interest - i).abs() < 0.01);
        // Траектория долга монотонно убывает и заканчивается нулём
        assert!(base.debt_by_month.windows(2).all(|w| w[1] <= w[0] + 0.01));
        assert!(*base.debt_by_month.last().unwrap() < 0.01);
        // Досрочка только с 4-го месяца: первые 3 месяца совпадают с baseline
        let later = simulate_repayment_schedule(&loans, &[0.0, 0.0, 0.0, 15_000.0]);
        assert!((later.debt_by_month[2] - base.debt_by_month[2]).abs() < 0.01);
        assert!(later.debt_by_month[3] < base.debt_by_month[3]);
        assert!(later.months < base.months);
    }

    #[test]
    fn monthly_detail_allocates_extra_to_highest_rate() {
        let loans = [
            SimLoan { balance: 100_000.0, rate_annual: 10.0, payment: 5_000.0 }, // дешёвый
            SimLoan { balance: 100_000.0, rate_annual: 30.0, payment: 5_000.0 }, // дорогой
        ];
        let r = simulate_repayment_schedule(&loans, &[7_000.0]);
        // Пока дорогой кредит жив — вся досрочка уходит в него (индекс 1)
        let first = &r.monthly_detail[0];
        assert!((first[1].extra_paid - 7_000.0).abs() < 0.01, "extra to hi-rate: {}", first[1].extra_paid);
        assert!(first[0].extra_paid.abs() < 0.01);
        // Сумма досрочки месяца = выданный extra (пока оба живы)
        let total_extra: f64 = first.iter().map(|d| d.extra_paid).sum();
        assert!((total_extra - 7_000.0).abs() < 0.01);
        // После закрытия дорогого досрочка перетекает в дешёвый
        let switch = r.monthly_detail.iter()
            .find(|m| m[1].balance_after < 0.01 && m[0].balance_after > 0.01);
        assert!(switch.is_some(), "must have a month after hi-rate closes");
        let later = r.monthly_detail.iter()
            .find(|m| m[1].balance_after < 0.01 && m[0].extra_paid > 0.0);
        assert!(later.is_some(), "extra must flow to cheap loan after hi-rate closes");
    }

    #[test]
    fn underwater_returns_minus_one() {
        let loans = [SimLoan { balance: 1_000_000.0, rate_annual: 30.0, payment: 1_000.0 }];
        let (months, _) = simulate_repayment(&loans, 0.0);
        assert_eq!(months, -1);
    }

    #[test]
    fn next_payment_day_rolls_forward() {
        // 15-е уже прошло в этом месяце → следующий месяц
        assert_eq!(next_payment_date("2026-03-20", 15).as_deref(), Some("2026-04-15"));
        // 25-е ещё впереди → этот месяц
        assert_eq!(next_payment_date("2026-03-20", 25).as_deref(), Some("2026-03-25"));
    }
}
