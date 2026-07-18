import { describe, expect, it, vi } from "vitest";
import { DiagnoseEntryUseCaseImpl } from "../src/features/diagnosis-workflow/application/use-cases/DiagnoseEntryUseCaseImpl";
import type {
  DiagnosisRepository,
  LLMService,
  TelemetryEntryData,
  TelemetryQueryService,
} from "../src/features/diagnosis-workflow/application/ports/outbound";
import { DiagnosisRecord } from "../src/features/diagnosis-workflow/domain/entities/DiagnosisRecord";

function createUseCase(llmService: LLMService, save = vi.fn()) {
  const diagnosisRecord = DiagnosisRecord.create(11);
  const repository: DiagnosisRepository = {
    findByEntryId: vi.fn().mockResolvedValue(diagnosisRecord),
    ensureForEntry: vi.fn().mockResolvedValue(diagnosisRecord),
    save: save.mockResolvedValue(diagnosisRecord),
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getDebugInfo: vi.fn().mockResolvedValue(null),
  };
  const entry: TelemetryEntryData = {
    id: 11,
    telemetryId: 1,
    entryId: "entry-11",
    entryIndex: "wazuh-alerts-*",
    entrySource: { message: "test" },
    entryTimestamp: new Date("2026-01-01T00:00:00.000Z"),
    ruleDescription: "Malware detected",
    ruleGroups: ["malware"],
    category: "security",
  };
  const telemetry: TelemetryQueryService = {
    getEntryById: vi.fn().mockResolvedValue(entry),
    getEntriesByIds: vi.fn().mockResolvedValue(new Map()),
  };

  return {
    save,
    useCase: new DiagnoseEntryUseCaseImpl(repository, telemetry, llmService),
  };
}

function createLlmService(analyze: LLMService["analyze"]): LLMService {
  return {
    analyze,
    recommend: vi.fn(),
  };
}

describe("DiagnoseEntryUseCaseImpl operation deadline", () => {
  it("does not invoke the LLM when the operation deadline has already elapsed", async () => {
    const analyze = vi.fn();
    const { useCase, save } = createUseCase(createLlmService(analyze));

    await expect(
      useCase.execute({ entryId: 11, deadlineAt: Date.now() - 1 }),
    ).rejects.toThrow("Diagnosis operation deadline exceeded");

    expect(analyze).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("does not persist a result that arrives after the parent deadline", async () => {
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(2_000);
    const analyze = vi.fn().mockResolvedValue({
      diagnosisText: "Potential malware incident",
      refinedCategory: "security",
    });
    const { useCase, save } = createUseCase(createLlmService(analyze));

    await expect(
      useCase.execute({
        entryId: 11,
        executionId: "diagnosis-operation-11",
        deadlineAt: 1_000,
      }),
    ).rejects.toThrow("Diagnosis operation deadline exceeded");

    expect(analyze).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        executionId: "diagnosis-operation-11",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(save).not.toHaveBeenCalled();
    now.mockRestore();
  });
});
