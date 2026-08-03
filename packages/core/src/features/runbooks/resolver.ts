import { getSecureRedactionMarker } from "./redactor";
import { isRecord } from "../../shared/values";

export interface TemplateParameterDefinition {
  key: string;
  defaultValue?: string;
  required?: boolean;
  secure?: boolean;
}

export interface TemplateGlobalDefinition {
  key: string;
  value?: string;
  secure?: boolean;
}

export interface TemplateStepOutputRecord {
  actionId?: string;
  order: number;
  status: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  exitCode?: number;
  statusCode?: number;
  metadata?: Record<string, unknown>;
  structuredOutput?: Record<string, unknown>;
}

export interface TemplateResolverContext {
  params?: Record<string, string | undefined>;
  globals?: Record<string, string | undefined>;
  steps?: TemplateStepOutputRecord[];
  parameterDefinitions?: TemplateParameterDefinition[];
  globalDefinitions?: TemplateGlobalDefinition[];
  secureParams?: Iterable<string>;
  secureGlobals?: Iterable<string>;
}

export type TemplateSecureValueMode = "raw" | "placeholder";

export interface TemplateResolutionOptions {
  preserveMissing?: boolean;
  secureValueMode?: TemplateSecureValueMode;
}

export interface TemplateResolutionResult {
  value: string;
  ok: boolean;
  missing: string[];
  references: string[];
  secureReferences: string[];
  warnings: string[];
}

interface LookupResult {
  resolved: boolean;
  value?: string;
  secure: boolean;
  marker?: string;
  missingReference?: string;
}

function replaceDelimitedReferences(
  template: string,
  opening: string,
  closing: string,
  isValid: (reference: string) => boolean,
  replace: (match: string, reference: string) => string,
): string {
  let result = "";
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf(opening, cursor);
    if (start < 0) return result + template.slice(cursor);
    const end = template.indexOf(closing, start + opening.length);
    if (end < 0) return result + template.slice(cursor);

    const match = template.slice(start, end + closing.length);
    const reference = template.slice(start + opening.length, end).trim();
    result += template.slice(cursor, start);
    result += isValid(reference) ? replace(match, reference) : match;
    cursor = end + closing.length;
  }
  return result;
}

function isLegacyParameterKey(value: string): boolean {
  if (value === "" || !/[A-Za-z_]/.test(value[0] ?? "")) return false;
  return [...value.slice(1)].every((character) => /[A-Za-z0-9_.-]/.test(character));
}

function isExecutionContextReference(value: string): boolean {
  return value !== "" && value[0]?.trim() !== "";
}

export class TemplateResolutionError extends Error {
  constructor(readonly missing: string[]) {
    super(`Runbook template is missing values for: ${missing.join(", ")}`);
    this.name = "TemplateResolutionError";
  }
}

export class TemplateResolver {
  private readonly parameterDefinitions: Map<string, TemplateParameterDefinition>;
  private readonly globalDefinitions: Map<string, TemplateGlobalDefinition>;
  private readonly secureParams: Set<string>;
  private readonly secureGlobals: Set<string>;

  constructor(private readonly context: TemplateResolverContext) {
    const parameterDefinitions = context.parameterDefinitions ?? [];
    const globalDefinitions = context.globalDefinitions ?? [];
    this.parameterDefinitions = definitionsByKey(parameterDefinitions);
    this.globalDefinitions = definitionsByKey(globalDefinitions);
    this.secureParams = secureDefinitionKeys(
      context.secureParams,
      parameterDefinitions,
    );
    this.secureGlobals = secureDefinitionKeys(
      context.secureGlobals,
      globalDefinitions,
    );
  }

  resolve(
    template: string,
    options: TemplateResolutionOptions = {},
  ): TemplateResolutionResult {
    const missing: string[] = [];
    const references: string[] = [];
    const secureReferences: string[] = [];
    const preserveMissing = options.preserveMissing ?? true;
    const secureValueMode = options.secureValueMode ?? "raw";

    const replaceLookup = (
      match: string,
      reference: string,
      lookup: LookupResult,
    ) => {
      addUnique(references, reference);

      if (!lookup.resolved) {
        addUnique(missing, lookup.missingReference ?? reference);
        return missingReplacement(match, preserveMissing);
      }

      if (lookup.secure) {
        addUnique(secureReferences, reference);
      }

      return resolvedReplacement(reference, lookup, secureValueMode);
    };

    const legacyResolved = replaceDelimitedReferences(
      template,
      "{{",
      "}}",
      isLegacyParameterKey,
      (match, key: string) =>
        replaceLookup(match, `params.${key}`, this.lookupParam(key)),
    );

    const value = replaceDelimitedReferences(
      legacyResolved,
      "${",
      "}",
      isExecutionContextReference,
      (match, reference) => replaceLookup(match, reference, this.lookupReference(reference)),
    );

    const warnings = missing.map(
      (reference) => `Missing template value: ${reference}`,
    );

    return {
      value,
      ok: missing.length === 0,
      missing,
      references,
      secureReferences,
      warnings,
    };
  }

  resolveRequired(
    template: string,
    options: TemplateResolutionOptions = {},
  ): string {
    const result = this.resolve(template, options);
    if (!result.ok) {
      throw new TemplateResolutionError(result.missing);
    }
    return result.value;
  }

  private lookupReference(reference: string): LookupResult {
    const [namespace, ...path] = reference.split(".");

    if (namespace === "params") {
      return this.lookupParam(path.join("."));
    }

    if (namespace === "globals") {
      return this.lookupGlobal(path.join("."));
    }

    if (namespace === "steps") {
      return this.lookupStep(path, reference);
    }

    return {
      resolved: false,
      secure: false,
      missingReference: reference,
    };
  }

  private lookupParam(key: string): LookupResult {
    const definition = this.parameterDefinitions.get(key);
    const runtimeValue = this.context.params?.[key];
    const value = runtimeValue ?? definition?.defaultValue;
    const secure = this.secureParams.has(key) || definition?.secure === true;

    return this.lookupScalarValue({
      value,
      secure,
      missingReference: `params.${key}`,
      marker: getSecureRedactionMarker({ key, namespace: "params" }),
    });
  }

  private lookupGlobal(key: string): LookupResult {
    const definition = this.globalDefinitions.get(key);
    const runtimeValue = this.context.globals?.[key];
    const value = runtimeValue ?? definition?.value;
    const secure = this.secureGlobals.has(key) || definition?.secure === true;

    return this.lookupScalarValue({
      value,
      secure,
      missingReference: `globals.${key}`,
      marker: getSecureRedactionMarker({ key, namespace: "globals" }),
    });
  }

  private lookupStep(path: string[], reference: string): LookupResult {
    const [indexValue, ...valuePath] = path;
    if (indexValue.length === 0) {
      return { resolved: false, secure: false, missingReference: reference };
    }

    if (!/^\d+$/.test(indexValue)) {
      return { resolved: false, secure: false, missingReference: reference };
    }

    const stepIndex = Number(indexValue);
    const steps = this.stepsByRunbookOrder();
    if (stepIndex >= steps.length) {
      return {
        resolved: false,
        secure: false,
        missingReference: `steps.${indexValue}`,
      };
    }

    const step = steps[stepIndex];
    let value: unknown = step;
    if (valuePath.length > 0) {
      value = getPathValue(step, valuePath);
    }

    const scalarValue = stringifyTemplateValue(value);

    return this.lookupScalarValue({
      value: scalarValue,
      secure: false,
      missingReference: reference,
    });
  }

  private lookupScalarValue(input: {
    value?: string;
    secure: boolean;
    missingReference: string;
    marker?: string;
  }): LookupResult {
    if (input.value === undefined) {
      return {
        resolved: false,
        secure: input.secure,
        missingReference: input.missingReference,
      };
    }

    return {
      resolved: true,
      value: input.value,
      secure: input.secure,
      marker: input.marker,
    };
  }

  private stepsByRunbookOrder(): TemplateStepOutputRecord[] {
    return [...(this.context.steps ?? [])].sort(compareRunbookOrder);
  }
}

export const resolveRunbookTemplate = (
  template: string,
  context: TemplateResolverContext,
  options?: TemplateResolutionOptions,
): TemplateResolutionResult =>
  new TemplateResolver(context).resolve(template, options);

export const resolveRequiredRunbookTemplate = (
  template: string,
  context: TemplateResolverContext,
  options?: TemplateResolutionOptions,
): string => new TemplateResolver(context).resolveRequired(template, options);

const addUnique = (values: string[], value: string): void => {
  if (!values.includes(value)) {
    values.push(value);
  }
};

function definitionsByKey<TDefinition extends { key: string }>(
  definitions: TDefinition[],
): Map<string, TDefinition> {
  return new Map(
    definitions.map((definition) => [definition.key, definition]),
  );
}

interface SecureDefinition {
  key: string;
  secure?: boolean;
}

function secureDefinitionKeys(
  explicitSecureKeys: Iterable<string> | undefined,
  definitions: SecureDefinition[],
): Set<string> {
  const secureKeys = new Set(explicitSecureKeys ?? []);
  for (const definition of definitions) {
    if (definition.secure === true) secureKeys.add(definition.key);
  }
  return secureKeys;
}

function missingReplacement(match: string, preserveMissing: boolean): string {
  if (preserveMissing) return match;
  return "";
}

function resolvedReplacement(
  reference: string,
  lookup: LookupResult,
  secureValueMode: TemplateSecureValueMode,
): string {
  if (lookup.secure && secureValueMode === "placeholder") {
    return lookup.marker ?? `[secure:${reference}]`;
  }

  return lookup.value ?? "";
}

function compareRunbookOrder(
  left: TemplateStepOutputRecord,
  right: TemplateStepOutputRecord,
): number {
  if (left.order === right.order) return 0;
  if (left.order < right.order) return -1;
  return 1;
}

const getPathValue = (value: unknown, path: string[]): unknown => {
  let current = value;

  for (const segment of path) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }

    if (isRecord(current) && segment in current) {
      current = current[segment];
      continue;
    }

    return undefined;
  }

  return current;
};

const stringifyTemplateValue = (value: unknown): string | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
};
