import type { RawJob } from "./types.js";

type Sal = Pick<RawJob, "salaryMin" | "salaryMax" | "currency" | "salaryPeriod">;

/** Parses free-text like "$57K - $67K", "€80,000–100,000", "$40/hr". Returns nulls if unsure. */
export function parseSalaryText(s: string | null | undefined): Sal {
  const empty: Sal = { salaryMin: null, salaryMax: null, currency: null, salaryPeriod: null };
  if (!s) return empty;
  const currency = /€|eur/i.test(s) ? "EUR" : /£|gbp/i.test(s) ? "GBP" : /\$|usd/i.test(s) ? "USD" : null;
  const nums = [...s.matchAll(/(\d[\d,.]*)\s*(k)?/gi)]
    .map((m) => {
      let n = Number(m[1].replace(/,/g, ""));
      if (m[2]) n *= 1000;
      return n;
    })
    .filter((n) => n > 0);
  if (!nums.length || !currency) return empty;
  const period = /\/\s*h(ou)?r|hourly|per hour/i.test(s) ? "hour" : /\/\s*mo|month/i.test(s) ? "month" : "year";
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
