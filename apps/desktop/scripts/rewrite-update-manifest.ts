#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type CliOptions = {
  input: string;
  output: string;
  urlPrefix: string;
};

type CliOptionName = "--input" | "--output" | "--url-prefix";
type MutableCliOptions = {
  input: string;
  output: string;
  urlPrefix: string;
};

const optionSetters: Record<
  CliOptionName,
  (options: MutableCliOptions, value: string) => void
> = {
  "--input": (options, value) => {
    options.input = value;
  },
  "--output": (options, value) => {
    options.output = value;
  },
  "--url-prefix": (options, value) => {
    options.urlPrefix = value;
  },
};

function readOptionValue(argv: string[], index: number, optionName: string): string {
  if (index + 1 >= argv.length) {
    throw new Error(`${optionName} requires a value`);
  }

  return argv[index + 1];
}

function isCliOptionName(value: string): value is CliOptionName {
  return value === "--input" || value === "--output" || value === "--url-prefix";
}

function parseArgs(argv: string[]): CliOptions {
  const options: MutableCliOptions = {
    input: "",
    output: "",
    urlPrefix: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!isCliOptionName(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    optionSetters[arg](options, readOptionValue(argv, index, arg));
    index += 1;
  }

  if (options.input.length === 0) throw new Error("--input is required");
  if (options.output.length === 0) throw new Error("--output is required");
  if (options.urlPrefix.length === 0) throw new Error("--url-prefix is required");

  return options;
}

function normalizePrefix(prefix: string): string {
  return trimSlashes(prefix);
}

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (value[start] === "/") start += 1;
  while (end > start && value[end - 1] === "/") end -= 1;
  return value.slice(start, end);
}

function shouldRewriteValue(value: string, normalizedPrefix: string): boolean {
  if (value.length === 0) return false;
  if (value.includes("://")) return false;
  if (value.startsWith("/")) return false;
  if (value.startsWith(`${normalizedPrefix}/`)) return false;
  return true;
}

function parseManifestPathLine(
  line: string,
): { indentation: string; key: string; quote: string; value: string } | undefined {
  let valueStart = 0;
  while (line[valueStart] === " " || line[valueStart] === "\t") valueStart += 1;
  if (line[valueStart] === "-") valueStart += 1;
  while (line[valueStart] === " " || line[valueStart] === "\t") valueStart += 1;

  const indentation = line.slice(0, valueStart);
  const colon = line.indexOf(":", valueStart);
  const key = line.slice(valueStart, colon);
  if (colon < 0 || (key !== "path" && key !== "url")) return undefined;

  valueStart = colon + 1;
  while (line[valueStart] === " " || line[valueStart] === "\t") valueStart += 1;
  const quote = line[valueStart] === "'" || line[valueStart] === '"' ? line[valueStart++] : "";
  let valueEnd = line.length;
  while (line[valueEnd - 1] === " " || line[valueEnd - 1] === "\t") valueEnd -= 1;
  if (quote !== "") {
    if (line[valueEnd - 1] !== quote) return undefined;
    valueEnd -= 1;
  }

  const value = line.slice(valueStart, valueEnd);
  return value === "" || value.includes("'") || value.includes('"')
    ? undefined
    : { indentation, key, quote, value };
}

function rewriteManifest(content: string, prefix: string): string {
  const normalizedPrefix = normalizePrefix(prefix);

  return content
    .split(/\r?\n/)
    .map((line) => {
      const parsed = parseManifestPathLine(line);
      if (parsed === undefined) return line;

      const { indentation, key, quote, value } = parsed;
      if (!shouldRewriteValue(value, normalizedPrefix)) {
        return line;
      }

      let quoted = quote;
      if (quote.length === 0) {
        quoted = "";
      }
      return `${indentation}${key}: ${quoted}${normalizedPrefix}/${value}${quoted}`;
    })
    .join("\n");
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = resolve(process.cwd(), options.input);
  const outputPath = resolve(process.cwd(), options.output);
  const content = readFileSync(inputPath, "utf8");
  const rewritten = rewriteManifest(content, options.urlPrefix);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, rewritten, "utf8");
}

main();
