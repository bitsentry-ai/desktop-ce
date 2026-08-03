import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "..", "..", "..");
const mainProcessSourceRoots = [
  "apps/desktop/src",
  "packages/coding-agents/src",
  "packages/core/src",
  "packages/desktop-cli/src",
];
const incidentWritePattern = /\b(incident(?:Thread|Message)\.(?:create|createMany|upsert|update|updateMany|delete|deleteMany))\(/g;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  }));
  return files.flat();
}

describe("incident persistence ownership", () => {
  // This is an architecture-conformance test. It intentionally scans source
  // ownership boundaries rather than exercising a runtime API.
  it("keeps IncidentThread and IncidentMessage writes in the renderer-state mirror", async () => {
    const writers: string[] = [];

    for (const sourceRoot of mainProcessSourceRoots) {
      for (const file of await sourceFiles(join(repositoryRoot, sourceRoot))) {
        const contents = await readFile(file, "utf8");
        for (const match of contents.matchAll(incidentWritePattern)) {
          writers.push(`${relative(repositoryRoot, file)}:${match[1]}`);
        }
      }
    }

    expect(writers.sort()).toEqual([
      "packages/core/src/features/desktop-state/desktop-state.handlers.ts:incidentMessage.create",
      "packages/core/src/features/desktop-state/desktop-state.handlers.ts:incidentMessage.create",
      "packages/core/src/features/desktop-state/desktop-state.handlers.ts:incidentMessage.deleteMany",
      "packages/core/src/features/desktop-state/desktop-state.handlers.ts:incidentThread.create",
      "packages/core/src/features/desktop-state/desktop-state.handlers.ts:incidentThread.deleteMany",
    ]);
  });
});
