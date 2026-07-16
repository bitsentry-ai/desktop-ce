/**
 * Value Object: DiagnosisState
 * Represents the processing state of a diagnosis record
 */
export type DiagnosisStateValue =
  | "pending"
  | "llm_assessed"
  | "verification_pending"
  | "verified"
  | "completed"
  | "failed";

const VALID_STATES: DiagnosisStateValue[] = [
  "pending",
  "llm_assessed",
  "verification_pending",
  "verified",
  "completed",
  "failed",
];

const STATE_TRANSITIONS: Record<DiagnosisStateValue, DiagnosisStateValue[]> = {
  pending: ["llm_assessed", "failed"],
  llm_assessed: ["verification_pending", "verified", "failed"],
  verification_pending: ["verified", "failed"],
  verified: ["completed", "failed"],
  completed: [],
  // A failed diagnosis can be explicitly replayed by the dashboard retry flow.
  // The retry enters pending before running a fresh LLM diagnosis.
  failed: ["pending"],
};

function isDiagnosisStateValue(value: string): value is DiagnosisStateValue {
  switch (value) {
    case "pending":
    case "llm_assessed":
    case "verification_pending":
    case "verified":
    case "completed":
    case "failed": {
      return true;
    }
    default: {
      return false;
    }
  }
}

export class DiagnosisState {
  private readonly _value: DiagnosisStateValue;

  private constructor(value: DiagnosisStateValue) {
    this._value = value;
  }

  static create(state: string): DiagnosisState {
    const normalized = state.toLowerCase().trim();
    if (!isDiagnosisStateValue(normalized)) {
      throw new Error(
        `Invalid diagnosis state: ${state}. Valid states are: ${VALID_STATES.join(", ")}`,
      );
    }
    return new DiagnosisState(normalized);
  }

  static pending(): DiagnosisState {
    return new DiagnosisState("pending");
  }

  static llmAssessed(): DiagnosisState {
    return new DiagnosisState("llm_assessed");
  }

  static verificationPending(): DiagnosisState {
    return new DiagnosisState("verification_pending");
  }

  static verified(): DiagnosisState {
    return new DiagnosisState("verified");
  }

  static completed(): DiagnosisState {
    return new DiagnosisState("completed");
  }

  static failed(): DiagnosisState {
    return new DiagnosisState("failed");
  }

  value(): DiagnosisStateValue {
    return this._value;
  }

  toString(): string {
    return this._value;
  }

  canTransitionTo(target: DiagnosisState): boolean {
    const allowedTransitions = STATE_TRANSITIONS[this._value];
    return allowedTransitions.includes(target._value);
  }

  isPending(): boolean {
    return this._value === "pending";
  }

  isLlmAssessed(): boolean {
    return this._value === "llm_assessed";
  }

  isVerified(): boolean {
    return this._value === "verified";
  }

  isTerminal(): boolean {
    return this._value === "completed" || this._value === "failed";
  }

  equals(other: DiagnosisState): boolean {
    return this._value === other._value;
  }
}
