#!/usr/bin/env node

import { readFileSync } from "node:fs";

const ALLOWED_TYPES = new Set([
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
]);

const CONVENTIONAL_PATTERN =
  /^(?<type>[a-z]+)(?:\((?<scope>[a-z0-9][a-z0-9/-]*)\))?(?<breaking>!)?: (?<subject>[a-z0-9][a-z0-9 /._-]*)$/;

function fail(message) {
  console.error(`\ncommit message rejected: ${message}\n`);
  console.error("Expected:");
  console.error("  type(scope): short lowercase subject");
  console.error("Examples:");
  console.error("  feat(desktop): add windows changelog generation");
  console.error("  fix(ci): derive desktop release tag from package version");
  console.error("  docs: add windows installer guide");
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));
  const messageFlagIndex = args.indexOf("--message");
  const inlineMessageArg = args.find((arg) => arg.startsWith("--message="));

  let firstLine = "";

  if (inlineMessageArg) {
    firstLine = inlineMessageArg.slice("--message=".length).trim();
  } else if (messageFlagIndex >= 0) {
    firstLine = (args[messageFlagIndex + 1] ?? "").trim();
  } else {
    const commitMessagePath = args[0];
    if (!commitMessagePath) {
      fail("missing commit message file path");
    }

    const rawMessage = readFileSync(commitMessagePath, "utf8");
    firstLine = rawMessage.split(/\r?\n/, 1)[0]?.trim() ?? "";
  }

  if (!firstLine) {
    fail("commit message cannot be empty");
  }

  if (
    firstLine.startsWith("Merge ") ||
    firstLine.startsWith("Revert \"") ||
    firstLine.startsWith("fixup! ") ||
    firstLine.startsWith("squash! ")
  ) {
    return;
  }

  if (firstLine.length > 72) {
    fail("summary line must be 72 characters or fewer");
  }

  const match = CONVENTIONAL_PATTERN.exec(firstLine);
  if (!match?.groups) {
    fail("must match conventional format `type(scope): subject`");
  }

  const { type, scope, subject } = match.groups;

  if (!ALLOWED_TYPES.has(type)) {
    fail(`type must be one of: ${Array.from(ALLOWED_TYPES).sort().join(", ")}`);
  }

  if (scope && scope !== scope.toLowerCase()) {
    fail("scope must be lowercase");
  }

  if (subject !== subject.toLowerCase()) {
    fail("subject must be lowercase");
  }

  if (subject.endsWith(".")) {
    fail("subject must not end with a period");
  }
}

main();
