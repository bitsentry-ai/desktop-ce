import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { I18nextProvider } from "react-i18next";

import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  resolveSupportedLocale,
  type SupportedLocale,
} from "./config";
import {
  ensureLocaleResources,
  getSharedI18nInstance,
  hasLocaleResources,
} from "./instance";

export interface I18nProviderProps {
  children: ReactNode;
  locale?: SupportedLocale;
  detectLocale?: boolean;
  /** Shown while a locale that is not bundled downloads. */
  fallback?: ReactNode;
}

function resolveInitialLocale(
  locale: SupportedLocale | undefined,
  detectLocale: boolean,
): SupportedLocale {
  if (locale !== undefined) {
    return locale;
  }

  const storedLocale = readStoredLocale();
  if (storedLocale !== null) {
    return storedLocale;
  }

  if (detectLocale) {
    const navigatorLocale = readNavigatorLocale();
    if (navigatorLocale !== null) {
      return navigatorLocale;
    }
  }

  return DEFAULT_LOCALE;
}

function readStoredLocale(): SupportedLocale | null {
  if (typeof window === "undefined") return null;
  try {
    return resolveSupportedLocale(
      window.localStorage.getItem(LOCALE_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

function readNavigatorLocale(): SupportedLocale | null {
  if (typeof navigator === "undefined") return null;
  return resolveSupportedLocale(navigator.language);
}

export function I18nProvider({
  children,
  locale,
  detectLocale = true,
  fallback,
}: I18nProviderProps) {
  const initialLocale = useMemo<SupportedLocale>(
    () => resolveInitialLocale(locale, detectLocale),
    [locale, detectLocale],
  );

  const instance = useMemo(
    () => getSharedI18nInstance({ locale: initialLocale, detectLocale }),
    [initialLocale, detectLocale],
  );
  const previousLocaleRef = useRef<SupportedLocale | null>(null);
  const [ready, setReady] = useState(() => hasLocaleResources(initialLocale));

  useEffect(() => {
    let cancelled = false;

    const syncLocale = async () => {
      setReady(hasLocaleResources(initialLocale));
      // A locale chunk that fails to download leaves the app in English rather than blank.
      const language = await ensureLocaleResources(initialLocale, instance).then(
        () => initialLocale,
        () => DEFAULT_LOCALE,
      );
      if (cancelled) {
        return;
      }
      if (instance.language !== language) {
        await instance.changeLanguage(language);
      }
      if (typeof document !== "undefined") {
        document.documentElement.lang = language;
      }
      previousLocaleRef.current = initialLocale;
      setReady(true);
    };

    void syncLocale();

    return () => {
      cancelled = true;
    };
  }, [instance, initialLocale]);

  useEffect(() => {
    if (locale === undefined || locale === previousLocaleRef.current) return;

    let cancelled = false;

    const syncExplicitLocale = async () => {
      setReady(hasLocaleResources(locale));
      await ensureLocaleResources(locale, instance);
      if (cancelled) {
        return;
      }
      await instance.changeLanguage(locale);
      previousLocaleRef.current = locale;
      if (typeof document !== "undefined") {
        document.documentElement.lang = locale;
      }
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
        } catch {
          /* ignore storage errors */
        }
      }
      setReady(true);
    };

    void syncExplicitLocale();

    return () => {
      cancelled = true;
    };
  }, [instance, locale]);

  if (!ready) {
    return fallback ?? null;
  }

  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}
