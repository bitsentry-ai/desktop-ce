#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// These repositories own their dependencies and lockfiles. Do not install them
// through the Desktop workspace or silently resolve new dependency versions.
const plugins = ["itop", "outline"];
const operation = process.argv[2] ?? "build";
if (!["build", "lint", "typecheck"].includes(operation)) {
  throw new Error("Usage: node scripts/plugins/standalone.mjs build|lint|typecheck");
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pnpmEntry = process.env.npm_execpath;
if (!pnpmEntry) throw new Error("Run this script through pnpm.");
for (const name of plugins) {
  const cwd = path.join(root, "packages/plugins", name);
  for (const args of [
    ["--ignore-workspace", "install", "--frozen-lockfile"],
    ["--ignore-workspace", "run", operation],
  ]) {
    const result = spawnSync(process.execPath, [pnpmEntry, ...args], { cwd, stdio: "inherit" });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
