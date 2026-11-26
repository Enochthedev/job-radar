import type { RawJob } from "./types.js";

type Sal = Pick<RawJob, "salaryMin" | "salaryMax" | "currency" | "salaryPeriod">;

/** Parses free-text like "$57K - $67K", "€80,000–100,000", "$40/hr". Returns nulls if unsure. */
export function parseSalaryText(s: string | null | undefined): Sal {
  const empty: Sal = { salaryMin: null, salaryMax: null, currency: null, salaryPeriod: null };
  if (!s) return empty;
  const currency = /€|eur/i.test(s) ? "EUR" : /£|gbp/i.test(s) ? "GBP" : /\$|usd/i.test(s) ? "USD" : null;
  const nums = [...s.matchAll(/(\d[\d,.]*)\s*(k)?/gi)]
    .map((m) => {
      // "4.000" / "4.000,50" use dots for thousands (European style).
      const raw = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(m[1]) ? m[1].replace(/\./g, "").replace(",", ".") : m[1].replace(/,/g, "");
      let n = Number(raw);
      if (m[2]) n *= 1000;
      return n;
    })
    .filter((n) => n > 0);
  if (!nums.length || !currency) return empty;
  const period = /\/\s*h(ou)?r\b|hourly|per hour|an hour|a hour/i.test(s) ? "hour" : /\/\s*mo\b|month|\bpm\b|per mo\b/i.test(s) ? "month" : "year";
  return { salaryMin: Math.round(Math.min(...nums)), salaryMax: Math.round(Math.max(...nums)), currency, salaryPeriod: period };
}

/** Normalises to a yearly figure in USD-ish units (rough FX; only used for the pay floor signal). */
export function yearlyUsd(amount: number | null | undefined, currency: string | null | undefined, period: string | null | undefined): number | null {
  if (!amount) return null;
  const fx: Record<string, number> = { USD: 1, EUR: 1.08, GBP: 1.27, CAD: 0.73, AUD: 0.66 };
  const rate = fx[(currency ?? "USD").toUpperCase()] ?? 1;
  const mult = period === "hour" ? 2000 : period === "month" ? 12 : 1;
  return Math.round(amount * mult * rate);
}

const MONEY = String.raw`(?:[$€£]|usd|eur|gbp)\s?\d[\d,.]*\s?k?`;
const RANGE = new RegExp(String.raw`${MONEY}(?:\s?(?:-|–|—|to)\s?(?:[$€£]|usd|eur|gbp)?\s?\d[\d,.]*\s?k?)?`, "i");

/**
 * Finds the first pay figure in free text and keeps the words right after it, so
 * "$3,000–4,000/month" or "$40 per hour" carries its period into parseSalaryText.
 */
export function findSalary(text: string | null | undefined): Sal {
  if (!text) return { salaryMin: null, salaryMax: null, currency: null, salaryPeriod: null };
  const m = RANGE.exec(text);
  if (!m) return { salaryMin: null, salaryMax: null, currency: null, salaryPeriod: null };
  const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 30);
  const period = /^\s*(\/\s*(h(ou)?r|mo(nth)?|yr|year|annum)|per\s+(hour|month|year|annum)|(an?|each)\s+(hour|month|year)|hourly|monthly|annual(ly)?|p\.?a\.?|pm\b)/i.exec(tail);
  return parseSalaryText(period ? `${m[0]} ${period[0]}` : m[0]);
}
