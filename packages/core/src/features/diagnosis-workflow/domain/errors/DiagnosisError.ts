/**
 * Base class for diagnosis domain errors
 */
export class DiagnosisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagnosisError";
  }
}

/**
 * Error thrown when a telemetry entry is not found
 */
export class EntryNotFoundError extends DiagnosisError {
  constructor(entryId: number) {
    super(`Telemetry entry with id=${String(entryId)} not found`);
    this.name = "EntryNotFoundError";
  }
}

/**
 * Error thrown when a diagnosis record is not found
 */
export class DiagnosisNotFoundError extends DiagnosisError {
  constructor(entryId: number) {
    super(`Diagnosis record for entry id=${String(entryId)} not found`);
    this.name = "DiagnosisNotFoundError";
  }
}

/**
 * Error thrown when a state transition is invalid
 */
export class InvalidStateTransitionError extends DiagnosisError {
  constructor(currentState: string, targetState: string) {
    super(`Cannot transition from '${currentState}' to '${targetState}'`);
    this.name = "InvalidStateTransitionError";
  }
}

/**
 * Error thrown when entry is not in expected state for an operation
 */
export class WrongStateError extends DiagnosisError {
  constructor(expectedState: string, actualState: string, operation: string) {
    super(
      `Cannot perform ${operation}: entry is in '${actualState}' state, expected '${expectedState}'`,
    );
    this.name = "WrongStateError";
  }
}

/**
 * Error thrown when LLM service fails
 */
export class LLMServiceError extends DiagnosisError {
  constructor(message: string) {
    super(`LLM service error: ${message}`);
    this.name = "LLMServiceError";
  }
}

/**
 * Error thrown when evidence verification fails
 */
export class EvidenceVerificationServiceError extends DiagnosisError {
  constructor(message: string) {
    super(`Evidence verification service error: ${message}`);
    this.name = "EvidenceVerificationServiceError";
  }
}

/**
 * Error thrown when configuration is missing
 */
export class ConfigurationError extends DiagnosisError {
  constructor(configName: string) {
    super(`Missing configuration: ${configName}`);
    this.name = "ConfigurationError";
  }
}
