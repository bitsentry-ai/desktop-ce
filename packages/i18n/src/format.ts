import { useMemo } from "react";

import { DEFAULT_LOCALE, type SupportedLocale } from "./config";
import { useLocale } from "./hooks";

/**
 * Locale-aware formatting helpers built on the platform `Intl` namespace.
 *
 * Use the `useFormatters()` hook in components; use the standalone functions
 * in non-React contexts. Both honor the active i18next locale.
 */

const dtfCache = new Map<string, Intl.DateTimeFormat>();
const nfCache = new Map<string, Intl.NumberFormat>();
const rtfCache = new Map<string, Intl.RelativeTimeFormat>();

function dtf(
  locale: SupportedLocale,
  options: Intl.DateTimeFormatOptions = {},
): Intl.DateTimeFormat {
  const key = locale + "|" + JSON.stringify(options);
  let f = dtfCache.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat(locale, options);
    dtfCache.set(key, f);
  }
  return f;
}

function nf(
  locale: SupportedLocale,
  options: Intl.NumberFormatOptions = {},
): Intl.NumberFormat {
  const key = locale + "|" + JSON.stringify(options);
  let f = nfCache.get(key);
  if (f === undefined) {
    f = new Intl.NumberFormat(locale, options);
    nfCache.set(key, f);
  }
  return f;
}

function rtf(
  locale: SupportedLocale,
  options: Intl.RelativeTimeFormatOptions = { numeric: "auto" },
): Intl.RelativeTimeFormat {
  const key = locale + "|" + JSON.stringify(options);
  let f = rtfCache.get(key);
  if (f === undefined) {
    f = new Intl.RelativeTimeFormat(locale, options);
    rtfCache.set(key, f);
  }
  return f;
}

type DateInput = Date | string | number;

function toDate(value: DateInput): Date {
  if (value instanceof Date) {
    return value;
  }

  return new Date(value);
}

export function formatDate(
  value: DateInput,
  locale: SupportedLocale = DEFAULT_LOCALE,
  style: Intl.DateTimeFormatOptions["dateStyle"] = "medium",
): string {
  return dtf(locale, { dateStyle: style }).format(toDate(value));
}

export function formatTime(
  value: DateInput,
  locale: SupportedLocale = DEFAULT_LOCALE,
  style: Intl.DateTimeFormatOptions["timeStyle"] = "short",
): string {
  return dtf(locale, { timeStyle: style }).format(toDate(value));
}

export function formatDateTime(
  value: DateInput,
  locale: SupportedLocale = DEFAULT_LOCALE,
  options: { dateStyle?: Intl.DateTimeFormatOptions["dateStyle"]; timeStyle?: Intl.DateTimeFormatOptions["timeStyle"] } = {
    dateStyle: "medium",
    timeStyle: "short",
  },
): string {
  return dtf(locale, options).format(toDate(value));
}

export function formatNumber(
  value: number,
  locale: SupportedLocale = DEFAULT_LOCALE,
  options: Intl.NumberFormatOptions = {},
): string {
  return nf(locale, options).format(value);
}

export function formatPercent(
  value: number,
  locale: SupportedLocale = DEFAULT_LOCALE,
  fractionDigits = 0,
): string {
  return nf(locale, {
    style: "percent",
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export function formatCompact(
  value: number,
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  return nf(locale, { notation: "compact" }).format(value);
}

const RTF_THRESHOLDS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/**
 * Locale-aware "X minutes ago" / "in 2 hours" formatter.
 * Replaces ad-hoc `${mins}m ago` strings scattered through the codebase.
 */
export function formatRelativeTime(
  value: DateInput,
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  const target = toDate(value).getTime();
  const now = Date.now();
  const diffSec = Math.round((target - now) / 1000);
  const absSec = Math.abs(diffSec);
  for (const [unit, threshold] of RTF_THRESHOLDS) {
    if (absSec >= threshold || unit === "second") {
      const v = Math.round(diffSec / threshold);
      return rtf(locale).format(v, unit);
    }
  }
  return rtf(locale).format(diffSec, "second");
}

export interface Formatters {
  date: (value: DateInput, style?: Intl.DateTimeFormatOptions["dateStyle"]) => string;
  time: (value: DateInput, style?: Intl.DateTimeFormatOptions["timeStyle"]) => string;
  dateTime: (
    value: DateInput,
    options?: { dateStyle?: Intl.DateTimeFormatOptions["dateStyle"]; timeStyle?: Intl.DateTimeFormatOptions["timeStyle"] },
  ) => string;
  number: (value: number, options?: Intl.NumberFormatOptions) => string;
  percent: (value: number, fractionDigits?: number) => string;
  compact: (value: number) => string;
  relativeTime: (value: Date | string | number) => string;
  locale: SupportedLocale;
}

/**
 * React hook returning locale-aware formatters bound to the current i18next
 * locale. Re-renders when the user switches language.
 */
export function useFormatters(): Formatters {
  const { locale } = useLocale();
  return useMemo<Formatters>(
    () => ({
      date: (v, s) => formatDate(v, locale, s),
      time: (v, s) => formatTime(v, locale, s),
      dateTime: (v, o) => formatDateTime(v, locale, o),
      number: (v, o) => formatNumber(v, locale, o),
      percent: (v, f) => formatPercent(v, locale, f),
      compact: (v) => formatCompact(v, locale),
      relativeTime: (v) => formatRelativeTime(v, locale),
      locale,
    }),
    [locale],
  );
}
