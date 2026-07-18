import { DiagnoseEntryUseCaseImpl } from "../application/use-cases/DiagnoseEntryUseCaseImpl";
import { VerifyDiagnosisUseCaseImpl } from "../application/use-cases/VerifyDiagnosisUseCaseImpl";
import type {
  DiagnosisRepository,
  LLMService,
  MCPService,
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

  const verificationRecord = DiagnosisRecord.create(12);
  verificationRecord.transitionTo(DiagnosisState.llmAssessed(), {
    operation: "diagnose",
    text: "Potential frontend issue",
  });

  const verificationRepository: DiagnosisRepository = {
    findByEntryId: () => Promise.resolve(verificationRecord),
    ensureForEntry: () => Promise.resolve(verificationRecord),
    save: (record: DiagnosisRecord) => Promise.resolve(record),
    list: () => Promise.resolve({ items: [], total: 0 }),
    getDebugInfo: () => Promise.resolve(null),
  };

  const failingMcpService: MCPService = {
    verify: () =>
      Promise.resolve({
        verificationText: "Evidence is insufficient",
        toolsUsed: ["sentry"],
        passed: false,
      }),
  };

  const verificationResult = await new VerifyDiagnosisUseCaseImpl(
    verificationRepository,
    telemetryQueryService,
    failingMcpService,
  ).execute({ entryId: 12 });

  assert(
    verificationResult.newState === "failed",
    "failed verification should transition directly to failed",
  );
  assert(
    verificationRecord.currentState.value() === "failed",
    "failed verification should not leave the record verified",
  );
  assert(
    !verificationRecord.stateHistory.some(
      (entry) => entry.toState === "verified",
    ),
    "failed verification should never append a verified transition",
  );
};

void run();
