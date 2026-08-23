import type {
  RunbookActionParameter,
  RunbookActionRecord,
  RunbookActionType,
  RunbookRecord,
} from "./desktop-runbook.types";
import { MAX_RUNBOOK_IDLE_TIMEOUT_MINUTES } from "./desktop-runbook.types";
import type { DesktopPluginDescriptor } from "../plugins/plugins.types";
import { resolveCatalogModel, resolveCatalogModelForProvider } from "../llm/modelCatalog";

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
  sourceAttachmentId?: string;
  sourceMessageId?: string;
  normalizedFindings?: unknown[];
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

export const CVE_FINDINGS_PLUGIN_ID = "linux-cve-status";
export const CVE_FINDINGS_PLUGIN_ACTION_ID = "evaluate_remediation";
export const CVE_FINDINGS_PARAMETER_KEY = "findings";

export class RunbookProposalValidationError extends Error {
  readonly code = "RUNBOOK_PROPOSAL_VALIDATION" as const;

  constructor(message: string) {
    super(message);
    this.name = "RunbookProposalValidationError";
  }
}

export interface CreateRunbookEditProposalInput {
  id?: string;
  incidentThreadId?: string;
  prompt: string;
  targetRunbook: RunbookRecord;
  operations: RunbookAuthoringOperation[];
  sourceAttachmentId?: string;
  sourceMessageId?: string;
  normalizedFindings?: unknown[];
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
  sourceAttachmentId?: string;
  sourceMessageId?: string;
  normalizedFindings?: unknown[];
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

export interface RunbookTemplateAction {
  command?: string;
  prompt?: string;
  url?: string;
  headers?: Array<{ key: string; value: string }>;
  body?: string;
  pluginInput?: string;
  pluginAuth?: string;
  query?: string;
  parameters?: Array<Pick<RunbookActionParameter, "key">>;
}

export interface UnknownRunbookTemplatePlaceholder {
  field: string;
  path: Array<string | number>;
  key: string;
}

const RUNBOOK_TEMPLATE_FIELDS = [
  "command",
  "prompt",
  "url",
  "body",
  "pluginInput",
  "pluginAuth",
  "query",
] as const;

function actionUsesFindings(action: RunbookActionRecord): boolean {
  if (
    action.parameters?.some(
      (parameter) =>
        normalizeString(parameter.key) === CVE_FINDINGS_PARAMETER_KEY,
    ) === true
  ) {
    return true;
  }

  const values = RUNBOOK_TEMPLATE_FIELDS.map((field) => action[field]);
  values.push(
    ...(action.headers?.flatMap((header) => [header.key, header.value]) ?? []),
  );
  return values.some(
    (value) =>
      typeof value === "string" &&
      /\{\{\s*findings\s*\}\}/.test(value),
  );
}

function hasCveFindingsPlugin(actions: RunbookActionRecord[]): boolean {
  return actions.some(
    (action) =>
      action.type === "plugin" &&
      normalizeString(action.pluginId) === CVE_FINDINGS_PLUGIN_ID &&
      normalizeString(action.pluginActionId) === CVE_FINDINGS_PLUGIN_ACTION_ID,
  );
}

function assertCveFindingsPluginRequirement(
  actions: RunbookActionRecord[],
  normalizedFindings: unknown[] | undefined,
): void {
  if (
    normalizedFindings === undefined ||
    normalizedFindings.length === 0 ||
    !actions.some(actionUsesFindings) ||
    hasCveFindingsPlugin(actions)
  ) {
    return;
  }

  throw new RunbookProposalValidationError(
    "CVE findings require the linux-cve-status/evaluate_remediation plugin before an LLM summary. Revise the runbook to add the plugin and then summarize its output.",
  );
}

export function getUnknownRunbookTemplatePlaceholders(
  action: RunbookTemplateAction,
): UnknownRunbookTemplatePlaceholder[] {
  const parameterKeys = new Set(
    action.parameters
      ?.map((parameter) => normalizeString(parameter.key))
      .filter((key) => key.length > 0),
  );
  const unknown: UnknownRunbookTemplatePlaceholder[] = [];
  const seen = new Set<string>();
  const inspect = (value: string | undefined, field: string, path: Array<string | number>): void => {
    if (value === undefined) return;
    const pattern = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
      const key = match[1]?.trim();
      if (key === undefined || parameterKeys.has(key)) continue;
      const identity = `${field}:${key}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      unknown.push({ field, path, key });
    }
  };

  for (const field of RUNBOOK_TEMPLATE_FIELDS) {
    inspect(action[field], field, [field]);
  }
  action.headers?.forEach((header, index) => {
    inspect(header.key, `headers[${String(index)}].key`, ["headers", index, "key"]);
    inspect(header.value, `headers[${String(index)}].value`, ["headers", index, "value"]);
  });

  return unknown;
}

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

  throw new Error("Secure random values are required to create an authoring proposal id");
}

function cloneRunbook(runbook: RunbookRecord): MutableRunbook {
  return {
    ...runbook,
    actions: runbook.actions.map((action) => cloneAction(action)),
  };
}

function cloneAction(action: RunbookActionRecord): RunbookActionRecord {
  return {
    ...action,
    headers: action.headers?.map((header) => ({ ...header })),
    parameters: action.parameters?.map((parameter) => ({ ...parameter })),
    logFilter:
      action.logFilter === undefined
        ? undefined
        : JSON.parse(JSON.stringify(action.logFilter)),
    telemetryConfig:
      action.telemetryConfig === undefined
        ? undefined
        : JSON.parse(JSON.stringify(action.telemetryConfig)),
  };
}

function normalizeString(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
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
    case "plugin":
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

  if (
    action.type === "plugin" &&
    typeof action.pluginAuth === "string" &&
    action.pluginAuth.trim().length > 0
  ) {
    labels.add("secret_consuming");
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

function validateRunbookAction(
  action: RunbookActionRecord,
  seenActionIds: Set<string>,
  errors: string[],
): void {
  validateRunbookActionIdentity(action, seenActionIds, errors);
  validateRunbookActionFields(action, errors);
  validateRunbookActionSecurity(action, errors);
}

function validateRunbookActionIdentity(
  action: RunbookActionRecord,
  seenActionIds: Set<string>,
  errors: string[],
): void {
  const actionId = normalizeString(action.id);
  if (actionId.length === 0) {
    errors.push("Runbook action id is required.");
  } else if (seenActionIds.has(actionId)) {
    errors.push(`Duplicate runbook action id "${actionId}".`);
  }
  seenActionIds.add(actionId);

  if (normalizeString(action.title).length === 0) errors.push(`Runbook action "${actionId}" title is required.`);
}

function validateRunbookActionFields(action: RunbookActionRecord, errors: string[]): void {
  for (const placeholder of getUnknownRunbookTemplatePlaceholders(action)) {
    errors.push(
      `Action "${action.title}" references unknown placeholder "{{${placeholder.key}}}" in ${placeholder.field}. Declare it as an action parameter.`,
    );
  }

  switch (action.type) {
    case "shell":
      validateRequiredActionField(action.command, `Shell action "${action.title}" is missing a command.`, errors);
      return;
    case "llm":
      validateLlmActionFields(action, errors);
      return;
    case "http":
      validateRequiredActionField(action.url, `HTTP action "${action.title}" is missing a URL.`, errors);
      return;
    case "external_source":
      validateDataSourceActionFields(action, errors);
      validateRequiredActionField(action.sourceId, `External Source action "${action.title}" is missing a source selection.`, errors);
      return;
    case "data_source_query":
      validateDataSourceActionFields(action, errors);
      return;
    case "plugin":
      validatePluginActionFields(action, errors);
      return;
    default:
      return;
  }
}

function validateRequiredActionField(value: string | undefined, message: string, errors: string[]): void {
  if (normalizeString(value).length === 0) errors.push(message);
}

function validateLlmActionFields(action: RunbookActionRecord, errors: string[]): void {
  validateRequiredActionField(action.prompt, `LLM action "${action.title}" is missing a prompt.`, errors);
  const model = normalizeString(action.llmModel);
  if (model.length === 0 || /^\{\{[^{}]+\}\}$/.test(model)) return;

  const resolved = action.llmProviderKey === undefined
    ? resolveCatalogModel(model)
    : resolveCatalogModelForProvider(action.llmProviderKey, model);
  if (resolved === undefined) {
    errors.push(`LLM action "${action.title}" references unknown model "${model}". Use a model ID or display name from the catalog.`);
    return;
  }
  if (action.llmProviderKey !== undefined && action.llmProviderKey !== resolved.providerKey) {
    errors.push(`LLM action "${action.title}" model "${model}" belongs to provider "${resolved.providerKey}", not "${action.llmProviderKey}".`);
  }
}

function validateDataSourceActionFields(action: RunbookActionRecord, errors: string[]): void {
  validateRequiredActionField(action.query, `Data-source action "${action.title}" is missing a query.`, errors);
}

function validatePluginActionFields(action: RunbookActionRecord, errors: string[]): void {
  validateRequiredActionField(action.pluginId, `Plugin action "${action.title}" is missing a selected plugin.`, errors);
  validateRequiredActionField(action.pluginActionId, `Plugin action "${action.title}" is missing a selected plugin action.`, errors);
}

function validateRunbookActionSecurity(action: RunbookActionRecord, errors: string[]): void {
  if (action.parameters?.some((parameter) => parameter.secure === true && typeof parameter.defaultValue === "string" && parameter.defaultValue.length > 0) === true) {
    errors.push(`Action "${action.title}" includes a plaintext default for a secure parameter.`);
  }
}

function validatePluginActionAuth(
  action: RunbookActionRecord,
  pluginsById: Map<string, DesktopPluginDescriptor>,
): string[] {
  const errors: string[] = [];
  if (action.type !== "plugin") return errors;

  const pluginId = normalizeString(action.pluginId);
  if (pluginId.length === 0) return errors;

  const plugin = pluginsById.get(pluginId);
  if (plugin === undefined) {
    errors.push(`Plugin action "${action.title}" references unknown plugin "${pluginId}".`);
    return errors;
  }

  const pluginAuth = normalizeString(action.pluginAuth);
  if (pluginAuth.length === 0) return errors;

  let parsedAuth: unknown;
  try {
    parsedAuth = JSON.parse(pluginAuth);
  } catch {
    errors.push(`Plugin action "${action.title}" has invalid pluginAuth JSON.`);
    return errors;
  }

  if (parsedAuth === null || typeof parsedAuth !== "object" || Array.isArray(parsedAuth)) {
    errors.push(`Plugin action "${action.title}" pluginAuth must be a JSON object.`);
    return errors;
  }

  const expectedKeys = plugin.auth.fields.map((field) => field.key);
  const expectedKeySet = new Set(expectedKeys);
  for (const key of Object.keys(parsedAuth)) {
    if (expectedKeySet.has(key)) continue;
    const expected = expectedKeys.length > 0 ? expectedKeys.join(", ") : "none";
    errors.push(
      `Plugin action "${action.title}" uses unknown auth field "${key}" for plugin "${pluginId}". Expected auth fields: ${expected}.`,
    );
  }

  return errors;
}

export function validatePluginAuthContracts(
  runbook: RunbookRecord,
  plugins: DesktopPluginDescriptor[],
): string[] {
  const pluginsById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const errors: string[] = [];

  for (const action of runbook.actions) {
    errors.push(...validatePluginActionAuth(action, pluginsById));
  }

  return errors;
}

export function validateRunbook(runbook: RunbookRecord): RunbookAuthoringValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const title = normalizeString(runbook.title);

  if (title.length === 0) {
    errors.push("Runbook title is required.");
  }

  if (
    runbook.idleTimeout !== undefined &&
    (!Number.isInteger(runbook.idleTimeout) ||
      runbook.idleTimeout < 0 ||
      runbook.idleTimeout > MAX_RUNBOOK_IDLE_TIMEOUT_MINUTES)
  ) {
    errors.push(
      `Runbook idle timeout must be an integer from 0 to ${String(MAX_RUNBOOK_IDLE_TIMEOUT_MINUTES)} minutes.`,
    );
  }

  if (runbook.actions.length === 0) {
    warnings.push("Runbook has no actions.");
  }

  const seenActionIds = new Set<string>();
  for (const action of runbook.actions) {
    validateRunbookAction(action, seenActionIds, errors);
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

function applyMetadataOperation(runbook: MutableRunbook, operation: RunbookAuthoringOperation): void {
  if (operation.metadata?.title !== undefined) runbook.title = operation.metadata.title;
  if (operation.metadata?.description !== undefined) runbook.description = operation.metadata.description;
  if (operation.metadata?.idleTimeout !== undefined) runbook.idleTimeout = operation.metadata.idleTimeout;
}

function applyAddActionOperation(runbook: MutableRunbook, operation: RunbookAuthoringOperation): void {
  if (operation.action === undefined) throw new Error(`Operation "${operation.id}" is missing an action.`);
  if (runbook.actions.some((existing) => existing.id === operation.action?.id)) {
    throw new Error(`Operation "${operation.id}" would duplicate action "${operation.action.id}".`);
  }
  insertAction(runbook, operation.action, operation.insertAfterActionId);
}

function applyUpdateActionOperation(runbook: MutableRunbook, operation: RunbookAuthoringOperation): void {
  if (operation.action === undefined) throw new Error(`Operation "${operation.id}" is missing an action.`);
  const actionId = operation.actionId ?? operation.action.id;
  const index = runbook.actions.findIndex((action) => action.id === actionId);
  if (index === -1) throw new Error(`Operation "${operation.id}" targets a missing action. ${describeAvailableActions(runbook)}`);
  runbook.actions[index] = cloneAction(operation.action);
}

function applyDeleteActionOperation(runbook: MutableRunbook, operation: RunbookAuthoringOperation): void {
  if (operation.actionId === undefined) throw new Error(`Operation "${operation.id}" is missing an action id.`);
  const nextActions = runbook.actions.filter((action) => action.id !== operation.actionId);
  if (nextActions.length === runbook.actions.length) throw new Error(`Operation "${operation.id}" targets a missing action. ${describeAvailableActions(runbook)}`);
  runbook.actions = nextActions;
}

function applyReorderActionsOperation(runbook: MutableRunbook, operation: RunbookAuthoringOperation): void {
  if (operation.actionIdsInOrder === undefined) throw new Error(`Operation "${operation.id}" is missing action order data.`);
  const actionsById = new Map(runbook.actions.map((action) => [action.id, action] as const));
  if (operation.actionIdsInOrder.length !== runbook.actions.length) throw new Error(`Operation "${operation.id}" must include every action id exactly once.`);
  runbook.actions = operation.actionIdsInOrder.map((actionId) => {
    const action = actionsById.get(actionId);
    if (action === undefined) throw new Error(`Operation "${operation.id}" references missing action "${actionId}".`);
    return action;
  });
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
      applyMetadataOperation(runbook, operation);
      return;
    }
    case "add_action": {
      applyAddActionOperation(runbook, operation);
      return;
    }
    case "update_action": {
      applyUpdateActionOperation(runbook, operation);
      return;
    }
    case "delete_action": {
      applyDeleteActionOperation(runbook, operation);
      return;
    }
    case "reorder_actions": {
      applyReorderActionsOperation(runbook, operation);
      return;
    }
    default:
      throw new Error(`Unsupported runbook authoring operation.`);
  }
}

function describeAvailableActions(runbook: MutableRunbook): string {
  if (runbook.actions.length === 0) {
    return "Available actions: none."
  }

  return `Available actions: ${runbook.actions
    .map((action) => `${action.id} (${action.type}: ${action.title})`)
    .join(", ")}.`
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
  return {
    ...operation,
    riskLabels: operation.riskLabels?.slice(),
    metadata:
      operation.metadata === undefined ? undefined : { ...operation.metadata },
    action:
      operation.action === undefined ? undefined : cloneAction(operation.action),
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
  assertCveFindingsPluginRequirement(
    proposedRunbook.actions,
    input.normalizedFindings,
  );

  return {
    id: input.id ?? createAuthoringId(),
    kind: "edit_existing_runbook",
    status: "pending_approval",
    incidentThreadId: input.incidentThreadId,
    sourceAttachmentId: input.sourceAttachmentId,
    sourceMessageId: input.sourceMessageId,
    normalizedFindings: input.normalizedFindings,
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
  assertCveFindingsPluginRequirement(
    proposedRunbook.actions,
    input.normalizedFindings,
  );

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
    sourceAttachmentId: input.sourceAttachmentId,
    sourceMessageId: input.sourceMessageId,
    normalizedFindings: input.normalizedFindings,
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
  const approvedOperationIds =
    input.approvedOperationIds === undefined
      ? allOperationIds
      : input.approvedOperationIds;
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
