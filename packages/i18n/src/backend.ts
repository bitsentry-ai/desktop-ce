import { existsSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "./config";

export const BACKEND_LOCALE_MAP: Record<string, SupportedLocale> = {
  en: "en-US",
  "en-US": "en-US",
  "en-GB": "en-GB",
  "en-AU": "en-AU",
  fr: "fr-FR",
  "fr-FR": "fr-FR",
  zh: "zh-CN",
  "zh-CN": "zh-CN",
  id: "id-ID",
  "id-ID": "id-ID",
};

export function mapHeaderToLocale(header: string | undefined | null): SupportedLocale {
  if (header === undefined || header === null || header === "") {
    return DEFAULT_LOCALE;
  }

  return BACKEND_LOCALE_MAP[header] ?? DEFAULT_LOCALE;
}

/**
 * Resolves the absolute path to the compiled locales directory.
 * Uses Node's resolver to locate the installed `@bitsentry-ce/i18n` package
 * so this works regardless of where the calling code was compiled to.
 */
export function getLocalesPath(): string {
  const candidates: string[] = [];
  const cwd = process.cwd();
  try {
    const pkgJson = require.resolve("@bitsentry-ce/i18n/package.json");
    const pkgRoot = path.dirname(pkgJson);
    candidates.push(
      path.join(pkgRoot, "dist", "locales"),
      path.join(pkgRoot, "src", "locales"),
    );
  } catch {
    /* fall through to __dirname-relative candidates */
  }
  candidates.push(
    path.join(cwd, "apps", "desktop-ce", "packages", "i18n", "dist", "locales"),
    path.join(cwd, "apps", "desktop-ce", "packages", "i18n", "src", "locales"),
    path.join(cwd, "..", "desktop-ce", "packages", "i18n", "dist", "locales"),
    path.join(cwd, "..", "desktop-ce", "packages", "i18n", "src", "locales"),
    path.join(__dirname, "locales"),
    path.join(__dirname, "..", "locales"),
    path.join(__dirname, "..", "dist", "locales"),
    path.join(__dirname, "..", "src", "locales"),
  );
  const found = candidates.find((p) => existsSync(p));
  return found ?? candidates[0];
}

export { SUPPORTED_LOCALES, DEFAULT_LOCALE };
export type { SupportedLocale };
