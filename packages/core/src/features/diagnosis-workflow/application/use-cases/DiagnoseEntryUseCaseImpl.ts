import type {
  DiagnoseEntryUseCase,
  DiagnoseEntryInput,
  DiagnoseEntryOutput,
} from "../ports/inbound/DiagnoseEntryUseCase";
import type { DiagnosisRepository } from "../ports/outbound/DiagnosisRepository";
import type {
  TelemetryEntryData,
  TelemetryQueryService,
} from "../ports/outbound/TelemetryQueryService";
import type { LLMService } from "../ports/outbound/LLMService";
import { DiagnosisState } from "../../domain/value-objects/DiagnosisState";
import {
  EntryNotFoundError,
  WrongStateError,
  LLMServiceError,
} from "../../domain/errors/DiagnosisError";
import { mapDiagnosisSourceContextFromEntry } from "../../utils";
import type { DiagnosisLlmProviderKey } from "../../../diagnosis/contracts";
import type { LogCategory } from "../../domain/entities/DiagnosisRecord";

interface DiagnosisAnalysis {
  text: string;
  category?: LogCategory;
  categoryConfidence?: number;
  providerUsed?: DiagnosisLlmProviderKey;
  modelUsed?: string;
}

/**
 * Application Service: DiagnoseEntryUseCaseImpl
 * Runs LLM-based diagnosis on a telemetry entry
 */
export class DiagnoseEntryUseCaseImpl implements DiagnoseEntryUseCase {
  constructor(
    private readonly diagnosisRepository: DiagnosisRepository,
    private readonly telemetryQueryService: TelemetryQueryService,
    private readonly llmService: LLMService,
  ) {}

  async execute(input: DiagnoseEntryInput): Promise<DiagnoseEntryOutput> {
    // 1. Fetch the telemetry entry
    const entry = await this.telemetryQueryService.getEntryById(input.entryId);
    if (entry === null) {
      throw new EntryNotFoundError(input.entryId);
    }

    // 2. Ensure diagnosis record exists
    const diagnosisRecord = await this.diagnosisRepository.ensureForEntry(
      input.entryId,
    );

    // 3. A failed diagnosis is retryable through the explicit replay flow.
    // Preserve the audit trail while returning the entry to the state required
    // by the diagnosis operation.
    if (diagnosisRecord.currentState.value() === "failed") {
      diagnosisRecord.transitionTo(DiagnosisState.pending(), {
        operation: "diagnose",
        metadata: {
          current_action_label: "Retrying Diagnosis",
          retry: true,
        },
      });
    }

    // 4. Validate current state is 'pending'
    if (!diagnosisRecord.currentState.isPending()) {
      throw new WrongStateError(
        "pending",
        diagnosisRecord.currentState.value(),
        "diagnose",
      );
    }

    // 5. Run LLM analysis
    const analysis = await this.analyzeEntry(input, entry);
    const refinedCategory = analysis.category ?? entry.category;

    // 6. Set category on diagnosis record
    // Use LLM-refined category if available, otherwise fall back to telemetry entry's category
    if (refinedCategory !== undefined) {
      diagnosisRecord.setCategory(refinedCategory, analysis.categoryConfidence);
    }

    diagnosisRecord.applySourceContext(
      mapDiagnosisSourceContextFromEntry(entry),
    );

    // 7. Transition state to llm_assessed
    diagnosisRecord.transitionTo(DiagnosisState.llmAssessed(), {
      operation: "diagnose",
      text: analysis.text,
      metadata: {
        provider_used: analysis.providerUsed,
        model_used: analysis.modelUsed,
        current_action_label: "Running Diagnosis",
      },
    });

    // 8. Save the updated record
    await this.diagnosisRepository.save(diagnosisRecord);

    return {
      entryId: input.entryId,
      newState: "llm_assessed",
      diagnosis: analysis.text,
      category: refinedCategory,
      categoryConfidence: analysis.categoryConfidence,
      providerUsed: analysis.providerUsed,
      modelUsed: analysis.modelUsed,
      currentActionLabel: "Running Diagnosis",
    };
  }

  private async analyzeEntry(
    input: DiagnoseEntryInput,
    entry: TelemetryEntryData,
  ): Promise<DiagnosisAnalysis> {
    try {
      const result = await this.llmService.analyze({
        ruleDescription: entry.ruleDescription ?? "",
        entrySource: entry.entrySource,
        ruleGroups: entry.ruleGroups,
        initialCategory: entry.category,
        llmProviderKey: input.llmProviderKey,
        llmModel: input.llmModel,
      });

      if (result.diagnosisText.trim().length === 0) {
        throw new Error("Empty response from LLM");
      }

      return {
        text: result.diagnosisText,
        category: result.refinedCategory,
        categoryConfidence: result.categoryConfidence,
        providerUsed: result.providerUsed,
        modelUsed: result.modelUsed,
      };
    } catch (error) {
      throw new LLMServiceError(this.llmErrorMessage(error));
    }
  }

  private llmErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return "unknown error";
  }
}
