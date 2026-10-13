import type {
  DiagnoseEntryRequest,
  DiagnoseEntryResponse,
  CreateDiagnosisTicketResult,
  CreateTicketFromDiagnosisInput,
  DiagnosisQuery,
  DiagnosisRecord,
  DiagnosisResultsResponse,
  DiagnosisTicket,
  DiagnosisTicketCreateEventData,
  DiagnosisTicketPriority,
  DiagnosisTicketStatus,
  RecommendDiagnosisRequest,
  RecommendDiagnosisResponse,
  TelemetryEntry,
  TelemetryEntryResponse,
  UpdateDiagnosisStateRequest,
  UpdateDiagnosisStateResponse,
  VerifyDiagnosisRequest,
  VerifyDiagnosisResponse,
} from './features/diagnosis/contracts';
import type {
  DiagnosisServicePort as NewDiagnosisServicePort,
  DiagnosisTicketEventPublisherPort,
  DiagnosisTicketProviderPort,
  DiagnosisTicketRepositoryPort,
} from './features/diagnosis/application/ports/outbound';

export type {
  DiagnoseEntryRequest,
  DiagnoseEntryResponse,
  CreateDiagnosisTicketResult,
  CreateTicketFromDiagnosisInput,
  DiagnosisQuery,
  DiagnosisRecord,
  DiagnosisResultsResponse,
  DiagnosisTicket,
  DiagnosisTicketCreateEventData,
  DiagnosisTicketPriority,
  DiagnosisTicketStatus,
  RecommendDiagnosisRequest,
  RecommendDiagnosisResponse,
  TelemetryEntry,
  TelemetryEntryResponse,
  UpdateDiagnosisStateRequest,
  UpdateDiagnosisStateResponse,
  VerifyDiagnosisRequest,
  VerifyDiagnosisResponse,
};

export type {
  DiagnosisTicketEventPublisherPort,
  DiagnosisTicketProviderPort,
  DiagnosisTicketRepositoryPort,
};

export type DiagnosisServicePort = NewDiagnosisServicePort;

/**
 * Legacy compatibility: existing backend modules currently bind against this token.
 * New code should prefer DiagnosisServicePort + DI symbol tokens.
 */
export abstract class DiagnosisGateway implements DiagnosisServicePort {
  abstract getResults(query?: DiagnosisQuery): Promise<DiagnosisResultsResponse>;
  abstract getTelemetryEntry(id: number): Promise<TelemetryEntryResponse>;
  abstract diagnoseEntry(input: DiagnoseEntryRequest): Promise<DiagnoseEntryResponse>;
  abstract verifyDiagnosis(input: VerifyDiagnosisRequest): Promise<VerifyDiagnosisResponse>;
  abstract recommendDiagnosis(
    input: RecommendDiagnosisRequest,
  ): Promise<RecommendDiagnosisResponse>;
  abstract updateDiagnosisState(
    input: UpdateDiagnosisStateRequest,
  ): Promise<UpdateDiagnosisStateResponse>;
}

/**
 * Legacy compatibility: existing backend modules currently bind against this token.
 * New code should prefer DiagnosisTicketRepositoryPort + DI symbol tokens.
 */
export abstract class DiagnosisTicketRepository
  implements DiagnosisTicketRepositoryPort
{
  abstract findByDiagnosisId(diagnosisId: number): Promise<DiagnosisTicket | null>;
  abstract findManyByDiagnosisIds(
    diagnosisIds?: number[],
  ): Promise<DiagnosisTicket[]>;
  abstract findManyByStatus(status: DiagnosisTicketStatus): Promise<DiagnosisTicket[]>;
  abstract findOpen(limit?: number): Promise<DiagnosisTicket[]>;
}
