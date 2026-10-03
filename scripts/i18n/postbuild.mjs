import { cp, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..", "..", "packages", "i18n");
const srcLocales = path.join(packageRoot, "src", "locales");
const distLocales = path.join(packageRoot, "dist", "locales");

// Runtime disables keySeparator: nested namespace entries would render raw keys.
for (const locale of await readdir(srcLocales, { withFileTypes: true })) {
  if (!locale.isDirectory()) continue;
  for (const namespace of ["incidents", "settings"]) {
    const file = path.join(srcLocales, locale.name, `${namespace}.json`);
    const translations = JSON.parse(await readFile(file, "utf8"));
    for (const [key, value] of Object.entries(translations)) {
      if (typeof value !== "string") throw new Error(`${locale.name}/${namespace}: ${key} must be a flat translation key.`);
    }
  }
}

await cp(srcLocales, distLocales, { recursive: true });
