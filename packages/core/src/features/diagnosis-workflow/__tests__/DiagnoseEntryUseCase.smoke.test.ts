import { DiagnoseEntryUseCaseImpl } from "../application/use-cases/DiagnoseEntryUseCaseImpl";
import type {
  DiagnosisRepository,
  LLMService,
  TelemetryEntryData,
  TelemetryQueryService,
} from "../application/ports/outbound";
import { DiagnosisRecord } from "../domain/entities/DiagnosisRecord";
import { DiagnosisState } from "../domain/value-objects/DiagnosisState";

const assert = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const run = async (): Promise<void> => {
  const diagnosisRecord = DiagnosisRecord.create(11);

  const diagnosisRepository: DiagnosisRepository = {
    findByEntryId: () => Promise.resolve(diagnosisRecord),
    ensureForEntry: () => Promise.resolve(diagnosisRecord),
    save: (record: DiagnosisRecord) => Promise.resolve(record),
    list: () => Promise.resolve({ items: [], total: 0 }),
    getDebugInfo: () => Promise.resolve(null),
  };

  const telemetryEntry: TelemetryEntryData = {
    id: 11,
    telemetryId: 1,
    entryId: "entry-11",
    entryIndex: "wazuh-alerts-*",
    entrySource: { message: "test" },
    entryTimestamp: new Date(),
    ruleDescription: "Malware detected",
    ruleGroups: ["malware"],
    category: "security",
  };

  const telemetryQueryService: TelemetryQueryService = {
    getEntryById: () => Promise.resolve(telemetryEntry),
    getEntriesByIds: () =>
      Promise.resolve(new Map<number, TelemetryEntryData>()),
  };

  const llmService: LLMService = {
    analyze: () =>
      Promise.resolve({
        diagnosisText: "Potential malware incident",
        refinedCategory: "security",
      }),
    recommend: () =>
      Promise.resolve({
        recommendationText: "Isolate host and rotate credentials",
      }),
  };

  const useCase = new DiagnoseEntryUseCaseImpl(
    diagnosisRepository,
    telemetryQueryService,
    llmService,
  );
  const result = await useCase.execute({ entryId: 11 });

  assert(
    result.newState === "llm_assessed",
    "diagnose use-case should transition to llm_assessed",
  );

  const failedDiagnosisRecord = DiagnosisRecord.create(11);
  failedDiagnosisRecord.transitionTo(DiagnosisState.failed());

  const retryRepository: DiagnosisRepository = {
    findByEntryId: () => Promise.resolve(failedDiagnosisRecord),
    ensureForEntry: () => Promise.resolve(failedDiagnosisRecord),
    save: (record: DiagnosisRecord) => Promise.resolve(record),
    list: () => Promise.resolve({ items: [], total: 0 }),
    getDebugInfo: () => Promise.resolve(null),
  };

  const retryResult = await new DiagnoseEntryUseCaseImpl(
    retryRepository,
    telemetryQueryService,
    llmService,
  ).execute({ entryId: 11 });

  assert(
    retryResult.newState === "llm_assessed",
    "diagnose use-case should retry a failed entry",
  );
  assert(
    failedDiagnosisRecord.stateHistory.some(
      (entry) => entry.fromState === "failed" && entry.toState === "pending",
    ),
    "retry should record the failed-to-pending transition",
  );
};

void run();
