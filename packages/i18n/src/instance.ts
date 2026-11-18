import i18next, { type i18n as I18nType } from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import {
  DEFAULT_LOCALE,
  DEFAULT_NAMESPACE,
  FALLBACK_CHAIN,
  LOCALE_STORAGE_KEY,
  NAMESPACES,
  SUPPORTED_LOCALES,
  type Namespace,
  type SupportedLocale,
} from "./config";

import enUSCommon from "./locales/en-US/common.json";
import enUSNavigation from "./locales/en-US/navigation.json";
import enUSDashboard from "./locales/en-US/dashboard.json";
import enUSIncidents from "./locales/en-US/incidents.json";

type NamespaceResource = Record<string, unknown>;
type DeferredLocale = Exclude<SupportedLocale, "en-US">;
type NamespaceLoader = () => Promise<{ default: NamespaceResource }>;

const resources: Partial<Record<SupportedLocale, Partial<Record<Namespace, NamespaceResource>>>> = {
  "en-US": {
    common: enUSCommon,
    navigation: enUSNavigation,
    dashboard: enUSDashboard,
    incidents: enUSIncidents,
  },
};

// English namespaces the incidents screen does not use load with the screens that do.
const defaultNamespaceLoaders: Partial<Record<Namespace, NamespaceLoader>> = {
  auth: () => import("./locales/en-US/auth.json"),
  runbooks: () => import("./locales/en-US/runbooks.json"),
  settings: () => import("./locales/en-US/settings.json"),
  agents: () => import("./locales/en-US/agents.json"),
  errors: () => import("./locales/en-US/errors.json"),
};
const defaultNamespaceLoads = new Map<Namespace, Promise<void>>();

const loadedLocales = new Set<SupportedLocale>([DEFAULT_LOCALE]);

function isDeferredLocale(locale: SupportedLocale): locale is DeferredLocale {
  return locale !== DEFAULT_LOCALE;
}

const localeNamespaceLoaders = {
  "en-GB": {
    common: () => import("./locales/en-GB/common.json"),
    auth: () => import("./locales/en-GB/auth.json"),
    navigation: () => import("./locales/en-GB/navigation.json"),
    dashboard: () => import("./locales/en-GB/dashboard.json"),
    incidents: () => import("./locales/en-GB/incidents.json"),
    runbooks: () => import("./locales/en-GB/runbooks.json"),
    settings: () => import("./locales/en-GB/settings.json"),
    agents: () => import("./locales/en-GB/agents.json"),
    errors: () => import("./locales/en-GB/errors.json"),
  },
  "en-AU": {
    common: () => import("./locales/en-AU/common.json"),
    auth: () => import("./locales/en-AU/auth.json"),
    navigation: () => import("./locales/en-AU/navigation.json"),
    dashboard: () => import("./locales/en-AU/dashboard.json"),
    incidents: () => import("./locales/en-AU/incidents.json"),
    runbooks: () => import("./locales/en-AU/runbooks.json"),
    settings: () => import("./locales/en-AU/settings.json"),
    agents: () => import("./locales/en-AU/agents.json"),
    errors: () => import("./locales/en-AU/errors.json"),
  },
  "fr-FR": {
    common: () => import("./locales/fr-FR/common.json"),
    auth: () => import("./locales/fr-FR/auth.json"),
    navigation: () => import("./locales/fr-FR/navigation.json"),
    dashboard: () => import("./locales/fr-FR/dashboard.json"),
    incidents: () => import("./locales/fr-FR/incidents.json"),
    runbooks: () => import("./locales/fr-FR/runbooks.json"),
    settings: () => import("./locales/fr-FR/settings.json"),
    agents: () => import("./locales/fr-FR/agents.json"),
    errors: () => import("./locales/fr-FR/errors.json"),
  },
  "zh-CN": {
    common: () => import("./locales/zh-CN/common.json"),
    auth: () => import("./locales/zh-CN/auth.json"),
    navigation: () => import("./locales/zh-CN/navigation.json"),
    dashboard: () => import("./locales/zh-CN/dashboard.json"),
    incidents: () => import("./locales/zh-CN/incidents.json"),
    runbooks: () => import("./locales/zh-CN/runbooks.json"),
    settings: () => import("./locales/zh-CN/settings.json"),
    agents: () => import("./locales/zh-CN/agents.json"),
    errors: () => import("./locales/zh-CN/errors.json"),
  },
  "id-ID": {
    common: () => import("./locales/id-ID/common.json"),
    auth: () => import("./locales/id-ID/auth.json"),
    navigation: () => import("./locales/id-ID/navigation.json"),
    dashboard: () => import("./locales/id-ID/dashboard.json"),
    incidents: () => import("./locales/id-ID/incidents.json"),
    runbooks: () => import("./locales/id-ID/runbooks.json"),
    settings: () => import("./locales/id-ID/settings.json"),
    agents: () => import("./locales/id-ID/agents.json"),
    errors: () => import("./locales/id-ID/errors.json"),
  },
} satisfies Record<DeferredLocale, Record<Namespace, NamespaceLoader>>;

async function loadLocaleNamespace(
  locale: DeferredLocale,
  namespace: Namespace,
): Promise<NamespaceResource> {
  const module = await localeNamespaceLoaders[locale][namespace]();
  return module.default;
}

async function loadLocaleBundles(
  locale: DeferredLocale,
): Promise<Partial<Record<Namespace, NamespaceResource>>> {
  const loaded = await Promise.all(
    NAMESPACES.map(async (namespace) => [namespace, await loadLocaleNamespace(locale, namespace)] as const),
  );
  return Object.fromEntries(loaded);
}

function mergeLocaleResources(
  locale: SupportedLocale,
  bundles: Partial<Record<Namespace, NamespaceResource>>,
  instance?: I18nType,
): void {
  const localeResources = resources[locale] ?? {};
  resources[locale] = localeResources;

  for (const [namespace, bundle] of Object.entries(bundles) as Array<
    [Namespace, NamespaceResource]
  >) {
    localeResources[namespace] = bundle;
    if (instance !== undefined) {
      instance.addResourceBundle(locale, namespace, bundle, true, true);
    }
  }

  loadedLocales.add(locale);
}

export const fallbackLng: Record<string, string[]> = {
  default: [DEFAULT_LOCALE],
  ...Object.fromEntries(
    SUPPORTED_LOCALES.map((locale) => [
      locale,
      [...FALLBACK_CHAIN[locale], DEFAULT_LOCALE].filter(
        (value, idx, arr) => value !== locale && arr.indexOf(value) === idx,
      ),
    ]),
  ),
};

let sharedInstance: I18nType | null = null;

export interface CreateI18nOptions {
  locale?: SupportedLocale;
  detectLocale?: boolean;
}

export function hasLocaleResources(locale: SupportedLocale): boolean {
  return loadedLocales.has(locale);
}

function getDetectionOptions(enabled: boolean):
  | {
      order: string[];
      lookupLocalStorage: string;
      caches: string[];
    }
  | undefined {
  if (!enabled) {
    return undefined;
  }

  return {
    order: ["localStorage", "navigator"],
    lookupLocalStorage: LOCALE_STORAGE_KEY,
    caches: ["localStorage"],
  };
}

export async function ensureLocaleResources(
  locale: SupportedLocale,
  instance?: I18nType,
): Promise<void> {
  const localesToEnsure = [...FALLBACK_CHAIN[locale], locale].filter(
    (candidate, index, items): candidate is SupportedLocale =>
      items.indexOf(candidate) === index,
  );

  for (const nextLocale of localesToEnsure) {
    if (!loadedLocales.has(nextLocale)) {
      if (!isDeferredLocale(nextLocale)) {
        continue;
      }

      const bundles = await loadLocaleBundles(nextLocale);

      mergeLocaleResources(
        nextLocale,
        bundles,
        instance ?? sharedInstance ?? undefined,
      );
      continue;
    }

    const localeResources = resources[nextLocale];
    if (instance !== undefined && localeResources !== undefined) {
      mergeLocaleResources(
        nextLocale,
        localeResources,
        instance,
      );
    }
  }
}

export function createI18nInstance(options: CreateI18nOptions = {}): I18nType {
  const instance = i18next.createInstance();
  if (options.detectLocale === true) {
    instance.use(LanguageDetector);
  }
  instance.use(initReactI18next);

  void instance.init({
    resources,
    lng: options.locale,
    fallbackLng,
    defaultNS: DEFAULT_NAMESPACE,
    fallbackNS: [...NAMESPACES],
    ns: [...NAMESPACES],
    supportedLngs: [...SUPPORTED_LOCALES],
    nonExplicitSupportedLngs: false,
    keySeparator: false,
    nsSeparator: false,
    interpolation: {
      escapeValue: false,
    },
    detection: getDetectionOptions(options.detectLocale === true),
    returnEmptyString: false,
  });

  return instance;
}

function loadDefaultNamespace(namespace: Namespace): Promise<void> {
  const loader = defaultNamespaceLoaders[namespace];
  if (loader === undefined) return Promise.resolve();

  let load = defaultNamespaceLoads.get(namespace);
  if (load === undefined) {
    load = loader().then(
      ({ default: bundle }) => {
        // No overwrite: the Dashboard registers its own values for some keys.
        getSharedI18nInstance().addResourceBundle(DEFAULT_LOCALE, namespace, bundle, true, false);
      },
      (error: unknown) => {
        defaultNamespaceLoads.delete(namespace);
        throw error;
      },
    );
    defaultNamespaceLoads.set(namespace, load);
  }
  return load;
}

// Screens that use these namespaces load them before they render, e.g. in their React.lazy import.
export async function loadNamespaces(namespaces: readonly Namespace[]): Promise<void> {
  await Promise.all(namespaces.map(loadDefaultNamespace));
}

export function getSharedI18nInstance(
  options: CreateI18nOptions = {},
): I18nType {
  if (sharedInstance === null) {
    sharedInstance = createI18nInstance(options);
  }
  return sharedInstance;
}
