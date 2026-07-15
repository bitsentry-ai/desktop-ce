import {
  DiagnosisState,
  type DiagnosisStateValue,
} from "../value-objects/DiagnosisState";

/**
 * Log category type for RBAC filtering
 */
export type LogCategory =
  | "security"
  | "infrastructure"
  | "application"
  | "unknown";

export type DiagnosisSourceCategory =
  | "telemetry"
  | "unknown"
  | (string & {});

export type DiagnosisSourceKind =
  | "telemetry_entry"
  | "error_event"
  | "error_issue"
  | "unknown"
  | (string & {});

export type DiagnosisLogLevel = "infrastructure" | "application" | "unknown";

export type DiagnosisSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "info"
  | "unknown";

export interface DiagnosisSourceRef {
  sourceTableName: string;
  sourceFieldName: string;
  sourceKeyValue: string;
}

/**
 * State history entry for audit trail
 */
export interface StateHistoryEntry {
  fromState: DiagnosisStateValue | null;
  toState: DiagnosisStateValue;
  transitionedAt: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Operations that can produce diagnosis text
 */
export type DiagnosisOperation = "diagnose" | "verify" | "recommend";

/**
 * State texts associated with each operation
 *
 * Canonical keys (used for persistence):
 * - diagnose: AI diagnosis text (from diagnose operation)
 * - verify: Verification result text (from verify operation)
 * - recommend: Remediation recommendation text (from recommend operation)
 *
 * Legacy aliases (deprecated, kept for backward compatibility):
 * - assessment: Alias for diagnose
 * - verificationText: Alias for verify
 * - diagnosisConfirmation: Alias for verify
 * - actualRemediation: Alias for recommend
 *
 */
export interface StateTexts {
  /** Canonical: AI-generated diagnosis text */
  diagnose?: string;

  /** Canonical: Verification result from MCP tools */
  verify?: string;

  /** Canonical: Remediation recommendation text */
  recommend?: string;

  /** @deprecated Use diagnose instead - legacy alias for backward compatibility */
  assessment?: string;

  /** @deprecated Use verify instead - legacy alias for backward compatibility */
  verificationText?: string;

  /** @deprecated Use verify instead - legacy alias for backward compatibility */
  diagnosisConfirmation?: string;

  /** @deprecated Use recommend instead - legacy alias for backward compatibility */
  actualRemediation?: string;
}

interface TransitionOptions {
  operation?: DiagnosisOperation;
  text?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Props for DiagnosisRecord entity
 */
export interface DiagnosisRecordProps {
  id?: number;
  telemetryEntryId?: number;
  currentState: DiagnosisState;
  stateHistory: StateHistoryEntry[];
  stateTexts: StateTexts;
  createdAt?: Date;
  updatedAt?: Date;
  // Denormalized telemetry entry fields (populated via JOIN for list queries)
  ruleDescription?: string;
  agentName?: string;
  ruleLevel?: number;
  // LLM-refined category (can override initial category from ingestion)
  category?: LogCategory;
  categoryConfidence?: number;
  sourceCategory: DiagnosisSourceCategory;
  sourceKind: DiagnosisSourceKind;
  logLevel: DiagnosisLogLevel;
  severity: DiagnosisSeverity;
  description?: string;
  environment?: string;
  sourceMetadata?: Record<string, unknown>;
  normalizedData?: Record<string, unknown>;
  verificationData?: Record<string, unknown>;
  debugPayload?: Record<string, unknown>;
  sourceRef: DiagnosisSourceRef;
}

/**
 * Entity: DiagnosisRecord
 * Represents the diagnosis state machine for a telemetry entry
 */
export class DiagnosisRecord {
  private readonly _props: DiagnosisRecordProps;

  private constructor(props: DiagnosisRecordProps) {
    const telemetryEntryId = DiagnosisRecord.validTelemetryEntryId(
      props.telemetryEntryId,
    );

    this._props = {
      ...props,
      telemetryEntryId,
      stateHistory: DiagnosisRecord.normalizeStateHistory(props.stateHistory),
      category: props.category ?? "unknown",
      sourceRef: DiagnosisRecord.resolveSourceRef(props.sourceRef, telemetryEntryId),
    };
  }

  private static validTelemetryEntryId(value: number | undefined): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return undefined;
  }

  private static resolveSourceRef(
    sourceRef: DiagnosisSourceRef | undefined,
    telemetryEntryId: number | undefined,
  ): DiagnosisSourceRef {
    if (sourceRef !== undefined) return sourceRef;
    return DiagnosisRecord.defaultSourceRef(
      DiagnosisRecord.sourceKeyValueForTelemetryEntryId(telemetryEntryId),
    );
  }

  private static sourceKeyValueForTelemetryEntryId(
    telemetryEntryId: number | undefined,
  ): string {
    if (telemetryEntryId !== undefined) return String(telemetryEntryId);
    return "unknown";
  }

  private static normalizeStateHistory(
    stateHistory: unknown,
  ): StateHistoryEntry[] {
    if (Array.isArray(stateHistory)) {
      return stateHistory.filter((entry): entry is StateHistoryEntry =>
        DiagnosisRecord.isStateHistoryEntry(entry),
      );
    }

    if (typeof stateHistory === "string") {
      try {
        const parsed: unknown = JSON.parse(stateHistory);
        if (Array.isArray(parsed)) {
          return parsed.filter((entry): entry is StateHistoryEntry =>
            DiagnosisRecord.isStateHistoryEntry(entry),
          );
        }
      } catch {
        return [];
      }
    }

    return [];
  }

  private static defaultSourceRef(sourceKeyValue: string): DiagnosisSourceRef {
    return {
      sourceTableName: "TelemetryEntry",
      sourceFieldName: "id",
      sourceKeyValue,
    };
  }

  private static isStateHistoryEntry(value: unknown): value is StateHistoryEntry {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }

    return "toState" in value && "transitionedAt" in value;
  }

  static create(telemetryEntryId: number): DiagnosisRecord {
    return new DiagnosisRecord({
      telemetryEntryId,
      currentState: DiagnosisState.pending(),
      stateHistory: [],
      stateTexts: {},
      category: "unknown",
      sourceCategory: "telemetry",
      sourceKind: "telemetry_entry",
      logLevel: "infrastructure",
      severity: "unknown",
      sourceRef: DiagnosisRecord.defaultSourceRef(String(telemetryEntryId)),
    });
  }

  static fromPersistence(data: {
    id: number;
    telemetryEntryId?: number;
    currentState: string;
    stateHistory: StateHistoryEntry[];
    stateTexts: StateTexts;
    createdAt: Date;
    updatedAt: Date;
    ruleDescription?: string;
    agentName?: string;
    ruleLevel?: number;
    category?: LogCategory;
    categoryConfidence?: number;
    sourceCategory?: DiagnosisSourceCategory;
    sourceKind?: DiagnosisSourceKind;
    logLevel?: DiagnosisLogLevel;
    severity?: DiagnosisSeverity;
    description?: string;
    environment?: string;
    sourceMetadata?: Record<string, unknown>;
    normalizedData?: Record<string, unknown>;
    verificationData?: Record<string, unknown>;
    debugPayload?: Record<string, unknown>;
    sourceRef?: DiagnosisSourceRef;
  }): DiagnosisRecord {
    const sourceKeyValue = DiagnosisRecord.resolvePersistenceSourceKeyValue(data);
    return new DiagnosisRecord({
      id: data.id,
      telemetryEntryId: data.telemetryEntryId,
      currentState: DiagnosisState.create(data.currentState),
      stateHistory: data.stateHistory,
      stateTexts: data.stateTexts,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      ruleDescription: data.ruleDescription,
      agentName: data.agentName,
      ruleLevel: data.ruleLevel,
      category: data.category ?? "unknown",
      categoryConfidence: data.categoryConfidence,
      sourceCategory: data.sourceCategory ?? "telemetry",
      sourceKind: data.sourceKind ?? "telemetry_entry",
      logLevel: data.logLevel ?? "infrastructure",
      severity: data.severity ?? "unknown",
      description: data.description,
      environment: data.environment,
      sourceMetadata: data.sourceMetadata,
      normalizedData: data.normalizedData,
      verificationData: data.verificationData,
      debugPayload: data.debugPayload,
      sourceRef:
        data.sourceRef ?? DiagnosisRecord.defaultSourceRef(sourceKeyValue),
    });
  }

  private static resolvePersistenceSourceKeyValue(data: {
    telemetryEntryId?: number;
    sourceRef?: DiagnosisSourceRef;
  }): string {
    if (data.sourceRef?.sourceKeyValue !== undefined) {
      return data.sourceRef.sourceKeyValue;
    }

    return DiagnosisRecord.sourceKeyValueForTelemetryEntryId(data.telemetryEntryId);
  }

  get id(): number | undefined {
    return this._props.id;
  }

  get telemetryEntryId(): number | undefined {
    return this._props.telemetryEntryId;
  }

  get currentState(): DiagnosisState {
    return this._props.currentState;
  }

  get stateHistory(): ReadonlyArray<StateHistoryEntry> {
    return this._props.stateHistory;
  }

  get stateTexts(): Readonly<StateTexts> {
    return this._props.stateTexts;
  }

  get createdAt(): Date | undefined {
    return this._props.createdAt;
  }

  get updatedAt(): Date | undefined {
    return this._props.updatedAt;
  }

  get ruleDescription(): string | undefined {
    return this._props.ruleDescription;
  }

  get agentName(): string | undefined {
    return this._props.agentName;
  }

  get ruleLevel(): number | undefined {
    return this._props.ruleLevel;
  }

  get category(): LogCategory | undefined {
    return this._props.category;
  }

  get categoryConfidence(): number | undefined {
    return this._props.categoryConfidence;
  }

  get sourceCategory(): DiagnosisSourceCategory {
    return this._props.sourceCategory;
  }

  get sourceKind(): DiagnosisSourceKind {
    return this._props.sourceKind;
  }

  get logLevel(): DiagnosisLogLevel {
    return this._props.logLevel;
  }

  get severity(): DiagnosisSeverity {
    return this._props.severity;
  }

  get description(): string | undefined {
    return this._props.description;
  }

  get environment(): string | undefined {
    return this._props.environment;
  }

  get sourceMetadata(): Record<string, unknown> | undefined {
    return this._props.sourceMetadata;
  }

  get normalizedData(): Record<string, unknown> | undefined {
    return this._props.normalizedData;
  }

  get verificationData(): Record<string, unknown> | undefined {
    return this._props.verificationData;
  }

  get debugPayload(): Record<string, unknown> | undefined {
    return this._props.debugPayload;
  }

  get sourceRef(): Readonly<DiagnosisSourceRef> {
    return this._props.sourceRef;
  }

  /**
   * Sets the LLM-refined category
   */
  setCategory(category: LogCategory, confidence?: number): void {
    this._props.category = category;
    this._props.categoryConfidence = confidence;
    this._props.updatedAt = new Date();
  }

  applySourceContext(input: {
    sourceCategory?: DiagnosisSourceCategory;
    sourceKind?: DiagnosisSourceKind;
    logLevel?: DiagnosisLogLevel;
    severity?: DiagnosisSeverity;
    description?: string;
    environment?: string;
    sourceMetadata?: Record<string, unknown>;
    normalizedData?: Record<string, unknown>;
    sourceRef?: DiagnosisSourceRef;
  }): void {
    this.applySourceClassification(input);
    if (input.description !== undefined) this._props.description = input.description;
    if (input.environment !== undefined) this._props.environment = input.environment;
    if (input.sourceMetadata !== undefined)
      this._props.sourceMetadata = input.sourceMetadata;
    if (input.normalizedData !== undefined)
      this._props.normalizedData = input.normalizedData;
    if (input.sourceRef !== undefined) this._props.sourceRef = input.sourceRef;
    this._props.updatedAt = new Date();
  }

  private applySourceClassification(input: {
    sourceCategory?: DiagnosisSourceCategory;
    sourceKind?: DiagnosisSourceKind;
    logLevel?: DiagnosisLogLevel;
    severity?: DiagnosisSeverity;
  }): void {
    if (input.sourceCategory !== undefined) this._props.sourceCategory = input.sourceCategory;
    if (input.sourceKind !== undefined) this._props.sourceKind = input.sourceKind;
    if (input.logLevel !== undefined) this._props.logLevel = input.logLevel;
    if (input.severity !== undefined) this._props.severity = input.severity;
  }

  /**
   * Gets the text associated with the current state
   */
  getCurrentStateText(): string | undefined {
    const stateValue = this._props.currentState.value();
    const operation = this.operationForState(stateValue);
    if (operation === undefined) {
      return undefined;
    }
    return this._props.stateTexts[operation];
  }

  /**
   * Transitions to a new state with optional text and metadata
   */
  transitionTo(newState: DiagnosisState, options?: TransitionOptions): void;
  transitionTo(
    newState: DiagnosisState,
    text?: string,
    metadata?: Record<string, unknown>,
  ): void;
  transitionTo(
    newState: DiagnosisState,
    textOrOptions?: string | TransitionOptions,
    metadataMaybe?: Record<string, unknown>,
  ): void {
    if (!this._props.currentState.canTransitionTo(newState)) {
      throw new Error(
        `Cannot transition from '${this._props.currentState.value()}' to '${newState.value()}'`,
      );
    }

    let operation: DiagnosisOperation | undefined;
    let text: string | undefined;
    let metadata: Record<string, unknown> | undefined;
    if (typeof textOrOptions === "string" || textOrOptions === undefined) {
      operation = this.operationForState(newState.value());
      text = textOrOptions;
      metadata = metadataMaybe;
    } else {
      operation =
        textOrOptions.operation ?? this.operationForState(newState.value());
      text = textOrOptions.text;
      metadata = textOrOptions.metadata;
    }

    const historyEntry: StateHistoryEntry = {
      fromState: this._props.currentState.value(),
      toState: newState.value(),
      transitionedAt: new Date(),
      metadata,
    };

    this._props.stateHistory.push(historyEntry);
    this._props.currentState = newState;

    // Store operation-specific text
    if (text !== undefined && text !== "" && operation !== undefined) {
      this.setStateText(operation, text);
    }

    this._props.updatedAt = new Date();
  }

  private operationForState(
    state: DiagnosisStateValue,
  ): DiagnosisOperation | undefined {
    switch (state) {
      case "llm_assessed":
        return "diagnose";
      case "verification_pending":
      case "verified":
        return "verify";
      case "completed":
        return "recommend";
      default:
        return undefined;
    }
  }

  private setStateText(operation: DiagnosisOperation, text: string): void {
    // Store only the canonical operation key - no redundancy
    switch (operation) {
      case "diagnose":
        this._props.stateTexts.diagnose = text;
        break;
      case "verify":
        this._props.stateTexts.verify = text;
        break;
      case "recommend":
        this._props.stateTexts.recommend = text;
        break;
    }
  }

  /**
   * State texts format for database persistence (only canonical keys - no redundancy)
   */
  private toPersistedStateTexts(): Record<string, string | undefined> {
    return {
      diagnose: this._props.stateTexts.diagnose,
      verify: this._props.stateTexts.verify,
      recommend: this._props.stateTexts.recommend,
    };
  }

  /**
   * Converts to persistence format
   */
  toPersistence(): {
    telemetryEntryId?: number;
    currentState: string;
    stateHistory: StateHistoryEntry[];
    stateTexts: Record<string, string | undefined>;
    category: LogCategory;
    categoryConfidence?: number;
    sourceCategory: DiagnosisSourceCategory;
    sourceKind: DiagnosisSourceKind;
    logLevel: DiagnosisLogLevel;
    severity: DiagnosisSeverity;
    description?: string;
    environment?: string;
    sourceMetadata?: Record<string, unknown>;
    normalizedData?: Record<string, unknown>;
    verificationData?: Record<string, unknown>;
    debugPayload?: Record<string, unknown>;
    sourceRef: DiagnosisSourceRef;
  } {
    return {
      telemetryEntryId: this._props.telemetryEntryId,
      currentState: this._props.currentState.value(),
      stateHistory: [...this._props.stateHistory],
      stateTexts: this.toPersistedStateTexts(),
      category: this._props.category ?? "unknown",
      categoryConfidence: this._props.categoryConfidence,
      sourceCategory: this._props.sourceCategory,
      sourceKind: this._props.sourceKind,
      logLevel: this._props.logLevel,
      severity: this._props.severity,
      description: this._props.description,
      environment: this._props.environment,
      sourceMetadata: this._props.sourceMetadata,
      normalizedData: this._props.normalizedData,
      verificationData: this._props.verificationData,
      debugPayload: this._props.debugPayload,
      sourceRef: this._props.sourceRef,
    };
  }
}
