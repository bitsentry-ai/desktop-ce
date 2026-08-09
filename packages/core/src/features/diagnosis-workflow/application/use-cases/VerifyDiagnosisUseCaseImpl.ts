import type {
  VerifyDiagnosisUseCase,
  VerifyDiagnosisInput,
  VerifyDiagnosisOutput,
} from "../ports/inbound/VerifyDiagnosisUseCase";
import type { DiagnosisRepository } from "../ports/outbound/DiagnosisRepository";
import type { TelemetryQueryService } from "../ports/outbound/TelemetryQueryService";
import type {
  EvidenceVerificationService,
  EvidenceVerificationResult,
} from "../ports/outbound/EvidenceVerificationService";
import type { TelemetryEntryData } from "../ports/outbound/TelemetryQueryService";
import type { DiagnosisRecord } from "../../domain/entities/DiagnosisRecord";
import {
  DiagnosisState,
  type DiagnosisStateValue,
} from "../../domain/value-objects/DiagnosisState";
import {
  EntryNotFoundError,
  DiagnosisNotFoundError,
  WrongStateError,
  EvidenceVerificationServiceError,
} from "../../domain/errors/DiagnosisError";

/**
 * Application Service: VerifyDiagnosisUseCaseImpl
 * Verifies a diagnosis using configured evidence sources.
 */
export class VerifyDiagnosisUseCaseImpl implements VerifyDiagnosisUseCase {
  constructor(
    private readonly diagnosisRepository: DiagnosisRepository,
    private readonly telemetryQueryService: TelemetryQueryService,
    private readonly evidenceVerificationService: EvidenceVerificationService,
  ) {}

  async execute(input: VerifyDiagnosisInput): Promise<VerifyDiagnosisOutput> {
    // 1. Fetch the telemetry entry
    const entry = await this.telemetryQueryService.getEntryById(input.entryId);
    if (entry === null) {
      throw new EntryNotFoundError(input.entryId);
    }

    // 2. Get diagnosis record
    const diagnosisRecord = await this.diagnosisRepository.findByEntryId(
      input.entryId,
    );
    if (diagnosisRecord === null) {
      throw new DiagnosisNotFoundError(input.entryId);
    }

    this.assertVerifiableState(diagnosisRecord);

    // 4. Get the diagnosis text from state texts
    const diagnosisText = diagnosisRecord.stateTexts.diagnose;
    if (diagnosisText === undefined || diagnosisText.length === 0) {
      const stateTextsDebug = JSON.stringify(diagnosisRecord.stateTexts);
      const currentState = diagnosisRecord.currentState.value();
      throw new EvidenceVerificationServiceError(
        `No diagnose text found in diagnosis record (entryId=${String(input.entryId)}). ` +
          `Current state: '${currentState}'. ` +
          `State texts: ${stateTextsDebug}. ` +
          `Ensure POST /diagnosis/diagnose was called first and completed successfully.`,
      );
    }

    // 5. Run evidence verification
    const verificationResult = await this.verifyWithEvidence(
      input,
      entry,
      diagnosisText,
    );

    // A failed verdict must remain visibly failed; do not record a false
    // verification before the failure path handles the result.
    const newState: DiagnosisStateValue = verificationResult.passed
      ? "verified"
      : "failed";

    // 7. Transition state
    diagnosisRecord.transitionTo(DiagnosisState.create(newState), {
      operation: "verify",
      text: verificationResult.verificationText,
      metadata: {
        evidence_tools_used: verificationResult.toolsUsed,
        verification_passed: verificationResult.passed,
        verification_method: verificationResult.verificationMethod,
        evidence_sources_used: verificationResult.evidenceSourcesUsed,
        evidence_queries: verificationResult.evidenceQueries,
        provider_used: verificationResult.providerUsed,
        model_used: verificationResult.modelUsed,
        current_action_label: "Verifying Diagnosis",
      },
    });

    // 8. Save the updated record
    await this.diagnosisRepository.save(diagnosisRecord);

    return {
      entryId: input.entryId,
      newState,
      verificationText: verificationResult.verificationText,
      evidenceToolsUsed: verificationResult.toolsUsed,
      verificationPassed: verificationResult.passed,
      verificationMethod: verificationResult.verificationMethod,
      evidenceSourcesUsed: verificationResult.evidenceSourcesUsed,
      evidenceQueries: verificationResult.evidenceQueries,
      providerUsed: verificationResult.providerUsed,
      modelUsed: verificationResult.modelUsed,
      currentActionLabel: "Verifying Diagnosis",
    };
  }

  private assertVerifiableState(diagnosisRecord: DiagnosisRecord): void {
    const currentState = diagnosisRecord.currentState;
    if (
      currentState.isLlmAssessed() ||
      currentState.value() === "verification_pending"
    ) {
      return;
    }

    if (currentState.isPending()) {
      throw new WrongStateError(
        "llm_assessed or verification_pending",
        "pending",
        "verify - run diagnose first",
      );
    }

    throw new WrongStateError(
      "llm_assessed or verification_pending",
      currentState.value(),
      "verify",
    );
  }

  private async verifyWithEvidence(
    input: VerifyDiagnosisInput,
    entry: TelemetryEntryData,
    diagnosisText: string,
  ): Promise<EvidenceVerificationResult> {
    try {
      return await this.evidenceVerificationService.verify({
        entryId: entry.id,
        entryIndex: entry.entryIndex,
        ruleId: entry.ruleId,
        ruleDescription: entry.ruleDescription ?? "",
        ruleLevel: entry.ruleLevel,
        ruleGroups: entry.ruleGroups,
        category: entry.category,
        entrySource: entry.entrySource,
        entryTimestamp: entry.entryTimestamp,
        agentName: entry.agentName,
        agentIp: entry.agentIp,
        diagnosisText,
        llmProviderKey: input.llmProviderKey,
        llmModel: input.llmModel,
      });
    } catch (error) {
      if (error instanceof EvidenceVerificationServiceError) {
        throw error;
      }
      throw new EvidenceVerificationServiceError(this.evidenceErrorMessage(error));
    }
  }

  private evidenceErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return "unknown error";
  }
}
