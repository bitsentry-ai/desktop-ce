export {
  BACKEND_LANG_HEADER,
  DEFAULT_LOCALE,
  DEFAULT_NAMESPACE,
  FALLBACK_CHAIN,
  LOCALE_DISPLAY,
  LOCALE_STORAGE_KEY,
  NAMESPACES,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  mapLocaleToBackendCode,
  resolveSupportedLocale,
  type Namespace,
  type SupportedLocale,
} from "./config";

export {
  createI18nInstance,
  fallbackLng,
  getSharedI18nInstance,
  loadNamespaces,
  type CreateI18nOptions,
} from "./instance";

export { I18nProvider, type I18nProviderProps } from "./provider";

export { getCurrentLocale, useLocale, useTranslation, type UseLocaleResult } from "./hooks";

export {
  formatDate,
  formatTime,
  formatDateTime,
  formatNumber,
  formatPercent,
  formatCompact,
  formatRelativeTime,
  useFormatters,
  type Formatters,
} from "./format";
