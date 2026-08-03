#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const REQUIRED_ENV_VARS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
] as const;

type CliOptions = {
  root?: string;
  prefix?: string;
  include: string[];
  alias: string[];
  ifNoFilesFound: "error" | "warn";
};

type RequiredR2Env = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl?: string;
};

type UploadDescriptor = {
  sourcePath: string;
  key: string;
  label: string;
};

type CliOptionName = "--root" | "--prefix" | "--include" | "--alias" | "--if-no-files-found";
type CliOptionHandler = (options: CliOptions, value: string) => void;

const optionHandlers: Record<CliOptionName, CliOptionHandler> = {
  "--root": (options, value) => {
    options.root = value;
  },
  "--prefix": (options, value) => {
    options.prefix = value;
  },
  "--include": (options, value) => {
    options.include.push(value);
  },
  "--alias": (options, value) => {
    options.alias.push(value);
  },
  "--if-no-files-found": (options, value) => {
    if (value !== "error" && value !== "warn") {
      throw new Error(`Invalid --if-no-files-found value: ${value}`);
    }

    options.ifNoFilesFound = value;
  },
};

const contentTypesByExtension = new Map<string, string>([
  [".yml", "text/yaml; charset=utf-8"],
  [".yaml", "text/yaml; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".appimage", "application/octet-stream"],
  [".dmg", "application/x-apple-diskimage"],
  [".zip", "application/zip"],
  [".exe", "application/vnd.microsoft.portable-executable"],
  [".msi", "application/x-msi"],
  [".blockmap", "application/octet-stream"],
]);

function isCliOptionName(value: string): value is CliOptionName {
  return value in optionHandlers;
}

function readOptionValue(argv: string[], index: number, optionName: string): string {
  if (index + 1 >= argv.length) {
    throw new Error(`${optionName} requires a value`);
  }

  return argv[index + 1];
}

function parseArgs(argv: string[]): Required<CliOptions> {
  const options: CliOptions = {
    include: [],
    alias: [],
    ifNoFilesFound: "error",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!isCliOptionName(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    optionHandlers[arg](options, readOptionValue(argv, index, arg));
    index += 1;
  }

  if (options.root === undefined || options.root.length === 0) {
    throw new Error("--root is required");
  }

  if (options.prefix === undefined || options.prefix.length === 0) {
    throw new Error("--prefix is required");
  }

  if (options.include.length === 0) {
    throw new Error("At least one --include pattern is required");
  }

  return {
    root: options.root,
    prefix: options.prefix,
    include: options.include,
    alias: options.alias,
    ifNoFilesFound: options.ifNoFilesFound,
  };
}

function escapeRegexFragment(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => escapeRegexFragment(part).replace(/\\\?/g, "."))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

function matchesAnyPattern(fileName: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegex(pattern).test(fileName));
}

async function collectFiles(rootDirectory: string): Promise<string[]> {
  const entries = await fs.readdir(rootDirectory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function getContentType(filePath: string): string {
  return contentTypesByExtension.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

function getCacheControl(fileName: string, objectKey: string): string {
  if (objectKey.includes("desktop/main/")) {
    return "public, max-age=300, must-revalidate";
  }

  const objectSegments = objectKey.split("/").filter(Boolean);
  const isStableDesktopLatestObject =
    objectSegments.length === 5 &&
    objectSegments[0] === "desktop" &&
    objectSegments[1] === "releases";

  if (fileName.startsWith("latest") || isStableDesktopLatestObject) {
    return "no-store, max-age=0";
  }

  return "public, max-age=0, must-revalidate";
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

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function buildPublicUrl(baseUrl: string | undefined, key: string): string | null {
  if (baseUrl === undefined || baseUrl.length === 0) {
    return null;
  }

  return `${trimTrailingSlashes(baseUrl)}/${key}`;
}

function readR2Env(): RequiredR2Env {
  const missingEnvVars = REQUIRED_ENV_VARS.filter((name) => {
    const value = process.env[name];
    return value === undefined || value.length === 0;
  });

  if (missingEnvVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingEnvVars.join(", ")}`);
  }

  return {
    accountId: readRequiredEnv("R2_ACCOUNT_ID"),
    accessKeyId: readRequiredEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: readRequiredEnv("R2_SECRET_ACCESS_KEY"),
    bucket: readRequiredEnv("R2_BUCKET"),
    publicBaseUrl: process.env.R2_PUBLIC_BASE_URL,
  };
}

function readRequiredEnv(name: (typeof REQUIRED_ENV_VARS)[number]): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function uploadFile(
  client: S3Client,
  bucket: string,
  sourcePath: string,
  objectKey: string,
): Promise<void> {
  const fileName = path.basename(objectKey);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: createReadStream(sourcePath),
      ContentType: getContentType(sourcePath),
      CacheControl: getCacheControl(fileName, objectKey),
    }),
  );
}

async function selectFilesForUpload(
  options: Required<CliOptions>,
): Promise<string[]> {
  const rootDirectory = path.resolve(options.root);
  const allFiles = await collectFiles(rootDirectory);
  const matchesByIncludePattern = options.include.map((pattern) => ({
    pattern,
    files: allFiles.filter((filePath) => globToRegex(pattern).test(path.basename(filePath))),
  }));
  const selectedFiles = allFiles.filter((filePath) =>
    matchesAnyPattern(path.basename(filePath), options.include),
  );
  const missingIncludePatterns = matchesByIncludePattern
    .filter(({ files }) => files.length === 0)
    .map(({ pattern }) => pattern);

  if (selectedFiles.length === 0) {
    const message = `No files matched ${options.include.join(", ")} under ${rootDirectory}`;
    if (options.ifNoFilesFound === "warn") {
      console.warn(message);
      return [];
    }
    throw new Error(message);
  }

  if (missingIncludePatterns.length > 0) {
    throw new Error(
      `Required include pattern(s) did not match any files under ${rootDirectory}: ${missingIncludePatterns.join(", ")}`,
    );
  }

  return selectedFiles;
}

function createR2Client(r2Env: RequiredR2Env): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${r2Env.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: r2Env.accessKeyId,
      secretAccessKey: r2Env.secretAccessKey,
    },
  });
}

function parseAliasDefinition(aliasDefinition: string): { pattern: string; aliasName: string } {
  const separatorIndex = aliasDefinition.indexOf("=");
  if (separatorIndex <= 0 || separatorIndex === aliasDefinition.length - 1) {
    throw new Error(`Invalid --alias value: ${aliasDefinition}`);
  }

  return {
    pattern: aliasDefinition.slice(0, separatorIndex),
    aliasName: aliasDefinition.slice(separatorIndex + 1),
  };
}

function findSingleAliasSource(pattern: string, selectedFiles: string[]): string {
  const matchedFiles = selectedFiles.filter((filePath) =>
    globToRegex(pattern).test(path.basename(filePath)),
  );

  if (matchedFiles.length === 0) {
    throw new Error(`Alias pattern ${pattern} did not match any selected file`);
  }

  if (matchedFiles.length > 1) {
    throw new Error(`Alias pattern ${pattern} matched multiple files`);
  }

  return matchedFiles[0];
}

function buildUploads(
  selectedFiles: string[],
  aliases: string[],
  prefix: string,
): UploadDescriptor[] {
  const uploads: UploadDescriptor[] = [];

  for (const filePath of selectedFiles) {
    const fileName = path.basename(filePath);
    const key = `${prefix}/${fileName}`;
    uploads.push({ sourcePath: filePath, key, label: fileName });
  }

  for (const aliasDefinition of aliases) {
    const { pattern, aliasName } = parseAliasDefinition(aliasDefinition);
    const sourcePath = findSingleAliasSource(pattern, selectedFiles);
    uploads.push({
      sourcePath,
      key: `${prefix}/${aliasName}`,
      label: `${path.basename(sourcePath)} -> ${aliasName}`,
    });
  }

  return uploads;
}

async function uploadAll(
  client: S3Client,
  r2Env: RequiredR2Env,
  uploads: UploadDescriptor[],
): Promise<void> {
  for (const upload of uploads) {
    await uploadFile(client, r2Env.bucket, upload.sourcePath, upload.key);
    const publicUrl = buildPublicUrl(r2Env.publicBaseUrl, upload.key);
    let publicUrlMessage = "";
    if (publicUrl !== null) {
      publicUrlMessage = ` (${publicUrl})`;
    }
    console.log(`Uploaded ${upload.label}${publicUrlMessage}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const r2Env = readR2Env();
  const selectedFiles = await selectFilesForUpload(options);
  const uploads = buildUploads(
    selectedFiles,
    options.alias,
    normalizePrefix(options.prefix),
  );

  await uploadAll(createR2Client(r2Env), r2Env, uploads);
}

main().catch((error: unknown) => {
  let message = String(error);
  if (error instanceof Error) {
    message = error.message;
  }
  console.error(message);
  process.exit(1);
});
