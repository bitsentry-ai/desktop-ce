import { SecureRedactor } from "../redactor";
import {
  getSecureRedactionMarker,
  type SecureValueDescriptor,
} from "../redactor";
import type {
  RunbookActionParameter,
  RunbookActionRecord,
  RunbookExecutionRecord,
  RunbookTriggerContext,
} from "../runbooks.schemas";

export interface SecureParameterLike {
  key: string;
  secure?: boolean;
}

export type SecureValueDefinitionLike = SecureParameterLike;
export type ExecutionParameterValues = Record<string, string>;

export interface ExecutionGlobalDefinitionLike extends SecureValueDefinitionLike {}

export interface CreateExecutionSessionStateInput {
  executionId: string;
  runbookId: string;
  incidentThreadId?: string | null;
  runbookTitle: string;
  status: RunbookExecutionRecord["status"];
  startedAt: string;
  idleTimeoutMinutes?: number;
  parameterValues: ExecutionParameterValues;
  source: RunbookExecutionRecord["source"];
  triggerContext?: RunbookTriggerContext;
  actions: Array<
    Pick<RunbookActionRecord, "id" | "type" | "title"> & { order?: number }
  >;
  parameterDefinitions: Iterable<Pick<RunbookActionParameter, "key" | "secure">>;
  globals: Record<string, string>;
  globalDefinitions: Iterable<ExecutionGlobalDefinitionLike>;
}

export interface ExecutionSessionStateLike {
  parameterValues: ExecutionParameterValues;
  redactedParameterValues: ExecutionParameterValues;
  secureParameterKeys: Set<string>;
  secureGlobalKeys: Set<string>;
  redactor: SecureRedactor;
  snapshot: RunbookExecutionRecord;
  idleTimeoutMs?: number;
}

function collectSecureValueKeysFromDefinitions(
  definitions: Iterable<SecureValueDefinitionLike>,
): Set<string> {
  const secureKeys = new Set<string>();

  for (const definition of definitions) {
    if (definition.secure === true) {
      secureKeys.add(definition.key);
    }
  }

  return secureKeys;
}

function buildDerivedSecureValues(value: string): string[] {
  const derived = new Set<string>();

  for (const encode of [encodeURIComponent, encodeURI]) {
    try {
      const encoded = encode(value);
      if (encoded !== value) {
        derived.add(encoded);
      }
    } catch {
      // Ignore values the URL encoder cannot represent.
    }
  }

  return [...derived];
}

function buildSecureValueDescriptors(
  secureParameterKeys: Set<string>,
  parameterValues: ExecutionParameterValues,
  secureGlobalKeys: Set<string>,
  globals: Record<string, string>,
): SecureValueDescriptor[] {
  return [
    ...[...secureParameterKeys].flatMap((key) => {
      const value = parameterValues[key];
      if (typeof value !== "string" || value.length === 0) {
        return [];
      }

      return [
        {
          key,
          namespace: "params",
          value,
          derivedValues: buildDerivedSecureValues(value),
        } satisfies SecureValueDescriptor,
      ];
    }),
    ...[...secureGlobalKeys].flatMap((key) => {
      const value = globals[key];
      if (typeof value !== "string" || value.length === 0) {
        return [];
      }

      return [
        {
          key,
          namespace: "globals",
          value,
          derivedValues: buildDerivedSecureValues(value),
        } satisfies SecureValueDescriptor,
      ];
    }),
  ];
}

function redactParameterValues(
  parameterValues: ExecutionParameterValues,
  secureParameterKeys: Set<string>,
  redactor: SecureRedactor,
): ExecutionParameterValues {
  const redacted = redactor.redact({ ...parameterValues });

  for (const key of secureParameterKeys) {
    if (Object.prototype.hasOwnProperty.call(parameterValues, key)) {
      redacted[key] = getSecureRedactionMarker({
        key,
        namespace: "params",
      });
    }
  }

  return redacted;
}

export function buildInitialExecutionSteps(
  actions: CreateExecutionSessionStateInput["actions"],
): RunbookExecutionRecord["steps"] {
  return actions.map((action, index) => ({
    actionId: action.id,
    order: action.order ?? index + 1,
    type: action.type,
    title: action.title,
    status: "pending",
  }));
}

export function createInitialExecutionSnapshot(input: {
  executionId: string;
  runbookId: string;
  incidentThreadId?: string | null;
  runbookTitle: string;
  status: RunbookExecutionRecord["status"];
  startedAt: string;
  idleTimeoutMinutes?: number;
  parameterValues?: Record<string, string>;
  source: RunbookExecutionRecord["source"];
  triggerContext?: RunbookTriggerContext;
  steps: RunbookExecutionRecord["steps"];
}): RunbookExecutionRecord {
  const snapshot: RunbookExecutionRecord = {
    executionId: input.executionId,
    runbookId: input.runbookId,
    runbookTitle: input.runbookTitle,
    status: input.status,
    snapshotVersion: 1,
    startedAt: input.startedAt,
    idleTimeoutMinutes: input.idleTimeoutMinutes,
    lastActivityAt: input.startedAt,
    parameterValues: input.parameterValues,
    source: input.source,
    steps: input.steps,
  };

  if (input.incidentThreadId !== null && input.incidentThreadId !== undefined) {
    snapshot.incidentThreadId = input.incidentThreadId;
  }

  if (input.triggerContext !== undefined) {
    snapshot.triggerContext = input.triggerContext;
  }

  return snapshot;
}

function idleTimeoutMinutesToMs(
  idleTimeoutMinutes: number | undefined,
  millisecondsPerMinute = 60_000,
): number | undefined {
  if (typeof idleTimeoutMinutes === "number" && idleTimeoutMinutes > 0) {
    return idleTimeoutMinutes * millisecondsPerMinute;
  }

  return undefined;
}

export function createExecutionSessionState(
  input: CreateExecutionSessionStateInput,
): ExecutionSessionStateLike {
  const secureParameterKeys = collectSecureValueKeysFromDefinitions(
    input.parameterDefinitions,
  );
  const secureGlobalKeys = collectSecureValueKeysFromDefinitions(
    input.globalDefinitions,
  );
  const redactor = new SecureRedactor(
    buildSecureValueDescriptors(
      secureParameterKeys,
      input.parameterValues,
      secureGlobalKeys,
      input.globals,
    ),
  );
  const redactedParameterValues = redactParameterValues(
    input.parameterValues,
    secureParameterKeys,
    redactor,
  );
  const snapshot = createInitialExecutionSnapshot({
    executionId: input.executionId,
    runbookId: input.runbookId,
    incidentThreadId: input.incidentThreadId,
    runbookTitle: input.runbookTitle,
    status: input.status,
    startedAt: input.startedAt,
    idleTimeoutMinutes: input.idleTimeoutMinutes,
    parameterValues: redactedParameterValues,
    source: input.source,
    triggerContext: input.triggerContext,
    steps: buildInitialExecutionSteps(input.actions),
  });

  return {
    parameterValues: input.parameterValues,
    redactedParameterValues,
    secureParameterKeys,
    secureGlobalKeys,
    redactor,
    snapshot,
    idleTimeoutMs: idleTimeoutMinutesToMs(input.idleTimeoutMinutes),
  };
}
