import type {
  RunbookActionRecord,
  RunbookActionType,
  RunbookRecord,
} from "./desktop-runbook.types";

export type RunbookAuthoringProposalKind =
  | "edit_existing_runbook"
  | "create_new_runbook";

export type RunbookAuthoringProposalStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "revision_requested";

export type RunbookAuthoringRiskLabel =
  | "shell"
  | "http_write"
  | "webhook"
  | "external_source"
  | "secret_consuming"
  | "local_ai"
  | "unsupported";

export type RunbookAuthoringOperationType =
  | "create_runbook"
  | "update_metadata"
  | "add_action"
  | "update_action"
  | "delete_action"
  | "reorder_actions";

export interface RunbookAuthoringOperation {
  id: string;
  type: RunbookAuthoringOperationType;
  rationale: string;
  riskLabels?: RunbookAuthoringRiskLabel[];
  metadata?: {
    title?: string;
    description?: string;
    idleTimeout?: number;
  };
  action?: RunbookActionRecord;
  actionId?: string;
  insertAfterActionId?: string | null;
  actionIdsInOrder?: string[];
}

export interface RunbookAuthoringOperationDiff {
  operationId: string;
  type: RunbookAuthoringOperationType;
  rationale: string;
  riskLabels: RunbookAuthoringRiskLabel[];
  before: unknown;
  after: unknown;
}

export interface RunbookAuthoringValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface RunbookAuthoringBaseProposal {
  id: string;
  kind: RunbookAuthoringProposalKind;
  status: RunbookAuthoringProposalStatus;
  incidentThreadId?: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  operationDiffs: RunbookAuthoringOperationDiff[];
  validation: RunbookAuthoringValidationResult;
}

export interface RunbookEditAuthoringProposal
  extends RunbookAuthoringBaseProposal {
  kind: "edit_existing_runbook";
  targetRunbookId: string;
  targetRevisionNumber: number;
  targetRevisionHash: string;
  operations: RunbookAuthoringOperation[];
  originalRunbook: RunbookRecord;
  proposedRunbook: RunbookRecord;
}

export interface RunbookCreateAuthoringProposal
  extends RunbookAuthoringBaseProposal {
  kind: "create_new_runbook";
  proposedRunbook: RunbookRecord;
}

export type RunbookAuthoringProposal =
  | RunbookEditAuthoringProposal
  | RunbookCreateAuthoringProposal;

export interface CreateRunbookEditProposalInput {
  id?: string;
  incidentThreadId?: string;
  prompt: string;
  targetRunbook: RunbookRecord;
  operations: RunbookAuthoringOperation[];
  now?: string;
}

export interface CreateRunbookCreationProposalInput {
  id?: string;
  incidentThreadId?: string;
  prompt: string;
  draftRunbook: Omit<
    RunbookRecord,
    "id" | "revisionNumber" | "createdAt" | "updatedAt"
  > & {
    id?: string;
    revisionNumber?: number;
    createdAt?: string;
    updatedAt?: string;
  };
  now?: string;
}

export interface RunbookAuthoringApprovalInput {
  proposal: RunbookAuthoringProposal;
  approvedOperationIds?: string[];
  now?: string;
}

export interface RunbookAuthoringApprovalResult {
  proposal: RunbookAuthoringProposal;
  approvedOperationIds: string[];
  runbook: RunbookRecord;
}

export interface RunbookAuthoringRejectionInput {
  proposal: RunbookAuthoringProposal;
  reason?: string;
  now?: string;
}

export interface RunbookAuthoringRevisionRequestInput {
  proposal: RunbookAuthoringProposal;
  requestedEdit: string;
  now?: string;
}

export interface RunbookAuthoringDecisionResult {
  proposal: RunbookAuthoringProposal;
  reason?: string;
  requestedEdit?: string;
}

type MutableRunbook = RunbookRecord & {
  actions: RunbookActionRecord[];
};

function nowIso(value?: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  return new Date().toISOString();
}

function createAuthoringId(): string {
  const cryptoLike = (globalThis as {
    crypto?: {
      randomUUID?: () => string;
      getRandomValues?: (array: Uint8Array) => Uint8Array;
    };
  }).crypto;

  if (typeof cryptoLike?.randomUUID === "function") {
    return cryptoLike.randomUUID();
  }

  if (typeof cryptoLike?.getRandomValues === "function") {
    const bytes = cryptoLike.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
    return [
      hex.slice(0, 4).join(""),
      hex.slice(4, 6).join(""),
      hex.slice(6, 8).join(""),
      hex.slice(8, 10).join(""),
      hex.slice(10, 16).join(""),
    ].join("-");
  }

  return "proposal-" + Math.random().toString(36).slice(2, 12);
}

function cloneRunbook(runbook: RunbookRecord): MutableRunbook {
  return {
    ...runbook,
    actions: runbook.actions.map((action) => cloneAction(action)),
  };
}

function cloneAction(action: RunbookActionRecord): RunbookActionRecord {
  let logFilter: RunbookActionRecord["logFilter"];
  if (action.logFilter !== undefined) {
    logFilter = cloneStructuredValue(action.logFilter);
  }

  let telemetryConfig: RunbookActionRecord["telemetryConfig"];
  if (action.telemetryConfig !== undefined) {
    telemetryConfig = cloneStructuredValue(action.telemetryConfig);
  }

  return {
    ...action,
    headers: action.headers?.map((header) => ({ ...header })),
    parameters: action.parameters?.map((parameter) => ({ ...parameter })),
    logFilter,
    telemetryConfig,
  };
}

function normalizeString(value: string | undefined): string {
  if (typeof value === "string") {
    return value.trim();
  }

  return "";
}

function cloneStructuredValue<TValue>(value: TValue): TValue {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as TValue;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableSerialize(entryValue)}`,
      );
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}

export function getRunbookAuthoringRevisionHash(
  runbook: RunbookRecord,
): string {
  return stableSerialize({
    id: runbook.id,
    title: runbook.title,
    description: runbook.description,
    idleTimeout: runbook.idleTimeout,
    revisionNumber: runbook.revisionNumber,
    actions: runbook.actions,
  });
}

function actionTypeRiskLabels(
  type: RunbookActionType,
): RunbookAuthoringRiskLabel[] {
  switch (type) {
    case "shell":
      return ["shell"];
    case "http":
      return [];
    case "external_source":
    case "data_source_query":
      return ["external_source"];
    case "llm":
      return ["local_ai"];
    case "telemetry_ingest":
    case "diagnosis_diagnose":
    case "diagnosis_verify":
    case "diagnosis_recommend":
    case "telemetry_existing_entry":
      return [];
    default:
      return ["unsupported"];
  }
}

function getActionRiskLabels(
  action: RunbookActionRecord,
): RunbookAuthoringRiskLabel[] {
  const labels = new Set<RunbookAuthoringRiskLabel>(
    actionTypeRiskLabels(action.type),
  );

  if (
    action.type === "http" &&
    action.method !== undefined &&
    action.method !== "GET"
  ) {
    labels.add("http_write");
  }

  if (
    action.type === "http" &&
    typeof action.url === "string" &&
    /webhook/i.test(action.url)
  ) {
    labels.add("webhook");
  }

  if (action.parameters?.some((parameter) => parameter.secure === true)) {
    labels.add("secret_consuming");
  }

  return [...labels].sort();
}

function getOperationRiskLabels(
  operation: RunbookAuthoringOperation,
): RunbookAuthoringRiskLabel[] {
  const labels = new Set<RunbookAuthoringRiskLabel>(
    operation.riskLabels ?? [],
  );

  if (operation.action !== undefined) {
    for (const label of getActionRiskLabels(operation.action)) {
      labels.add(label);
    }
  }

  return [...labels].sort();
}

function validateRunbook(runbook: RunbookRecord): RunbookAuthoringValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const title = normalizeString(runbook.title);

  if (title.length === 0) {
    errors.push("Runbook title is required.");
  }

  if (runbook.actions.length === 0) {
    warnings.push("Runbook has no actions.");
  }

  const seenActionIds = new Set<string>();
  for (const action of runbook.actions) {
    const actionId = normalizeString(action.id);
    if (actionId.length === 0) {
      errors.push("Runbook action id is required.");
    } else if (seenActionIds.has(actionId)) {
      errors.push(`Duplicate runbook action id "${actionId}".`);
    }
    seenActionIds.add(actionId);

    if (normalizeString(action.title).length === 0) {
      errors.push(`Runbook action "${actionId}" title is required.`);
    }

    if (action.type === "shell" && normalizeString(action.command).length === 0) {
      errors.push(`Shell action "${action.title}" is missing a command.`);
    }

    if (action.type === "llm" && normalizeString(action.prompt).length === 0) {
      errors.push(`LLM action "${action.title}" is missing a prompt.`);
    }

    if (action.type === "http" && normalizeString(action.url).length === 0) {
      errors.push(`HTTP action "${action.title}" is missing a URL.`);
    }

    if (
      (action.type === "external_source" || action.type === "data_source_query") &&
      normalizeString(action.query).length === 0
    ) {
      errors.push(`Data-source action "${action.title}" is missing a query.`);
    }

    if (
      action.parameters?.some(
        (parameter) =>
          parameter.secure === true &&
          typeof parameter.defaultValue === "string" &&
          parameter.defaultValue.length > 0,
      ) === true
    ) {
      errors.push(
        `Action "${action.title}" includes a plaintext default for a secure parameter.`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function insertAction(
  runbook: MutableRunbook,
  action: RunbookActionRecord,
  insertAfterActionId: string | null | undefined,
): void {
  const nextAction = cloneAction(action);
  if (insertAfterActionId === null || insertAfterActionId === undefined) {
    runbook.actions.push(nextAction);
    return;
  }

  const insertIndex = runbook.actions.findIndex(
    (existing) => existing.id === insertAfterActionId,
  );
  if (insertIndex === -1) {
    throw new Error(
      `Cannot insert action after missing action "${insertAfterActionId}".`,
    );
  }

  runbook.actions.splice(insertIndex + 1, 0, nextAction);
}

function applyOperation(
  runbook: MutableRunbook,
  operation: RunbookAuthoringOperation,
): void {
  switch (operation.type) {
    case "create_runbook": {
      throw new Error("Create-runbook operations are represented as proposals.");
    }
    case "update_metadata": {
      if (operation.metadata?.title !== undefined) {
        runbook.title = operation.metadata.title;
      }
      if (operation.metadata?.description !== undefined) {
        runbook.description = operation.metadata.description;
      }
      if (operation.metadata?.idleTimeout !== undefined) {
        runbook.idleTimeout = operation.metadata.idleTimeout;
      }
      return;
    }
    case "add_action": {
      if (operation.action === undefined) {
        throw new Error(`Operation "${operation.id}" is missing an action.`);
      }
      if (
        runbook.actions.some((existing) => existing.id === operation.action?.id)
      ) {
        throw new Error(
          `Operation "${operation.id}" would duplicate action "${operation.action.id}".`,
        );
      }
      insertAction(runbook, operation.action, operation.insertAfterActionId);
      return;
    }
    case "update_action": {
      if (operation.action === undefined) {
        throw new Error(`Operation "${operation.id}" is missing an action.`);
      }
      const actionId = operation.actionId ?? operation.action.id;
      const index = runbook.actions.findIndex((action) => action.id === actionId);
      if (index === -1) {
        throw new Error(`Operation "${operation.id}" targets a missing action.`);
      }
      runbook.actions[index] = cloneAction(operation.action);
      return;
    }
    case "delete_action": {
      if (operation.actionId === undefined) {
        throw new Error(`Operation "${operation.id}" is missing an action id.`);
      }
      const nextActions = runbook.actions.filter(
        (action) => action.id !== operation.actionId,
      );
      if (nextActions.length === runbook.actions.length) {
        throw new Error(`Operation "${operation.id}" targets a missing action.`);
      }
      runbook.actions = nextActions;
      return;
    }
    case "reorder_actions": {
      if (operation.actionIdsInOrder === undefined) {
        throw new Error(
          `Operation "${operation.id}" is missing action order data.`,
        );
      }
      const actionsById = new Map(
        runbook.actions.map((action) => [action.id, action] as const),
      );
      if (operation.actionIdsInOrder.length !== runbook.actions.length) {
        throw new Error(
          `Operation "${operation.id}" must include every action id exactly once.`,
        );
      }
      runbook.actions = operation.actionIdsInOrder.map((actionId) => {
        const action = actionsById.get(actionId);
        if (action === undefined) {
          throw new Error(
            `Operation "${operation.id}" references missing action "${actionId}".`,
          );
        }
        return action;
      });
      return;
    }
    default:
      throw new Error(`Unsupported runbook authoring operation.`);
  }
}

function buildSequentialOperationDiffs(
  runbook: RunbookRecord,
  operations: RunbookAuthoringOperation[],
): RunbookAuthoringOperationDiff[] {
  const diffs: RunbookAuthoringOperationDiff[] = [];
  let currentRunbook = cloneRunbook(runbook);

  for (const operation of operations) {
    const beforeRunbook = cloneRunbook(currentRunbook);
    applyOperation(currentRunbook, operation);
    diffs.push({
      operationId: operation.id,
      type: operation.type,
      rationale: operation.rationale,
      riskLabels: getOperationRiskLabels(operation),
      before: beforeRunbook,
      after: cloneRunbook(currentRunbook),
    });
  }

  return diffs;
}

function cloneOperation(
  operation: RunbookAuthoringOperation,
): RunbookAuthoringOperation {
  let metadata: RunbookAuthoringOperation["metadata"];
  if (operation.metadata !== undefined) {
    metadata = { ...operation.metadata };
  }

  let action: RunbookAuthoringOperation["action"];
  if (operation.action !== undefined) {
    action = cloneAction(operation.action);
  }

  return {
    ...operation,
    riskLabels: operation.riskLabels?.slice(),
    metadata,
    action,
    actionIdsInOrder: operation.actionIdsInOrder?.slice(),
  };
}

function applyOperations(
  runbook: RunbookRecord,
  operations: RunbookAuthoringOperation[],
): MutableRunbook {
  const nextRunbook = cloneRunbook(runbook);
  for (const operation of operations) {
    applyOperation(nextRunbook, operation);
  }
  return nextRunbook;
}

function normalizeProposalStatus<TProposal extends RunbookAuthoringProposal>(
  proposal: TProposal,
  status: RunbookAuthoringProposalStatus,
  updatedAt: string,
): TProposal {
  return {
    ...proposal,
    status,
    updatedAt,
  };
}

export function createRunbookEditProposal(
  input: CreateRunbookEditProposalInput,
): RunbookEditAuthoringProposal {
  const createdAt = nowIso(input.now);
  const proposedRunbook = applyOperations(input.targetRunbook, input.operations);
  proposedRunbook.revisionNumber = input.targetRunbook.revisionNumber + 1;
  proposedRunbook.updatedAt = createdAt;

  return {
    id: input.id ?? createAuthoringId(),
    kind: "edit_existing_runbook",
    status: "pending_approval",
    incidentThreadId: input.incidentThreadId,
    prompt: input.prompt,
    createdAt,
    updatedAt: createdAt,
    targetRunbookId: input.targetRunbook.id,
    targetRevisionNumber: input.targetRunbook.revisionNumber,
    targetRevisionHash: getRunbookAuthoringRevisionHash(input.targetRunbook),
    operations: input.operations.map((operation) => cloneOperation(operation)),
    originalRunbook: cloneRunbook(input.targetRunbook),
    proposedRunbook,
    operationDiffs: buildSequentialOperationDiffs(
      input.targetRunbook,
      input.operations,
    ),
    validation: validateRunbook(proposedRunbook),
  };
}

export function createRunbookCreationProposal(
  input: CreateRunbookCreationProposalInput,
): RunbookCreateAuthoringProposal {
  const createdAt = nowIso(input.now);
  const proposedRunbook: RunbookRecord = {
    id: input.draftRunbook.id ?? createAuthoringId(),
    title: input.draftRunbook.title,
    description: input.draftRunbook.description,
    idleTimeout: input.draftRunbook.idleTimeout,
    revisionNumber: input.draftRunbook.revisionNumber ?? 1,
    actions: input.draftRunbook.actions.map((action) => cloneAction(action)),
    createdAt: input.draftRunbook.createdAt ?? createdAt,
    updatedAt: input.draftRunbook.updatedAt ?? createdAt,
  };

  const creationOperation: RunbookAuthoringOperationDiff = {
    operationId: "create-runbook",
    type: "create_runbook",
    rationale: "Create a new runbook draft.",
    riskLabels: [
      ...new Set(
        proposedRunbook.actions.flatMap((action) => getActionRiskLabels(action)),
      ),
    ].sort(),
    before: null,
    after: proposedRunbook,
  };

  return {
    id: input.id ?? createAuthoringId(),
    kind: "create_new_runbook",
    status: "pending_approval",
    incidentThreadId: input.incidentThreadId,
    prompt: input.prompt,
    createdAt,
    updatedAt: createdAt,
    proposedRunbook,
    operationDiffs: [creationOperation],
    validation: validateRunbook(proposedRunbook),
  };
}

export function approveRunbookAuthoringProposal(
  input: RunbookAuthoringApprovalInput,
): RunbookAuthoringApprovalResult {
  if (input.proposal.status !== "pending_approval") {
    throw new Error("Only pending runbook authoring proposals can be approved.");
  }

  const updatedAt = nowIso(input.now);
  if (input.proposal.kind === "create_new_runbook") {
    if (!input.proposal.validation.valid) {
      throw new Error("Invalid runbook creation proposals cannot be approved.");
    }

    const runbook = cloneRunbook(input.proposal.proposedRunbook);
    runbook.createdAt = updatedAt;
    runbook.updatedAt = updatedAt;

    return {
      proposal: normalizeProposalStatus(input.proposal, "approved", updatedAt),
      approvedOperationIds: ["create-runbook"],
      runbook,
    };
  }

  const allOperationIds = input.proposal.operationDiffs.map(
    (diff) => diff.operationId,
  );
  let approvedOperationIds = allOperationIds;
  if (input.approvedOperationIds !== undefined) {
    approvedOperationIds = input.approvedOperationIds;
  }
  const approvedOperationIdSet = new Set(approvedOperationIds);
  const selectedOperations = input.proposal.operations.filter((operation) =>
    approvedOperationIdSet.has(operation.id),
  );

  if (selectedOperations.length !== approvedOperationIdSet.size) {
    throw new Error("Approval references an unknown runbook authoring operation.");
  }

  if (selectedOperations.length === 0) {
    throw new Error("At least one runbook authoring operation must be approved.");
  }

  const runbook = applyOperations(
    input.proposal.originalRunbook,
    selectedOperations,
  );
  runbook.revisionNumber = input.proposal.targetRevisionNumber + 1;
  runbook.updatedAt = updatedAt;
  const validation = validateRunbook(runbook);
  if (!validation.valid) {
    throw new Error(
      `Approved runbook authoring operations produce an invalid runbook: ${validation.errors.join(
        " ",
      )}`,
    );
  }

  return {
    proposal: normalizeProposalStatus(input.proposal, "approved", updatedAt),
    approvedOperationIds,
    runbook,
  };
}

export function rejectRunbookAuthoringProposal(
  input: RunbookAuthoringRejectionInput,
): RunbookAuthoringDecisionResult {
  return {
    proposal: normalizeProposalStatus(
      input.proposal,
      "rejected",
      nowIso(input.now),
    ),
    reason: input.reason,
  };
}

export function requestRunbookAuthoringRevision(
  input: RunbookAuthoringRevisionRequestInput,
): RunbookAuthoringDecisionResult {
  if (normalizeString(input.requestedEdit).length === 0) {
    throw new Error("A requested edit is required to revise a proposal.");
  }

  return {
    proposal: normalizeProposalStatus(
      input.proposal,
      "revision_requested",
      nowIso(input.now),
    ),
    requestedEdit: input.requestedEdit,
  };
}
