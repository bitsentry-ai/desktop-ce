#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const REQUIRED_ENV_VARS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
] as const;

type CliOptions = {
  manifest?: string;
  objectPrefix?: string;
  exe?: string;
  blockmap?: string;
};

type CliOptionHandler = (options: CliOptions, value: string) => void;

type RequiredR2Env = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

const CLI_OPTION_HANDLERS: Partial<Record<string, CliOptionHandler>> = {
  "--manifest": (options, value) => {
    options.manifest = value;
  },
  "--object-prefix": (options, value) => {
    options.objectPrefix = value;
  },
  "--exe": (options, value) => {
    options.exe = value;
  },
  "--blockmap": (options, value) => {
    options.blockmap = value;
  },
};

const updateManifestSchema = z.object({
  path: z.string().optional(),
  sha512: z.string().optional(),
  size: z.number().optional(),
  files: z
    .array(
      z.object({
        url: z.string().optional(),
        sha512: z.string().optional(),
        size: z.number().optional(),
      }),
    )
    .optional(),
});

const resolvedManifestSchema = z.object({
  path: z.string().min(1),
  sha512: z.string().min(1),
  size: z.number(),
});

const cliOptionsSchema = z.object({
  manifest: z.string().min(1),
  objectPrefix: z.string().min(1),
  exe: z.string().min(1),
  blockmap: z.string().min(1),
});

type RequiredCliOptions = z.infer<typeof cliOptionsSchema>;
type ResolvedUpdateManifest = z.infer<typeof resolvedManifestSchema>;

function readOptionValue(argv: string[], index: number, optionName: string): string {
  const values = argv.slice(index + 1, index + 2);
  if (values.length !== 1 || values[0].length === 0) {
    throw new Error(`${optionName} requires a value`);
  }

  return values[0];
}

function requireR2Env(): RequiredR2Env {
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
  };
}

function readRequiredEnv(name: (typeof REQUIRED_ENV_VARS)[number]): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseArgs(argv: string[]): RequiredCliOptions {
  const options: CliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const handler = CLI_OPTION_HANDLERS[arg];
    if (handler === undefined) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    handler(options, readOptionValue(argv, index, arg));
    index += 1;
  }

  const parsed = cliOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new Error("--manifest, --object-prefix, --exe, and --blockmap are required");
  }

  return parsed.data;
}

function normalizeObjectKey(...segments: string[]): string {
  let normalized = "";
  let pendingSeparator = false;
  for (const character of segments.join("/")) {
    if (character === "/" || character === "\\") {
      pendingSeparator = normalized.length > 0;
      continue;
    }
    if (pendingSeparator) normalized += "/";
    normalized += character;
    pendingSeparator = false;
  }
  return normalized;
}

function sha512Base64(bytes: Buffer): string {
  return createHash("sha512").update(bytes).digest("base64");
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (body == null) {
    throw new Error("R2 object response did not include a body");
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  const transformable = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof transformable.transformToByteArray === "function") {
    return Buffer.from(await transformable.transformToByteArray());
  }

  const iterable = body as AsyncIterable<Uint8Array>;
  if (typeof iterable[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of iterable) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  throw new Error("Unsupported R2 object body type");
}

function resolveManifestFields(
  manifest: z.infer<typeof updateManifestSchema>,
): Partial<ResolvedUpdateManifest> {
  const firstFile = manifest.files?.[0];

  return {
    path: manifest.path ?? firstFile?.url,
    sha512: manifest.sha512 ?? firstFile?.sha512,
    size: manifest.size ?? firstFile?.size,
  };
}

function readManifest(content: string): ResolvedUpdateManifest {
  const manifest = updateManifestSchema.parse(parseYaml(content));
  const parsed = resolvedManifestSchema.safeParse(resolveManifestFields(manifest));

  if (!parsed.success) {
    throw new Error("latest.yml must include path/url, sha512, and size for the Windows EXE");
  }

  return parsed.data;
}

async function getObjectBytes(client: S3Client, bucket: string, key: string): Promise<Buffer> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return bodyToBuffer(response.Body);
}

function assertBytes(label: string, bytes: Buffer, expectedSize: number, expectedSha512: string): void {
  const actualSha512 = sha512Base64(bytes);

  if (bytes.length !== expectedSize) {
    throw new Error(
      `${label} size mismatch: expected ${String(expectedSize)}, got ${String(bytes.length)}`,
    );
  }

  if (actualSha512 !== expectedSha512) {
    throw new Error(`${label} sha512 mismatch: expected ${expectedSha512}, got ${actualSha512}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const r2Env = requireR2Env();

  const manifest = readManifest(await fs.readFile(options.manifest, "utf8"));
  const exeName = path.basename(options.exe);
  if (path.posix.basename(manifest.path) !== exeName) {
    throw new Error(`Manifest path ${manifest.path} does not match local EXE ${exeName}`);
  }

  const blockmapName = path.basename(options.blockmap);
  const manifestDirectory = path.posix.dirname(manifest.path);
  let blockmapRelativePath = blockmapName;
  if (manifestDirectory !== ".") {
    blockmapRelativePath = path.posix.join(manifestDirectory, blockmapName);
  }
  const exeKey = normalizeObjectKey(options.objectPrefix, manifest.path);
  const blockmapKey = normalizeObjectKey(options.objectPrefix, blockmapRelativePath);

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${r2Env.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: r2Env.accessKeyId,
      secretAccessKey: r2Env.secretAccessKey,
    },
  });

  const exeBytes = await getObjectBytes(client, r2Env.bucket, exeKey);
  assertBytes("EXE", exeBytes, manifest.size, manifest.sha512);

  const localBlockmapBytes = await fs.readFile(options.blockmap);
  const blockmapBytes = await getObjectBytes(client, r2Env.bucket, blockmapKey);
  assertBytes(
    "blockmap",
    blockmapBytes,
    localBlockmapBytes.length,
    sha512Base64(localBlockmapBytes),
  );

  console.log(`Verified R2 Windows artifacts: ${exeKey}, ${blockmapKey}`);
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
