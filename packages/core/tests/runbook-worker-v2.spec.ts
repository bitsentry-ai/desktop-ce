import { describe, expect, it } from "vitest";
import {
  credentialGrantRequestSchema,
  credentialRedemptionRequestSchema,
  credentialRedemptionResponseSchema,
} from "../src/features/runbooks/credential-bindings.schemas";
import {
  runbookWorkerClaimNextExecutionRequestSchema,
  runbookWorkerExecutionContextResponseSchema,
} from "../src/features/runbooks/runbooks.schemas";
import {
  runbookWorkerClaimNextExecutionRequestV2Schema,
  runbookWorkerExecutionContextResponseV2Schema,
} from "../src/features/runbooks/worker-v2.schemas";

const binding = {
  actionId: "persisted-action-id",
  credentialId: "credential-id",
  credentialGenerationId: "generation-id",
  slot: "http-auth",
  kind: "http-auth" as const,
};

function claim() {
  return {
    executionId: "execution-id",
    userId: 1,
    runbookId: "runbook-id",
    runbookTitle: "Example",
    claimToken: "claim-token",
    protocolVersion: 2,
    workerClaimGeneration: 1,
    credentialBindings: [binding],
    parameterValues: { public: "hello" },
    resolvedGlobals: {
      values: { public: "hello" },
      definitions: [{ key: "TOKEN", secure: true }],
    },
    snapshot: {
      executionId: "execution-id",
      runbookId: "runbook-id",
      runbookTitle: "Example",
      status: "running",
      startedAt: "2026-09-18T00:00:00Z",
      source: "manual",
      steps: [],
      parameterValues: { public: "hello" },
    },
    context: {
      format: "bitsentry.runbook.context",
      version: 1,
      runbook: {
        id: "runbook-id",
        title: "Example",
        description: "",
        revisionNumber: 1,
        updatedAt: "2026-09-18T00:00:00Z",
        actionCount: 1,
      },
      summary: {
        purposeText: "",
        orderedActionTitles: ["Request"],
        actionTypeCounts: {
          data_source_query: 0,
          diagnosis: 0,
          external_source: 0,
          http: 1,
          llm: 0,
          plugin: 0,
          shell: 0,
          telemetry_existing_entry: 0,
          telemetry_ingest: 0,
        },
      },
      actions: [
        {
          id: "persisted-action-id",
          order: 0,
          type: "http",
          title: "Request",
          payload: {
            url: "https://example.test",
            parameters: [{ id: "parameter-id", key: "SECRET", secure: true }],
          },
        },
      ],
    },
  };
}

describe("Dashboard execution protocol v2", () => {
  it("preserves v1 negotiation and accepts a reference-only v2 claim", () => {
    expect(
      runbookWorkerClaimNextExecutionRequestSchema.parse({
        runtimeId: "worker",
      }),
    ).toEqual({ runtimeId: "worker" });
    expect(
      runbookWorkerClaimNextExecutionRequestV2Schema.safeParse({
        runtimeId: "worker",
      }).success,
    ).toBe(false);
    expect(
      runbookWorkerExecutionContextResponseSchema.safeParse(claim()).success,
    ).toBe(true);
    expect(
      runbookWorkerExecutionContextResponseV2Schema.safeParse(claim()).success,
    ).toBe(true);
  });

  it("rejects secure global values", () => {
    const input = claim();
    Object.assign(input.resolvedGlobals.values, { TOKEN: "synthetic-secret" });
    expect(
      runbookWorkerExecutionContextResponseV2Schema.safeParse(input).success,
    ).toBe(false);
  });

  it.each(["parameterValues", "snapshot"] as const)(
    "rejects secure parameters in %s",
    (location) => {
      const input = claim();
      const values =
        location === "snapshot"
          ? input.snapshot.parameterValues
          : input.parameterValues;
      Object.assign(values, { SECRET: "synthetic-secret" });
      expect(
        runbookWorkerExecutionContextResponseV2Schema.safeParse(input).success,
      ).toBe(false);
    },
  );

  it("rejects legacy plugin auth without changing the v1 reader", () => {
    const input = claim();
    Object.assign(input.context.actions[0]!.payload, {
      pluginAuth: "legacy-encrypted-auth",
    });
    expect(
      runbookWorkerExecutionContextResponseSchema.safeParse(input).success,
    ).toBe(true);
    expect(
      runbookWorkerExecutionContextResponseV2Schema.safeParse(input).success,
    ).toBe(false);
  });

  it("rejects duplicate slots and bindings to a step index", () => {
    const duplicate = claim();
    duplicate.credentialBindings.push(binding);
    expect(
      runbookWorkerExecutionContextResponseV2Schema.safeParse(duplicate)
        .success,
    ).toBe(false);
    const indexed = claim();
    indexed.credentialBindings = [{ ...binding, actionId: "0" }];
    expect(
      runbookWorkerExecutionContextResponseV2Schema.safeParse(indexed).success,
    ).toBe(false);
  });

  it("requires a positive current claim generation and attempt identity", () => {
    const input = {
      executionId: "execution-id",
      runtimeId: "worker",
      claimToken: "claim",
      workerClaimGeneration: 1,
      actionId: "persisted-action-id",
      attemptNumber: 1,
      slot: "http-auth",
    };
    expect(credentialGrantRequestSchema.safeParse(input).success).toBe(true);
    expect(
      credentialGrantRequestSchema.safeParse({
        ...input,
        workerClaimGeneration: 0,
      }).success,
    ).toBe(false);
    expect(
      credentialGrantRequestSchema.safeParse({ ...input, attemptNumber: 0 })
        .success,
    ).toBe(false);
    expect(
      credentialGrantRequestSchema.safeParse({ ...input, ownerId: 2 }).success,
    ).toBe(false);
  });

  it("redemption accepts only the opaque grant, not caller destinations or a service key", () => {
    const grant = "a".repeat(43);
    expect(credentialRedemptionRequestSchema.safeParse({ grant }).success).toBe(
      true,
    );
    expect(
      credentialRedemptionRequestSchema.safeParse({
        grant,
        url: "https://other.test",
      }).success,
    ).toBe(false);
    expect(
      credentialRedemptionRequestSchema.safeParse({ grant: "short" }).success,
    ).toBe(false);
  });

  it("requires matching kind and generation in the authorized redemption response", () => {
    const response = {
      kind: "http-auth",
      bundle: { token: "synthetic-secret" },
      generationId: "generation-id",
      binding,
      policy: {
        operation: "http",
        url: "https://example.test",
        method: "GET",
        authentication: "bearer",
        allowPrivateNetwork: false,
      },
      deadlineAt: "2026-09-18T00:00:30Z",
    };
    expect(credentialRedemptionResponseSchema.safeParse(response).success).toBe(
      true,
    );
    expect(
      credentialRedemptionResponseSchema.safeParse({
        ...response,
        generationId: "other",
      }).success,
    ).toBe(false);
    expect(
      credentialRedemptionResponseSchema.safeParse({ ...response, kind: "ssh" })
        .success,
    ).toBe(false);
    expect(
      credentialRedemptionResponseSchema.safeParse({
        ...response,
        policy: { ...response.policy, url: "https://user:secret@example.test" },
      }).success,
    ).toBe(false);
    expect(
      credentialRedemptionResponseSchema.safeParse({
        ...response,
        policy: { ...response.policy, url: "not a URL" },
      }).success,
    ).toBe(false);
  });
});
