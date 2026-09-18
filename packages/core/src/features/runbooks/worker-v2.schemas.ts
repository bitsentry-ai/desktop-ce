import { z } from "zod";
import {
  runbookWorkerClaimNextExecutionRequestSchema,
  runbookWorkerExecutionContextResponseSchema,
  runbookWorkerHeartbeatRequestSchema,
  runbookWorkerSnapshotUpdateRequestSchema,
  runbookWorkerContextSchema,
} from "./runbooks.schemas";
import { credentialBindingSchema } from "./credential-bindings.schemas";

// Additive Dashboard-only protocol. Keep every v1 schema/export unchanged.
export const runbookWorkerClaimNextExecutionRequestV2Schema =
  runbookWorkerClaimNextExecutionRequestSchema.extend({
    protocolVersion: z.literal(2),
  });
export const runbookWorkerHeartbeatRequestV2Schema =
  runbookWorkerHeartbeatRequestSchema.extend({
    workerClaimGeneration: z.number().int().positive(),
  });
export const runbookWorkerSnapshotUpdateRequestV2Schema =
  runbookWorkerSnapshotUpdateRequestSchema.extend({
    workerClaimGeneration: z.number().int().positive(),
  });

const actionSchema = runbookWorkerContextSchema.shape.actions.element;
const contextV2Schema = runbookWorkerContextSchema.extend({
  actions: z.array(
    actionSchema.extend({
      payload: actionSchema.shape.payload.extend({
        pluginAuth: z.never().optional(),
      }),
    }),
  ),
});

export const runbookWorkerExecutionContextResponseV2Schema =
  runbookWorkerExecutionContextResponseSchema
    .extend({
      protocolVersion: z.literal(2),
      workerClaimGeneration: z.number().int().positive(),
      credentialBindings: z.array(credentialBindingSchema),
      context: contextV2Schema,
    })
    .superRefine((value, ctx) => {
      const secureGlobals = new Set(
        [
          ...value.resolvedGlobals.definitions,
          ...(value.context.globalReferences ?? []),
        ]
          .filter((definition) => definition.secure === true)
          .map((definition) => definition.key),
      );
      if (
        Object.keys(value.resolvedGlobals.values).some((key) =>
          secureGlobals.has(key),
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["resolvedGlobals", "values"],
          message: "Secure globals must be credential references",
        });
      }
      const secureParameters = new Set(
        value.context.actions.flatMap((action) =>
          (action.payload.parameters ?? [])
            .filter((parameter) => parameter.secure === true)
            .map((parameter) => parameter.key),
        ),
      );
      for (const [path, parameters] of [
        [["parameterValues"], value.parameterValues],
        [["snapshot", "parameterValues"], value.snapshot.parameterValues],
      ] as const) {
        if (
          Object.keys(parameters ?? {}).some((key) => secureParameters.has(key))
        ) {
          ctx.addIssue({
            code: "custom",
            path: [...path],
            message: "Secure parameters must be credential references",
          });
        }
      }
      const actionIds = new Set(
        value.context.actions.map((action) => action.id),
      );
      const slots = new Set<string>();
      for (const binding of value.credentialBindings) {
        const key = JSON.stringify([binding.actionId, binding.slot]);
        if (!actionIds.has(binding.actionId) || slots.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: ["credentialBindings"],
            message: "Invalid or duplicate action binding",
          });
        }
        slots.add(key);
      }
    });

export type RunbookWorkerExecutionContextResponseV2 = z.infer<
  typeof runbookWorkerExecutionContextResponseV2Schema
>;
export type RunbookWorkerClaimNextExecutionRequestV2 = z.infer<
  typeof runbookWorkerClaimNextExecutionRequestV2Schema
>;
export type RunbookWorkerHeartbeatRequestV2 = z.infer<
  typeof runbookWorkerHeartbeatRequestV2Schema
>;
export type RunbookWorkerSnapshotUpdateRequestV2 = z.infer<
  typeof runbookWorkerSnapshotUpdateRequestV2Schema
>;
