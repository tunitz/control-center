import type { Database } from "bun:sqlite";
import { getSetting } from "./db";

export const DEFAULT_TIMEZONE = "UTC";
export const DEFAULT_CURRENCY_CODE = "USD";
export const DEFAULT_CURRENCY_SYMBOL = "$";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Validate an IANA timezone identifier via Intl.DateTimeFormat. */
export function isValidTimezone(tz: string): boolean {
  if (!tz || typeof tz !== "string" || !tz.trim()) return false;
  try {
    formatter(tz.trim());
    return true;
  } catch {
    return false;
  }
}

/** Configured IANA timezone from settings, falling back to CC_TIMEZONE or UTC. */
export function getTimezone(db: Database): string {
  const stored = getSetting(db, "timezone", "").trim();
  if (stored && isValidTimezone(stored)) return stored;
  const env = process.env.CC_TIMEZONE?.trim() ?? "";
  if (env && isValidTimezone(env)) return env;
  return DEFAULT_TIMEZONE;
}

/** Configured display currency code and symbol, falling back to env or USD / $. */
export function getCurrency(db: Database): { code: string; symbol: string } {
  const storedCode = getSetting(db, "currency_code", "").trim();
  const storedSym = getSetting(db, "currency_symbol", "").trim();
  const envCode = process.env.CC_CURRENCY?.trim() ?? "";
  const envSym = process.env.CC_CURRENCY_SYMBOL?.trim() ?? "";
  return {
    code: storedCode || envCode || DEFAULT_CURRENCY_CODE,
    symbol: storedSym || envSym || DEFAULT_CURRENCY_SYMBOL,
  };
}

function partsInZone(ts: number, tz: string) {
  const whole = Math.floor(ts);
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(whole * 1000))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  const hour = out.hour === 24 ? 0 : out.hour;
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour,
    minute: out.minute,
    second: out.second,
  };
}

function offsetAt(ts: number, tz: string): number {
  const whole = Math.floor(ts);
  const p = partsInZone(whole, tz);
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000) - whole;
}

/** Calendar month key (`YYYY-MM`) for an epoch-second timestamp in `tz`. */
export function monthKey(ts: number, tz: string = DEFAULT_TIMEZONE): string {
  const p = partsInZone(ts, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}`;
}

/** Start of a calendar day (`YYYY-MM-DD`) in `tz`, as UTC epoch seconds. */
export function dayStart(day: string, tz: string = DEFAULT_TIMEZONE): number {
  const [y, m, d] = day.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d) / 1000;
  const first = naive - offsetAt(naive, tz);
  return naive - offsetAt(first, tz);
}

/** Exclusive end of a calendar day (`YYYY-MM-DD`) in `tz`, as UTC epoch seconds. */
export function dayEnd(day: string, tz: string = DEFAULT_TIMEZONE): number {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  const next = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  return dayStart(next, tz);
}

/** Start of a billing month (`YYYY-MM`) in `tz`, as UTC epoch seconds. */
export function monthStart(month: string, tz: string = DEFAULT_TIMEZONE): number {
  const [y, m] = month.split("-").map(Number);
  return dayStart(`${y}-${String(m).padStart(2, "0")}-01`, tz);
}

/** Local weekday (0=Sunday) and minute-of-day in `tz` for an epoch-second timestamp. */
export function localTime(ts: number, tz: string = DEFAULT_TIMEZONE): { weekday: number; minute: number } {
  const p = partsInZone(ts, tz);
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return { weekday, minute: p.hour * 60 + p.minute };
}
