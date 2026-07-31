import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const version = require("typescript").version;

if (!version.startsWith("6.")) {
  throw new Error(
    `ESLint must resolve the TypeScript 6 compatibility API; resolved ${version}.`,
  );
}

console.log(`ESLint TypeScript API: ${version}`);
