import type {
  DiagnosisLogLevel,
  DiagnosisSeverity,
  DiagnosisSourceCategory,
  DiagnosisSourceKind,
  DiagnosisSourceRef,
} from "../domain/entities/DiagnosisRecord";

const TEXT_SEVERITY: Readonly<Partial<Record<string, DiagnosisSeverity>>> = {
  critical: "critical",
  debug: "info",
  error: "high",
  fatal: "critical",
  high: "high",
  info: "info",
  low: "low",
  medium: "medium",
  notice: "info",
  unknown: "unknown",
  warn: "medium",
  warning: "medium",
};

const LOG_LEVEL: Readonly<Record<string, DiagnosisLogLevel | undefined>> = {
  application: "application",
  infrastructure: "infrastructure",
  unknown: "unknown",
};

const SOURCE_KIND_BY_CATEGORY: Readonly<
  Partial<Record<string, DiagnosisSourceKind>>
> = {
  telemetry: "telemetry_entry",
};

export interface DiagnosisSourceContextPayload {
  sourceCategory?: string;
  sourceKind?: string;
  logLevel?: string;
  environment?: string | null;
  normalizedData?: Record<string, unknown>;
  sourceMetadata?: Record<string, unknown>;
  sourceRef?: {
    sourceTableName?: string | null;
    sourceFieldName?: string | null;
    sourceKeyValue?: string | number | null;
  };
}

export interface DiagnosisTelemetryEntrySource extends Record<string, unknown> {
  diagnosisSourceContext?: DiagnosisSourceContextPayload;
}

export interface DiagnosisSourceTelemetryEntry {
  id: number;
  ruleDescription?: string | null;
  ruleLevel?: number | null;
  entrySource: DiagnosisTelemetryEntrySource;
}

function sourceText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim();
  if (normalized.length === 0) return undefined;
  return normalized;
}

function parseRuleLevel(value: unknown): number | undefined {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  return undefined;
}

function mapTelemetrySeverityByRuleLevel(ruleLevel?: number): DiagnosisSeverity {
  if (ruleLevel === undefined) return "unknown";
  // Align infrastructure/telemetry severity cutoffs with ticket priority logic:
  // CRITICAL(>=15), URGENT(>=12), HIGH(>=8), MEDIUM(>=4), LOW(<4)
  // Since diagnosis severity does not have URGENT, map URGENT to CRITICAL.
  if (ruleLevel >= 12) return "critical";
  if (ruleLevel >= 8) return "high";
  if (ruleLevel >= 4) return "medium";
  if (ruleLevel >= 1) return "low";
  return "info";
}

function mapTextSeverity(raw: string): DiagnosisSeverity {
  const severity = TEXT_SEVERITY[raw.toLowerCase()];
  if (severity !== undefined) return severity;
  return "unknown";
}

function normalizeSeverity(value: string | number | null | undefined): DiagnosisSeverity {
  const text = sourceText(value)?.toLowerCase();
  if (text === undefined) return "unknown";
  return mapTextSeverity(text);
}

function normalizeLogLevel(value: string | null | undefined): DiagnosisLogLevel | undefined {
  const text = sourceText(value)?.toLowerCase();
  if (text === undefined) return undefined;
  return LOG_LEVEL[text];
}

function inferSourceCategory(
  hint: string | undefined,
  sourceMetadata?: Record<string, unknown>,
): DiagnosisSourceCategory {
  const explicit = sourceText(hint)?.toLowerCase();
  if (explicit !== undefined) return explicit;

  const metadataSourceType = sourceText(sourceMetadata?.sourceType)?.toLowerCase();
  if (metadataSourceType !== undefined) {
    return metadataSourceType;
  }

  return "unknown";
}

function inferSourceKind(
  hint: string | undefined,
  sourceCategory: DiagnosisSourceCategory,
): DiagnosisSourceKind {
  const explicit = sourceText(hint)?.toLowerCase();
  if (explicit !== undefined) return explicit;
  const sourceKind = SOURCE_KIND_BY_CATEGORY[sourceCategory];
  if (sourceKind !== undefined) return sourceKind;
  if (sourceCategory !== "unknown") return "error_event";
  return "unknown";
}

function defaultLogLevel(sourceKind: DiagnosisSourceKind): DiagnosisLogLevel {
  if (sourceKind === "error_event" || sourceKind === "error_issue")
    return "application";
  return "infrastructure";
}

function inferSeverity(input: {
  sourceKind: DiagnosisSourceKind;
  severity?: string | number | null;
  ruleLevel?: number | null;
}): DiagnosisSeverity {
  if (input.sourceKind === "telemetry_entry") {
    // For infrastructure-style telemetry sources, severity is derived only from rule level.
    return mapTelemetrySeverityByRuleLevel(parseRuleLevel(input.ruleLevel));
  }

  const mapped = normalizeSeverity(input.severity);
  return mapped;
}

function pickFirstSourceText(values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = sourceText(value);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function buildDefaultSourceRef(input: {
  sourceKind: DiagnosisSourceKind;
  telemetryEntryId?: number;
  sourceKeyValue?: string | number | null;
}): DiagnosisSourceRef {
  const normalizedKey = sourceText(input.sourceKeyValue);
  if (input.sourceKind === "error_issue") {
    return {
      sourceTableName: "ErrorIssue",
      sourceFieldName: "externalIssueId",
      sourceKeyValue: normalizedKey ?? "unknown",
    };
  }
  if (input.sourceKind === "error_event") {
    return {
      sourceTableName: "ErrorEvent",
      sourceFieldName: "externalEventId",
      sourceKeyValue: normalizedKey ?? "unknown",
    };
  }
  return {
    sourceTableName: "TelemetryEntry",
    sourceFieldName: "id",
    sourceKeyValue: telemetrySourceKey(normalizedKey, input.telemetryEntryId),
  };
}

function telemetrySourceKey(
  normalizedKey: string | undefined,
  telemetryEntryId: number | undefined,
): string {
  if (normalizedKey !== undefined) return normalizedKey;
  if (telemetryEntryId !== undefined) return String(telemetryEntryId);
  return "unknown";
}

function sourceRefFromInput(
  input: MapDiagnosisSourceContextInput,
  sourceKind: DiagnosisSourceKind,
  providerNativeId: string | undefined,
): DiagnosisSourceRef {
  const sourceRef = completeSourceRef(input.sourceRef);
  if (sourceRef !== undefined) return sourceRef;

  return buildDefaultSourceRef({
    sourceKind,
    telemetryEntryId: input.telemetryEntryId,
    sourceKeyValue: input.sourceRef?.sourceKeyValue ?? providerNativeId,
  });
}

function completeSourceRef(
  sourceRef: MapDiagnosisSourceContextInput["sourceRef"],
): DiagnosisSourceRef | undefined {
  const sourceTableName = sourceText(sourceRef?.sourceTableName);
  if (sourceTableName === undefined) return undefined;

  const sourceFieldName = sourceText(sourceRef?.sourceFieldName);
  if (sourceFieldName === undefined) return undefined;

  const sourceKeyValue = sourceText(sourceRef?.sourceKeyValue);
  if (sourceKeyValue === undefined) return undefined;

  return {
    sourceTableName,
    sourceFieldName,
    sourceKeyValue,
  };
}

export interface MapDiagnosisSourceContextInput {
  telemetryEntryId?: number;
  sourceCategory?: string;
  sourceKind?: string;
  logLevel?: string;
  severity?: string | number | null;
  ruleLevel?: number | null;
  description?: string | null;
  title?: string | null;
  message?: string | null;
  environment?: string | null;
  providerNativeSeverity?: string | number | null;
  providerNativeId?: string | number | null;
  sourceMetadata?: Record<string, unknown>;
  normalizedData?: Record<string, unknown>;
  sourceRef?: {
    sourceTableName?: string | null;
    sourceFieldName?: string | null;
    sourceKeyValue?: string | number | null;
  };
}

export interface MapDiagnosisSourceContextOutput {
  sourceCategory: DiagnosisSourceCategory;
  sourceKind: DiagnosisSourceKind;
  logLevel: DiagnosisLogLevel;
  severity: DiagnosisSeverity;
  description?: string;
  environment?: string;
  sourceMetadata?: Record<string, unknown>;
  normalizedData: Record<string, unknown>;
  sourceRef: DiagnosisSourceRef;
}

interface SourceClassification {
  sourceCategory: DiagnosisSourceCategory;
  sourceKind: DiagnosisSourceKind;
  logLevel: DiagnosisLogLevel;
  severity: DiagnosisSeverity;
}

interface ProviderNativeFields {
  providerNativeSeverity?: string;
  providerNativeId?: string;
}

function sourceClassification(
  input: MapDiagnosisSourceContextInput,
): SourceClassification {
  const sourceCategory = inferSourceCategory(input.sourceCategory, input.sourceMetadata);
  const sourceKind = inferSourceKind(input.sourceKind, sourceCategory);
  const logLevel = normalizeLogLevel(input.logLevel) ?? defaultLogLevel(sourceKind);
  const severity = inferSeverity({
    sourceKind,
    severity: input.severity ?? input.providerNativeSeverity,
    ruleLevel: input.ruleLevel,
  });

  return {
    sourceCategory,
    sourceKind,
    logLevel,
    severity,
  };
}

function providerNativeFields(
  input: MapDiagnosisSourceContextInput,
): ProviderNativeFields {
  return {
    providerNativeSeverity: sourceText(input.providerNativeSeverity ?? input.severity),
    providerNativeId: sourceText(input.providerNativeId),
  };
}

function normalizedDataWithProviderFields(
  input: MapDiagnosisSourceContextInput,
  providerNative: ProviderNativeFields,
): Record<string, unknown> {
  const existingProviderNativeSeverity = sourceText(
    input.normalizedData?.provider_native_severity,
  );
  const existingProviderNativeId = sourceText(input.normalizedData?.provider_native_id);

  return {
    ...(input.normalizedData ?? {}),
    provider_native_severity:
      providerNative.providerNativeSeverity ?? existingProviderNativeSeverity,
    provider_native_id: providerNative.providerNativeId ?? existingProviderNativeId,
  };
}

function descriptionFromInput(
  input: MapDiagnosisSourceContextInput,
): string | undefined {
  return pickFirstSourceText([input.description, input.message, input.title]);
}

function environmentFromInput(
  input: MapDiagnosisSourceContextInput,
): string | undefined {
  return pickFirstSourceText([
    input.environment,
    input.sourceMetadata?.environment,
  ]);
}

export function mapDiagnosisSourceContext(
  input: MapDiagnosisSourceContextInput,
): MapDiagnosisSourceContextOutput {
  const classification = sourceClassification(input);
  const providerNative = providerNativeFields(input);

  return {
    ...classification,
    description: descriptionFromInput(input),
    environment: environmentFromInput(input),
    sourceMetadata: input.sourceMetadata,
    normalizedData: normalizedDataWithProviderFields(input, providerNative),
    sourceRef: sourceRefFromInput(
      input,
      classification.sourceKind,
      providerNative.providerNativeId,
    ),
  };
}

export function mapDiagnosisSourceContextFromEntry(
  entry: DiagnosisSourceTelemetryEntry,
): MapDiagnosisSourceContextOutput {
  return mapDiagnosisSourceContext(contextInputFromEntry(entry));
}

function contextInputFromEntry(
  entry: DiagnosisSourceTelemetryEntry,
): MapDiagnosisSourceContextInput {
  const sourceContext = entry.entrySource.diagnosisSourceContext;
  if (sourceContext === undefined) {
    return {
      telemetryEntryId: entry.id,
      ruleLevel: entry.ruleLevel,
      description: entry.ruleDescription,
      sourceMetadata: entry.entrySource,
    };
  }

  const normalizedData = sourceContext.normalizedData;
  const sourceMetadata = sourceContext.sourceMetadata ?? entry.entrySource;
  const providerNativeSeverity = sourceText(
    normalizedData?.provider_native_severity,
  );
  const providerNativeId = sourceText(normalizedData?.provider_native_id);

  return {
    telemetryEntryId: entry.id,
    sourceCategory: sourceContext.sourceCategory,
    sourceKind: sourceContext.sourceKind,
    logLevel: sourceContext.logLevel,
    ruleLevel: entry.ruleLevel,
    description: entry.ruleDescription,
    environment: sourceContext.environment,
    severity: providerNativeSeverity,
    providerNativeSeverity,
    providerNativeId,
    sourceMetadata,
    normalizedData,
    sourceRef: sourceContext.sourceRef,
  };
}
