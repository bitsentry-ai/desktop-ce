import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..", "..", "packages", "components");
const corePackageRoot = path.resolve(__dirname, "..", "..", "packages", "core");
const distRoot = path.join(packageRoot, "dist");

await mkdir(path.join(distRoot, "llm"), { recursive: true });
await cp(
  path.join(corePackageRoot, "src", "features", "llm", "model-catalog.json"),
  path.join(distRoot, "llm", "model-catalog.json"),
);
