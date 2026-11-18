#!/usr/bin/env node
/**
 * Machine-translate `en-US/*.json` to target locales using Claude.
 *
 * Modes:
 *   --dry        Print prompts + key counts, do not call API.
 *   --apply      Call Claude API and write results.
 *
 * Args:
 *   --locale fr-FR         Target locale (required). Repeatable.
 *   --namespace common     Restrict to one namespace. Repeatable. Default = all.
 *   --force                Re-translate keys that already exist in target.
 *   --batch-size 50        Keys per API call. Default 50.
 *   --model                Anthropic model. Default claude-sonnet-4-6.
 *
 * Examples:
 *   node scripts/translate-locales.mjs --dry --locale fr-FR
 *   ANTHROPIC_API_KEY=... node scripts/translate-locales.mjs --apply \
 *     --locale fr-FR --locale zh-CN --locale id-ID
 *
 * Notes:
 * - `en-GB`/`en-AU` use a separate spelling-override flow (not handled here).
 * - The system prompt is cached (5-minute TTL) so the second locale/namespace
 *   in a session reuses the cached prefix.
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = parseArgs(process.argv.slice(2));
const MODE = args.apply ? "apply" : "dry";
const TASK = args.task ?? "translate"; // "translate" | "spelling"
const LOCALES = args.locales ?? [];
const NAMESPACES = args.namespaces ?? null;
const FORCE = !!args.force;
const BATCH_SIZE = args.batchSize ?? 50;
const MODEL = args.model ?? "claude-sonnet-4-6";

if (LOCALES.length === 0) {
  console.error("--locale <locale> is required (one or more)");
  process.exit(1);
}
const TRANSLATE_TARGETS = new Set(["fr-FR", "zh-CN", "id-ID"]);
const SPELLING_TARGETS = new Set(["en-GB", "en-AU"]);
const ALLOWED = TASK === "spelling" ? SPELLING_TARGETS : TRANSLATE_TARGETS;
for (const loc of LOCALES) {
  if (!ALLOWED.has(loc)) {
    console.error(
      `Locale ${loc} is not valid for --task ${TASK}. Valid: ${[...ALLOWED].join(", ")}`,
    );
    process.exit(1);
  }
}

const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..");
const LOCALES_DIR = path.join(
  WORKSPACE_ROOT,
  "packages",
  "i18n",
  "src",
  "locales",
);
const SOURCE_LOCALE = "en-US";

const LOCALE_INSTRUCTIONS = {
  "fr-FR": "Translate to French (France, fr-FR). Use formal but approachable register typical of professional SaaS UI in France. Use French quotation marks (« ») only for direct quotations, not for UI labels.",
  "zh-CN": "Translate to Simplified Chinese (zh-CN). Use the conventions of mainland Chinese tech products. Keep numbers in Arabic numerals. Use full-width punctuation (，。：？！) for sentence-ending punctuation only; UI labels use no terminal punctuation.",
  "id-ID": "Translate to Indonesian (Bahasa Indonesia, id-ID). Use formal-neutral register suitable for a security operations product. Avoid colloquial slang. Use 'Anda' rather than 'kamu' for second person.",
};

const SPELLING_INSTRUCTIONS = {
  "en-GB":
    "Transform US English spelling to British English (en-GB) conventions. Common patterns: -or → -our (color → colour), -ize → -ise (organize → organise), -er → -re (center → centre), -se → -ce (defense → defence), -log → -logue (catalog → catalogue), -ll → -l (traveling → travelling), grey not gray. Word choice differences: trash → rubbish only when natural; otherwise preserve word choice.",
  "en-AU":
    "Transform US English spelling to Australian English (en-AU) conventions. Australian English follows British spelling for most cases (-our, -ise, -re, -ce). Common patterns: color → colour, organize → organise, center → centre, defense → defence. Australians use 'program' (not programme) for software but 'programme' for events.",
};

const GLOSSARY = `
Product glossary — preserve these terms verbatim regardless of target locale:
- "BitSentry" (product name)
- "tRPC" (API protocol)
- "OTP" (one-time password)
- "TOTP" (time-based OTP)
- "API" / "URL" / "JSON" / "SQL" (technical acronyms)

Translate these conceptual terms naturally into the target language:
- "incident", "runbook", "agent", "telemetry", "diagnosis", "vulnerability"
- "dashboard", "settings", "report", "ticket"

Always preserve i18next interpolation placeholders unchanged: {{name}}, {{count}}, etc.
Preserve HTML entities like &copy;, &amp;, &lt;, &gt;.
Preserve Markdown structure: **bold**, *italic*, [link](url).
Preserve newline escapes (\\n, \\r\\n) — these reflect intentional line breaks in the UI.
`.trim();

async function main() {
  if (MODE === "apply" && !process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is required for --apply mode");
    process.exit(1);
  }

  const client = MODE === "apply" ? new Anthropic() : null;

  for (const locale of LOCALES) {
    console.log(`\n=== ${locale} ===`);
    const localeDir = path.join(LOCALES_DIR, locale);
    if (!fs.existsSync(localeDir)) {
      console.error(`Locale directory missing: ${localeDir}`);
      continue;
    }

    const sourceDir = path.join(LOCALES_DIR, SOURCE_LOCALE);
    const namespaces = NAMESPACES ?? listNamespaces(sourceDir);

    for (const ns of namespaces) {
      await translateNamespace(client, locale, ns);
    }
  }
}

async function translateNamespace(client, locale, namespace) {
  const sourcePath = path.join(LOCALES_DIR, SOURCE_LOCALE, `${namespace}.json`);
  const targetPath = path.join(LOCALES_DIR, locale, `${namespace}.json`);
  const source = readJson(sourcePath);
  const existing = readJson(targetPath);

  const sourceKeys = Object.keys(source);
  const todoKeys = FORCE
    ? sourceKeys
    : sourceKeys.filter((k) => !(k in existing));

  if (sourceKeys.length === 0) {
    console.log(`  ${namespace}: source empty, skipping`);
    return;
  }
  if (todoKeys.length === 0) {
    console.log(`  ${namespace}: ${sourceKeys.length} keys already present, skipping`);
    return;
  }

  console.log(`  ${namespace}: translating ${todoKeys.length}/${sourceKeys.length} keys`);

  const merged = { ...existing };
  let cursor = 0;
  while (cursor < todoKeys.length) {
    const batchKeys = todoKeys.slice(cursor, cursor + BATCH_SIZE);
    const batchInput = Object.fromEntries(batchKeys.map((k) => [k, source[k]]));

    if (MODE === "dry") {
      console.log(`    [dry] would request ${batchKeys.length} keys (${cursor + 1}-${cursor + batchKeys.length})`);
      cursor += BATCH_SIZE;
      continue;
    }

    let translated;
    try {
      translated = await callClaudeBatch(client, locale, namespace, batchInput);
    } catch (err) {
      console.error(`    [error] batch ${cursor}-${cursor + batchKeys.length}: ${err.message}`);
      // Save partial progress
      writeJson(targetPath, merged);
      throw err;
    }

    const validation = validateBatch(batchInput, translated);
    if (validation.errors.length) {
      console.warn(`    [warn] ${validation.errors.length} validation issues in batch:`);
      for (const e of validation.errors.slice(0, 3)) console.warn(`      - ${e}`);
    }

    Object.assign(merged, translated);
    writeJson(targetPath, merged); // checkpoint after each batch
    console.log(`    ✓ batch ${cursor + 1}-${cursor + batchKeys.length}`);
    cursor += BATCH_SIZE;
  }

  writeJson(targetPath, merged);
}

async function callClaudeBatch(client, locale, namespace, batch) {
  const isSpelling = TASK === "spelling";
  const localeInstr = isSpelling
    ? SPELLING_INSTRUCTIONS[locale]
    : LOCALE_INSTRUCTIONS[locale];

  const userPrompt = isSpelling
    ? `Namespace: ${namespace}\n\n` +
      `Inspect each value below and emit a JSON object containing ONLY the keys ` +
      `whose value needs a spelling change for the target variant. ` +
      `Omit keys whose value is unchanged in the target variant. ` +
      `Do not rephrase or reword — change spelling only. ` +
      `Output only the raw JSON object, no commentary.\n\n` +
      "Input:\n```json\n" +
      JSON.stringify(batch, null, 2) +
      "\n```"
    : `Namespace: ${namespace}\n\n` +
      `Translate the following English UI strings. Output a single JSON object ` +
      `mapping each input key to its translated string. Do not omit any keys. ` +
      `Do not add commentary or surrounding markdown — output only the raw JSON object.\n\n` +
      "Input:\n```json\n" +
      JSON.stringify(batch, null, 2) +
      "\n```";

  const systemRolePrefix = isSpelling
    ? "You are an English-variant spelling specialist transforming US English to UK or AU spelling conventions for a security operations SaaS product."
    : "You are a senior UI localization translator working on a security operations SaaS product.";

  const tool = {
    name: "submit_translations",
    description: isSpelling
      ? "Submit the spelling overrides. Pass an object containing only keys whose value differs in the target variant."
      : "Submit the translated UI strings. Pass an object with every input key mapped to its translated value.",
    input_schema: {
      type: "object",
      additionalProperties: true,
    },
  };

  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 8192,
        system: [
          {
            type: "text",
            text:
              `${systemRolePrefix}\n\n` +
              `${GLOSSARY}\n\n` +
              `You will return your output by calling the submit_translations tool exactly once. ` +
              `Do not emit prose, markdown, or commentary.`,
            cache_control: { type: "ephemeral" },
          },
          {
            type: "text",
            text: localeInstr,
          },
        ],
        tools: [tool],
        tool_choice: { type: "tool", name: "submit_translations" },
        messages: [{ role: "user", content: userPrompt }],
      });

      const toolBlock = response.content.find((b) => b.type === "tool_use");
      if (!toolBlock) {
        throw new Error("Model did not call submit_translations tool");
      }
      const parsed = toolBlock.input;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`Tool input is not an object: ${typeof parsed}`);
      }
      return parsed;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const wait = 1000 * attempt;
        console.warn(`    [retry ${attempt}/${maxAttempts}] ${err.message} — waiting ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

function validateBatch(input, output) {
  const errors = [];
  const isSpelling = TASK === "spelling";
  // In spelling mode, output may omit keys whose value is unchanged. Only
  // validate keys present in the output.
  const keysToCheck = isSpelling ? Object.keys(output) : Object.keys(input);
  for (const key of keysToCheck) {
    if (!isSpelling && !(key in output)) {
      errors.push(`missing key: ${key}`);
      continue;
    }
    if (isSpelling && !(key in input)) {
      errors.push(`unknown key emitted in spelling mode: ${key}`);
      continue;
    }
    const en = input[key];
    const tr = output[key];
    if (typeof tr !== "string") {
      errors.push(`non-string value for ${key}: ${typeof tr}`);
      continue;
    }
    // Interpolation placeholders must be preserved.
    const enPlaceholders = (en.match(/\{\{[^}]+\}\}/g) || []).sort();
    const trPlaceholders = (tr.match(/\{\{[^}]+\}\}/g) || []).sort();
    if (enPlaceholders.join("|") !== trPlaceholders.join("|")) {
      errors.push(
        `placeholder mismatch in ${key}: en=${enPlaceholders.join(",")} tr=${trPlaceholders.join(",")}`,
      );
    }
  }
  return { errors };
}

function listNamespaces(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".json"))
    .map((d) => d.name.replace(/\.json$/, ""));
}

function readJson(p) {
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function writeJson(p, obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(sorted, null, 2) + "\n", "utf8");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--dry") out.dry = true;
    else if (a === "--force") out.force = true;
    else if (a === "--locale") (out.locales ??= []).push(argv[++i]);
    else if (a === "--namespace") (out.namespaces ??= []).push(argv[++i]);
    else if (a === "--batch-size") out.batchSize = parseInt(argv[++i], 10);
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--task") out.task = argv[++i];
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
