#!/usr/bin/env node

import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const desktopRequire = createRequire(
  path.join(workspaceRoot, "apps", "desktop", "package.json"),
);
const { PutObjectCommand, S3Client } = desktopRequire("@aws-sdk/client-s3");
const artifactRoot = path.join(workspaceRoot, "build", "plugins");
const dryRun = process.argv.includes("--dry-run");
const requiredEnvNames = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
];

function readRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable ${name}.`);
  }

  return value;
}

function readR2Environment() {
  for (const name of requiredEnvNames) {
    readRequiredEnv(name);
  }

  return {
    accountId: readRequiredEnv("R2_ACCOUNT_ID"),
    accessKeyId: readRequiredEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: readRequiredEnv("R2_SECRET_ACCESS_KEY"),
    bucket: readRequiredEnv("R2_BUCKET"),
    prefix: normalizePrefix(process.env.R2_PLUGIN_PREFIX),
  };
}

function normalizePrefix(value) {
  if (value === undefined) {
    return "";
  }

  return value
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function objectKey(prefix, fileName) {
  if (prefix.length === 0) {
    return fileName;
  }

  return `${prefix}/${fileName}`;
}

function contentTypeFor(fileName) {
  if (fileName.endsWith(".yaml") || fileName.endsWith(".yml")) {
    return "application/yaml; charset=utf-8";
  }

  if (fileName.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }

  return "application/octet-stream";
}

async function listPublishableArtifacts() {
  const entries = await readdir(artifactRoot, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (entry.name === "index.yaml" || entry.name.endsWith(".plugin.js")) {
      const filePath = path.join(artifactRoot, entry.name);
      const fileStat = await stat(filePath);
      if (fileStat.size === 0) {
        throw new Error(`Refusing to publish empty plugin artifact: ${entry.name}`);
      }
      files.push(entry.name);
    }
  }

  files.sort((left, right) => left.localeCompare(right));
  if (!files.includes("index.yaml")) {
    throw new Error("Plugin artifact index build/plugins/index.yaml is missing.");
  }

  return files;
}

function createR2Client(r2Environment) {
  return new S3Client({
    endpoint: `https://${r2Environment.accountId}.r2.cloudflarestorage.com`,
    region: "auto",
    credentials: {
      accessKeyId: r2Environment.accessKeyId,
      secretAccessKey: r2Environment.secretAccessKey,
    },
  });
}

async function uploadArtifact(client, r2Environment, fileName) {
  const body = await readFile(path.join(artifactRoot, fileName));
  const key = objectKey(r2Environment.prefix, fileName);

  await client.send(
    new PutObjectCommand({
      Bucket: r2Environment.bucket,
      Key: key,
      Body: body,
      ContentType: contentTypeFor(fileName),
      CacheControl: "no-cache",
    }),
  );

  process.stdout.write(`Uploaded ${key}\n`);
}

async function main() {
  const files = await listPublishableArtifacts();
  if (dryRun) {
    process.stdout.write(
      `Dry run: would publish ${String(files.length)} plugin artifacts\n`,
    );
    for (const fileName of files) {
      process.stdout.write(`Would upload ${fileName}\n`);
    }
    return;
  }

  const r2Environment = readR2Environment();
  const client = createR2Client(r2Environment);
  for (const fileName of files) {
    await uploadArtifact(client, r2Environment, fileName);
  }

  process.stdout.write(
    `Published ${String(files.length)} plugin artifacts to ${r2Environment.bucket}\n`,
  );
}

await main();
