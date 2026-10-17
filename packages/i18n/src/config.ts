export const SUPPORTED_LOCALES = [
  "en-US",
  "en-GB",
  "en-AU",
  "fr-FR",
  "zh-CN",
  "id-ID",
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = "en-US";

export const FALLBACK_CHAIN: Record<SupportedLocale, SupportedLocale[]> = {
  "en-US": [],
  "en-GB": ["en-US"],
  "en-AU": ["en-GB", "en-US"],
  "fr-FR": ["en-US"],
  "zh-CN": ["en-US"],
  "id-ID": ["en-US"],
};

export const LOCALE_DISPLAY: Record<
  SupportedLocale,
  { label: string; nativeName: string; flag: string }
> = {
  "en-US": { label: "English (US)", nativeName: "English (US)", flag: "🇺🇸" },
  "en-GB": { label: "English (UK)", nativeName: "English (UK)", flag: "🇬🇧" },
  "en-AU": { label: "English (AU)", nativeName: "English (Australia)", flag: "🇦🇺" },
  "fr-FR": { label: "French", nativeName: "Français", flag: "🇫🇷" },
  "zh-CN": { label: "Chinese (Simplified)", nativeName: "简体中文", flag: "🇨🇳" },
  "id-ID": { label: "Indonesian", nativeName: "Bahasa Indonesia", flag: "🇮🇩" },
};

export const NAMESPACES = [
  "common",
  "auth",
  "navigation",
  "dashboard",
  "incidents",
  "runbooks",
  "settings",
  "agents",
  "errors",
  "emails",
] as const;

export type Namespace = (typeof NAMESPACES)[number];

export const DEFAULT_NAMESPACE: Namespace = "common";

export const LOCALE_STORAGE_KEY = "bitsentry.locale";

export const BACKEND_LANG_HEADER = "x-custom-lang";

const FULL_TO_BACKEND: Record<SupportedLocale, string> = {
  "en-US": "en",
  "en-GB": "en-GB",
  "en-AU": "en-AU",
  "fr-FR": "fr",
  "zh-CN": "zh",
  "id-ID": "id",
};

export function mapLocaleToBackendCode(locale: SupportedLocale): string {
  return FULL_TO_BACKEND[locale];
}

export function isSupportedLocale(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function resolveSupportedLocale(
  candidate: string | null | undefined,
): SupportedLocale | null {
  if (candidate === undefined || candidate === null || candidate === "") {
    return null;
  }

  if (isSupportedLocale(candidate)) return candidate;
  const lower = candidate.toLowerCase();
  for (const locale of SUPPORTED_LOCALES) {
    if (locale.toLowerCase() === lower) return locale;
  }
  const prefix = lower.split("-")[0];
  const match = SUPPORTED_LOCALES.find((l) => l.toLowerCase().startsWith(prefix + "-"));
  return match ?? null;
}
