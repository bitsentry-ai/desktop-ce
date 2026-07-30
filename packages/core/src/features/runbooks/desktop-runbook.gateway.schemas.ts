import { z } from "zod";
import {
  executionDetailSchema,
  runbookExecutionAccessLevelSchema,
  runbookExecutionSourceSchema,
  runbookTriggerContextSchema,
} from "./runbooks.schemas";

/** Immutable identity for the authored runbook revision an execution uses. */
export const runbookReferenceSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string(),
  revisionNumber: z.number().int().positive(),
});

/**
 * A client-supplied idempotency key has one observable outcome for a runbook.
 * The gateway resolves and persists the referenced revision before any action
 * is started.
 */
export const runbookExecutionRequestSchema = z.object({
  runbookId: z.string().trim().min(1),
  expectedRevisionNumber: z.number().int().positive().optional(),
  requestKey: z.string().trim().min(1).max(256),
  incidentId: z.string().trim().min(1).optional(),
  parameterValues: z.record(z.string(), z.string()).optional(),
  source: runbookExecutionSourceSchema,
  triggerContext: runbookTriggerContextSchema.optional(),
  accessLevel: runbookExecutionAccessLevelSchema.optional(),
});

export const runbookExecutionEventSchema = z.object({
  eventId: z.string().trim().min(1),
  occurredAt: z.string().datetime(),
  resultId: z.string().trim().min(1),
  executionId: z.string().trim().min(1),
  incidentId: z.string().trim().min(1).nullable(),
  execution: executionDetailSchema,
});

export const runbookExecutionResultSchema = z.object({
  executionId: z.string().trim().min(1),
  resultId: z.string().trim().min(1),
  runbook: runbookReferenceSchema,
  execution: executionDetailSchema,
  deduplicated: z.boolean(),
});

export type RunbookReference = z.infer<typeof runbookReferenceSchema>;
export type RunbookExecutionRequest = z.infer<
  typeof runbookExecutionRequestSchema
>;
export type RunbookExecutionEvent = z.infer<
  typeof runbookExecutionEventSchema
>;
export type RunbookExecutionResult = z.infer<
  typeof runbookExecutionResultSchema
>;
