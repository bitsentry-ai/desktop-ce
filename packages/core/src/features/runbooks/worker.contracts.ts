import { defineHttpEndpointContract } from "../../kernel/http-contract";
import {
  runbookWorkerAcceptedResponseSchema,
  runbookWorkerCancelExecutionRequestSchema,
  runbookWorkerHeartbeatRequestSchema,
  runbookWorkerClaimNextExecutionRequestSchema,
  runbookWorkerExecutionContextResponseSchema,
  runbookWorkerSnapshotUpdateRequestSchema,
} from "./runbooks.schemas";
import {
  credentialGrantRequestSchema,
  credentialGrantResponseSchema,
  credentialRedemptionRequestSchema,
  credentialRedemptionResponseSchema,
} from "./credential-bindings.schemas";
import {
  runbookWorkerClaimNextExecutionRequestV2Schema,
  runbookWorkerExecutionContextResponseV2Schema,
  runbookWorkerHeartbeatRequestV2Schema,
  runbookWorkerSnapshotUpdateRequestV2Schema,
} from "./worker-v2.schemas";

export const runbooksWorkerContracts = {
  cancelExecution: defineHttpEndpointContract({
    method: "POST",
    path: "/runbooks/executions/cancel",
    requestEncoding: "body",
    requestSchema: runbookWorkerCancelExecutionRequestSchema,
    responseSchema: runbookWorkerAcceptedResponseSchema,
  }),
  claimNextExecutionContext: defineHttpEndpointContract({
    method: "GET",
    path: "/api/worker/runbook-executions/claim-next",
    requestEncoding: "query",
    requestSchema: runbookWorkerClaimNextExecutionRequestSchema,
    responseSchema: runbookWorkerExecutionContextResponseSchema.nullable(),
  }),
  heartbeat: defineHttpEndpointContract({
    method: "POST",
    path: "/api/worker/runbook-executions/:executionId/heartbeat",
    requestEncoding: "body",
    pathParams: ["executionId"] as const,
    requestSchema: runbookWorkerHeartbeatRequestSchema,
    responseSchema: runbookWorkerAcceptedResponseSchema,
  }),
  saveExecutionSnapshot: defineHttpEndpointContract({
    method: "POST",
    path: "/api/worker/runbook-executions/:executionId/snapshot",
    requestEncoding: "body",
    pathParams: ["executionId"] as const,
    requestSchema: runbookWorkerSnapshotUpdateRequestSchema.extend({
      executionId: runbookWorkerHeartbeatRequestSchema.shape.executionId,
    }),
    responseSchema: runbookWorkerAcceptedResponseSchema,
  }),
};

export const runbooksWorkerV2Contracts = {
  claimNextExecutionContext: defineHttpEndpointContract({
    method: "GET",
    path: "/api/worker/runbook-executions/claim-next",
    requestEncoding: "query",
    requestSchema: runbookWorkerClaimNextExecutionRequestV2Schema,
    responseSchema: runbookWorkerExecutionContextResponseV2Schema.nullable(),
  }),
  heartbeat: defineHttpEndpointContract({
    method: "POST",
    path: "/api/worker/runbook-executions/:executionId/heartbeat",
    requestEncoding: "body",
    pathParams: ["executionId"] as const,
    requestSchema: runbookWorkerHeartbeatRequestV2Schema,
    responseSchema: runbookWorkerAcceptedResponseSchema,
  }),
  saveExecutionSnapshot: defineHttpEndpointContract({
    method: "POST",
    path: "/api/worker/runbook-executions/:executionId/snapshot",
    requestEncoding: "body",
    pathParams: ["executionId"] as const,
    requestSchema: runbookWorkerSnapshotUpdateRequestV2Schema.extend({
      executionId: runbookWorkerHeartbeatRequestSchema.shape.executionId,
    }),
    responseSchema: runbookWorkerAcceptedResponseSchema,
  }),
  issueCredentialGrant: defineHttpEndpointContract({
    method: "POST",
    path: "/api/worker/runbook-executions/:executionId/credential-grants",
    requestEncoding: "body",
    pathParams: ["executionId"] as const,
    requestSchema: credentialGrantRequestSchema,
    responseSchema: credentialGrantResponseSchema,
  }),
  redeemCredentialGrant: defineHttpEndpointContract({
    method: "POST",
    path: "/api/worker/credential-redemptions",
    requestEncoding: "body",
    requestSchema: credentialRedemptionRequestSchema,
    responseSchema: credentialRedemptionResponseSchema,
  }),
};
