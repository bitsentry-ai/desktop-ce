#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
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
const { parse: parseYaml } = desktopRequire("yaml");
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

function assertReleaseArtifactBaseUrl() {
  const value = process.env.PLUGIN_ARTIFACT_BASE_URL?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(
      "PLUGIN_ARTIFACT_BASE_URL is required when publishing the plugin index.",
    );
  }
}

async function assertReleaseArtifactIndex() {
  const indexSource = await readFile(
    path.join(artifactRoot, "index.yaml"),
    "utf8",
  );
  let index;
  try {
    index = parseYaml(indexSource);
  } catch {
    throw new Error("Plugin artifact index must contain valid YAML.");
  }

  const plugins = index?.plugins;
  if (
    plugins === null ||
    typeof plugins !== "object" ||
    Array.isArray(plugins) ||
    Object.keys(plugins).length === 0
  ) {
    throw new Error("Plugin artifact index must contain at least one plugin.");
  }

  for (const [pluginId, entry] of Object.entries(plugins)) {
    const artifactUrl = entry?.artifactUrl;
    let parsedUrl;
    try {
      parsedUrl = new URL(artifactUrl);
    } catch {
      throw new Error(
        `Plugin ${pluginId} must use an approved GitHub release artifact URL.`,
      );
    }

    if (
      parsedUrl.origin !== "https://github.com" ||
      parsedUrl.search !== "" ||
      parsedUrl.hash !== "" ||
      !/^\/bitsentry-ai\/desktop-ce\/releases\/download\/[^/]+\/[^/]+\.plugin\.js$/.test(
        parsedUrl.pathname,
      )
    ) {
      throw new Error(
        `Plugin ${pluginId} must use an approved GitHub release artifact URL.`,
      );
    }
  }
}

async function listPublishableArtifacts() {
  const indexPath = path.join(artifactRoot, "index.yaml");
  const indexStat = await stat(indexPath).catch(() => null);
  if (indexStat === null || !indexStat.isFile()) {
    throw new Error("Plugin artifact index build/plugins/index.yaml is missing.");
  }
  if (indexStat.size === 0) {
    throw new Error("Refusing to publish an empty plugin index.");
  }

  return ["index.yaml"];
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
  if (!dryRun) {
    assertReleaseArtifactBaseUrl();
    await assertReleaseArtifactIndex();
  }

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
    `Published plugin index to ${r2Environment.bucket}\n`,
  );
}

await main();
