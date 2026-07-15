import type {
  RunbookImportOptions,
} from "./export.schemas";

const GLOBAL_REFERENCE_PATTERN = /\$\{globals\.([A-Za-z_][A-Za-z0-9_.-]*)\}/g;

export interface NormalizedRunbookImportOptions {
  conflictPolicy: "duplicate" | "skip" | "overwrite";
  preserveIds: boolean;
  includeGlobals: boolean;
  dryRun: boolean;
}

function collectStringGlobalReferences(
  value: string | undefined,
  references: Set<string>,
): void {
  if (value === undefined || value.length === 0) {
    return;
  }

  GLOBAL_REFERENCE_PATTERN.lastIndex = 0;

  for (const match of value.matchAll(GLOBAL_REFERENCE_PATTERN)) {
    const key = match[1].trim();
    if (key.length > 0) {
      references.add(key);
    }
  }
}

type GlobalReferenceActionShape = {
  id?: string;
  type?: string;
  title?: string;
  command?: string;
  prompt?: string;
  url?: string;
  body?: string;
  query?: string;
  pluginId?: string;
  pluginActionId?: string;
  pluginInput?: string;
  pluginAuth?: string;
  headers?: Array<{ key: string; value: string }>;
};

function collectActionGlobalReferences(
  action: GlobalReferenceActionShape,
  references: Set<string>,
): void {
  collectStringGlobalReferences(action.command, references);
  collectStringGlobalReferences(action.prompt, references);
  collectStringGlobalReferences(action.url, references);
  collectStringGlobalReferences(action.body, references);
  collectStringGlobalReferences(action.query, references);
  collectStringGlobalReferences(action.pluginInput, references);
  collectStringGlobalReferences(action.pluginAuth, references);

  for (const header of action.headers ?? []) {
    collectStringGlobalReferences(header.key, references);
    collectStringGlobalReferences(header.value, references);
  }
}

export function normalizeRunbookImportOptions(
  options?: RunbookImportOptions,
): NormalizedRunbookImportOptions {
  if (options === undefined) {
    return defaultRunbookImportOptions();
  }

  return {
    conflictPolicy: options.conflictPolicy ?? "duplicate",
    preserveIds: options.preserveIds ?? false,
    includeGlobals: options.includeGlobals ?? false,
    dryRun: options.dryRun ?? false,
  };
}

function defaultRunbookImportOptions(): NormalizedRunbookImportOptions {
  return {
    conflictPolicy: "duplicate",
    preserveIds: false,
    includeGlobals: false,
    dryRun: false,
  };
}

export function collectRunbookGlobalReferences(
  runbook: { actions: GlobalReferenceActionShape[] },
): string[] {
  const references = new Set<string>();

  for (const action of runbook.actions) {
    collectActionGlobalReferences(action, references);
  }

  return [...references].sort((left, right) => left.localeCompare(right));
}

export function findDuplicateRunbookActionId(
  runbook: { actions: Array<{ id?: string; [key: string]: unknown }> },
): string | null {
  const seenActionIds = new Set<string>();

  for (const action of runbook.actions) {
    if (typeof action.id !== "string") {
      continue;
    }

    if (seenActionIds.has(action.id)) {
      return action.id;
    }

    seenActionIds.add(action.id);
  }

  return null;
}

export function createImportedRunbookTitle(
  title: string,
  existingTitles: Iterable<string>,
): string {
  const trimmedTitle = title.trim();
  let requestedTitle = "Imported runbook";
  if (trimmedTitle.length > 0) {
    requestedTitle = trimmedTitle;
  }
  const knownTitles = new Set(existingTitles);

  if (!knownTitles.has(requestedTitle)) {
    return requestedTitle;
  }

  const baseTitle = `${requestedTitle} (imported)`;
  if (!knownTitles.has(baseTitle)) {
    return baseTitle;
  }

  let counter = 2;
  while (knownTitles.has(`${requestedTitle} (imported ${String(counter)})`)) {
    counter += 1;
  }

  return `${requestedTitle} (imported ${String(counter)})`;
}
