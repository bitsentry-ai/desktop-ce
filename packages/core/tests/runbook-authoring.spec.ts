import { describe, expect, it } from "vitest";
import {
  approveRunbookAuthoringProposal,
  createRunbookCreationProposal,
  createRunbookEditProposal,
  rejectRunbookAuthoringProposal,
  requestRunbookAuthoringRevision,
  RunbookProposalValidationError,
} from "../src/features/runbooks";
import { validateRunbook } from "../src/features/runbooks/authoring";
import type { RunbookRecord } from "../src/features/runbooks/desktop-runbook.types";

function makeBaseRunbook(): RunbookRecord {
  return {
    id: "runbook-existing",
    title: "Investigate API errors",
    description: "Collect baseline evidence for API incidents.",
    revisionNumber: 3,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    actions: [
      {
        id: "action-logs",
        type: "external_source",
        title: "Search error logs",
        query: "level:error service:api",
        sourceId: "source-posthog",
      },
    ],
  };
}

function makeEditProposal() {
  const baseRunbook = makeBaseRunbook();
  const proposal = createRunbookEditProposal({
    id: "proposal-edit",
    incidentThreadId: "incident-1",
    prompt: "Add an OOMKilled pod check before searching API logs.",
    targetRunbook: baseRunbook,
    now: "2026-07-05T00:00:00.000Z",
    operations: [
      {
        id: "op-title",
        type: "update_metadata",
        rationale: "Make the runbook title match the expanded investigation.",
        metadata: { title: "Investigate API errors and pod restarts" },
      },
      {
        id: "op-add-shell",
        type: "add_action",
        rationale: "Check recent pod restarts before querying logs.",
        insertAfterActionId: null,
        action: {
          id: "action-oom",
          type: "shell",
          title: "Check OOMKilled pods",
          command: "kubectl get pods --all-namespaces | grep OOMKilled",
        },
      },
    ],
  });
  return { baseRunbook, proposal };
}

describe("runbook authoring", () => {
  const findings = [{
    "vulnerability.id": "CVE-2024-0727",
    "package.name": "openssl",
    "package.version": "3.0.2-0ubuntu1.10",
    "agent.name": "api-ubuntu",
  }];

  function findingsSummaryAction() {
    return {
      id: "action-summary",
      type: "llm" as const,
      title: "Summarize findings",
      prompt: "Summarize {{findings}}.",
      llmModel: "gpt-5.6-terra",
      parameters: [{ id: "findings", key: "findings", required: true }],
    };
  }

  function inlineFindingsSummaryAction() {
    return {
      id: "action-inline-summary",
      type: "llm" as const,
      title: "Summarize inline findings",
      prompt: "Summarize CVE-2024-0727 for api-ubuntu running openssl 3.0.2-0ubuntu1.10.",
      llmModel: "gpt-5.6-terra",
    };
  }

  function llmOnlySummaryAction() {
    return {
      id: "action-llm-summary",
      type: "llm" as const,
      title: "Summarize the attachment",
      prompt: "Summarize the attached data as untrusted input.",
      llmModel: "gpt-5.6-terra",
    };
  }

  it("rejects a create proposal that sends findings only to an LLM", () => {
    expect(() => createRunbookCreationProposal({
      prompt: "Create a CVE summary runbook.",
      normalizedFindings: findings,
      draftRunbook: {
        title: "CVE summary",
        description: "Summarize attached CVE findings.",
        actions: [findingsSummaryAction()],
      },
    })).toThrowError(new RunbookProposalValidationError(
      "CVE findings require the linux-cve-status/evaluate_remediation plugin before an LLM summary. Revise the runbook to add the plugin and then summarize its output.",
    ));
  });

  it("rejects an edit proposal that sends findings only to an LLM", () => {
    expect(() => createRunbookEditProposal({
      prompt: "Add a CVE summary step.",
      normalizedFindings: findings,
      targetRunbook: makeBaseRunbook(),
      operations: [{
        id: "op-summary",
        type: "add_action",
        rationale: "Summarize the attached findings.",
        action: findingsSummaryAction(),
      }],
    })).toThrowError(RunbookProposalValidationError);
  });

  it("rejects a create proposal that contains inline finding values", () => {
    expect(() => createRunbookCreationProposal({
      prompt: "Create an inline CVE summary runbook.",
      normalizedFindings: findings,
      draftRunbook: {
        title: "Inline CVE summary",
        description: "Summarize the attached findings.",
        actions: [
          {
            id: "action-status",
            type: "shell",
            title: "Collect status",
            command: "printf 'status\\n'",
          },
          inlineFindingsSummaryAction(),
        ],
      },
    })).toThrowError(RunbookProposalValidationError);
  });

  it("rejects an edit proposal that contains inline finding values", () => {
    expect(() => createRunbookEditProposal({
      prompt: "Add an inline CVE summary step.",
      normalizedFindings: findings,
      targetRunbook: makeBaseRunbook(),
      operations: [{
        id: "op-inline-summary",
        type: "add_action",
        rationale: "Summarize the attached findings inline.",
        action: inlineFindingsSummaryAction(),
      }],
    })).toThrowError(RunbookProposalValidationError);
  });

  it("rejects an LLM-only create proposal with findings", () => {
    expect(() => createRunbookCreationProposal({
      prompt: "Create an LLM-only CVE summary.",
      normalizedFindings: findings,
      draftRunbook: {
        title: "LLM-only CVE summary",
        description: "Summarize the attached findings.",
        actions: [llmOnlySummaryAction()],
      },
    })).toThrowError(RunbookProposalValidationError);
  });

  it("rejects an LLM-only edit proposal with findings", () => {
    expect(() => createRunbookEditProposal({
      prompt: "Add an LLM-only CVE summary.",
      normalizedFindings: findings,
      targetRunbook: { ...makeBaseRunbook(), actions: [] },
      operations: [{
        id: "op-llm-summary",
        type: "add_action",
        rationale: "Summarize the attached findings.",
        action: llmOnlySummaryAction(),
      }],
    })).toThrowError(RunbookProposalValidationError);
  });

  it("accepts a plugin evaluation followed by an LLM summary", () => {
    const proposal = createRunbookCreationProposal({
      prompt: "Create a CVE analysis runbook.",
      normalizedFindings: findings,
      draftRunbook: {
        title: "CVE analysis",
        description: "Evaluate findings and summarize the result.",
        actions: [
          {
            id: "action-plugin",
            type: "plugin",
            title: "Evaluate CVE remediation",
            pluginId: "linux-cve-status",
            pluginActionId: "evaluate_remediation",
            pluginInput: "{{findings}}",
            parameters: [{ id: "findings", key: "findings", required: true }],
          },
          findingsSummaryAction(),
        ],
      },
    });

    expect(proposal.status).toBe("pending_approval");
  });

  it("accepts a plugin evaluation followed by an LLM summary on edit", () => {
    const proposal = createRunbookEditProposal({
      prompt: "Add CVE evaluation and summary steps.",
      normalizedFindings: findings,
      targetRunbook: makeBaseRunbook(),
      operations: [
        {
          id: "op-plugin",
          type: "add_action",
          rationale: "Evaluate CVE remediation first.",
          action: {
            id: "action-plugin",
            type: "plugin",
            title: "Evaluate CVE remediation",
            pluginId: "linux-cve-status",
            pluginActionId: "evaluate_remediation",
            pluginInput: "{{findings}}",
          },
        },
        {
          id: "op-summary",
          type: "add_action",
          rationale: "Summarize the plugin output.",
          action: findingsSummaryAction(),
        },
      ],
    });

    expect(proposal.status).toBe("pending_approval");
  });

  it("allows an LLM-only runbook without findings", () => {
    const proposal = createRunbookCreationProposal({
      prompt: "Create a text summary runbook.",
      draftRunbook: {
        title: "Text summary",
        description: "Summarize supplied text.",
        actions: [{
          id: "action-summary",
          type: "llm",
          title: "Summarize text",
          prompt: "Summarize the supplied text.",
          llmModel: "gpt-5.6-terra",
        }],
      },
    });

    expect(proposal.status).toBe("pending_approval");
  });

  it("allows an LLM-only edit without findings", () => {
    const proposal = createRunbookEditProposal({
      prompt: "Add a text summary step.",
      targetRunbook: makeBaseRunbook(),
      operations: [{
        id: "op-summary",
        type: "add_action",
        rationale: "Summarize supplied text.",
        action: llmOnlySummaryAction(),
      }],
    });

    expect(proposal.status).toBe("pending_approval");
  });

  it("allows a create proposal with one unrelated CVE mention and no findings", () => {
    const proposal = createRunbookCreationProposal({
      prompt: "Create a text summary for CVE-9999-0000.",
      draftRunbook: {
        title: "Unrelated CVE note",
        description: "Summarize supplied text.",
        actions: [{
          id: "action-summary",
          type: "llm",
          title: "Summarize text",
          prompt: "Mention CVE-9999-0000 only as supplied text.",
          llmModel: "gpt-5.6-terra",
        }],
      },
    });

    expect(proposal.status).toBe("pending_approval");
  });

  it("allows an edit proposal with one unrelated CVE mention and no findings", () => {
    const proposal = createRunbookEditProposal({
      prompt: "Add a text note for CVE-9999-0000.",
      targetRunbook: makeBaseRunbook(),
      operations: [{
        id: "op-summary",
        type: "add_action",
        rationale: "Mention one unrelated CVE in supplied text.",
        action: {
          id: "action-summary",
          type: "llm",
          title: "Summarize text",
          prompt: "Mention CVE-9999-0000 only as supplied text.",
          llmModel: "gpt-5.6-terra",
        },
      }],
    });

    expect(proposal.status).toBe("pending_approval");
  });

  it("creates a valid, non-mutating edit proposal with shell risks", () => {
    const { baseRunbook, proposal } = makeEditProposal();

    expect(proposal.status).toBe("pending_approval");
    expect(baseRunbook).toMatchObject({
      title: "Investigate API errors",
      actions: [{ id: "action-logs" }],
    });
    expect(proposal.proposedRunbook).toMatchObject({
      revisionNumber: 4,
      actions: expect.arrayContaining([expect.objectContaining({ id: "action-oom" })]),
    });
    expect(proposal.proposedRunbook.actions).toHaveLength(2);
    expect(proposal.operationDiffs.some((diff) => diff.riskLabels.includes("shell"))).toBe(true);
    expect(proposal.validation.valid).toBe(true);
  });

  it("applies only selected operations", () => {
    const { proposal } = makeEditProposal();
    const selectedApproval = approveRunbookAuthoringProposal({
      proposal,
      approvedOperationIds: ["op-title"],
      now: "2026-07-05T00:01:00.000Z",
    });

    expect(selectedApproval.runbook.title).toBe("Investigate API errors and pod restarts");
    expect(selectedApproval.runbook.actions).toHaveLength(1);
    expect(selectedApproval.runbook.actions.some((action) => action.id === "action-oom")).toBe(false);
  });

  it("applies every operation when no selection is supplied", () => {
    const { proposal } = makeEditProposal();
    const fullApproval = approveRunbookAuthoringProposal({
      proposal,
      now: "2026-07-05T00:02:00.000Z",
    });

    expect(fullApproval.runbook.actions.some((action) => action.id === "action-oom")).toBe(true);
    expect(fullApproval.proposal.status).toBe("approved");
  });

  it("rejects an approval that names an unknown operation", () => {
    const { proposal } = makeEditProposal();

    expect(() => approveRunbookAuthoringProposal({
      proposal,
      approvedOperationIds: ["op-title", "op-not-real"],
    })).toThrow("Approval references an unknown runbook authoring operation.");
  });

  it("rejects and requests revisions without changing the current runbook", () => {
    const { baseRunbook, proposal } = makeEditProposal();
    const rejection = rejectRunbookAuthoringProposal({
      proposal,
      reason: "Use journalctl instead of kubectl.",
      now: "2026-07-05T00:03:00.000Z",
    });
    const revisionRequest = requestRunbookAuthoringRevision({
      proposal,
      requestedEdit: "Suggest a read-only journalctl action instead.",
      now: "2026-07-05T00:04:00.000Z",
    });

    expect(rejection.proposal.status).toBe("rejected");
    expect(baseRunbook.actions).toHaveLength(1);
    expect(revisionRequest).toMatchObject({
      proposal: { status: "revision_requested" },
      requestedEdit: "Suggest a read-only journalctl action instead.",
    });
  });

  it("creates a shell-risk proposal and returns it for saving only after approval", () => {
    const creationProposal = createRunbookCreationProposal({
      id: "proposal-create",
      incidentThreadId: "incident-2",
      prompt: "Create a Redis latency triage runbook.",
      now: "2026-07-05T00:05:00.000Z",
      draftRunbook: {
        title: "Redis latency triage",
        description: "Gather Redis latency evidence.",
        actions: [{
          id: "action-redis-info",
          type: "shell",
          title: "Collect Redis latency info",
          command: "redis-cli --latency-history -i 1",
        }],
      },
    });
    const creationApproval = approveRunbookAuthoringProposal({
      proposal: creationProposal,
      now: "2026-07-05T00:06:00.000Z",
    });

    expect(creationProposal).toMatchObject({
      kind: "create_new_runbook",
      status: "pending_approval",
      operationDiffs: [expect.objectContaining({ before: null, riskLabels: ["shell"] })],
    });
    expect(creationApproval).toMatchObject({
      proposal: { status: "approved" },
      runbook: { title: "Redis latency triage" },
    });
  });

  it("accepts a friendly catalog model name in an LLM authoring proposal", () => {
    const proposal = createRunbookCreationProposal({
      id: "proposal-friendly-model",
      prompt: "Create an LLM summary runbook.",
      draftRunbook: {
        title: "Friendly model summary",
        description: "Summarize evidence with a catalog model.",
        actions: [{
          id: "action-summary",
          type: "llm",
          title: "Summarize evidence",
          prompt: "Summarize the evidence.",
          llmModel: "GPT 5.6 Terra",
        }],
      },
    });

    expect(proposal.validation).toMatchObject({ valid: true, errors: [] });
  });

  it("rejects an unknown LLM model before approval", () => {
    const proposal = createRunbookCreationProposal({
      id: "proposal-unknown-model",
      prompt: "Create an invalid LLM summary runbook.",
      draftRunbook: {
        title: "Unknown model summary",
        description: "The model should be rejected.",
        actions: [{
          id: "action-summary",
          type: "llm",
          title: "Summarize evidence",
          prompt: "Summarize the evidence.",
          llmModel: "not-a-catalog-model",
        }],
      },
    });

    expect(proposal.validation.valid).toBe(false);
    expect(proposal.validation.errors).toContain(
      'LLM action "Summarize evidence" references unknown model "not-a-catalog-model". Use a model ID or display name from the catalog.',
    );
  });

  it("keeps the existing action risk-label regression matrix intact", () => {
    const cases = [
      {
        id: "shell",
        action: {
          type: "shell" as const,
          title: "Run a shell check",
          command: "printf ok",
        },
        labels: ["shell"],
      },
      {
        id: "http-write",
        action: {
          type: "http" as const,
          title: "Send an HTTP update",
          method: "POST" as const,
          url: "https://example.com/update",
        },
        labels: ["http_write"],
      },
      {
        id: "webhook",
        action: {
          type: "http" as const,
          title: "Call a webhook",
          method: "GET" as const,
          url: "https://example.com/webhook",
        },
        labels: ["webhook"],
      },
      {
        id: "local-ai",
        action: {
          type: "llm" as const,
          title: "Summarize locally",
          prompt: "Summarize the collected evidence.",
        },
        labels: ["local_ai"],
      },
      {
        id: "external-source",
        action: {
          type: "external_source" as const,
          title: "Read an external source",
          query: "status:error",
          sourceId: "source-test",
        },
        labels: ["external_source"],
      },
      {
        id: "unsupported",
        action: {
          type: "future_action" as RunbookRecord["actions"][number]["type"],
          title: "Future action",
        },
        labels: ["unsupported"],
      },
    ] as const;

    for (const testCase of cases) {
      const proposal = createRunbookCreationProposal({
        id: `proposal-risk-regression-${testCase.id}`,
        prompt: "Verify the existing authoring risk labels.",
        now: "2026-07-05T00:07:30.000Z",
        draftRunbook: {
          title: `Risk-label regression: ${testCase.id}`,
          description: "Exercise one existing authoring risk category.",
          actions: [{ id: `action-${testCase.id}`, ...testCase.action }],
        },
      });

      expect(proposal.validation.valid).toBe(true);
      expect(proposal.operationDiffs[0]?.riskLabels).toEqual(testCase.labels);
    }
  });

  it("labels a plugin proposal as an external source instead of unsupported", () => {
    const proposal = createRunbookCreationProposal({
      id: "proposal-plugin",
      prompt: "Create a runbook that lists open issues through the GitHub plugin.",
      now: "2026-07-05T00:08:00.000Z",
      draftRunbook: {
        title: "List GitHub issues",
        description: "Read issue data through the installed plugin.",
        actions: [{
          id: "action-plugin",
          type: "plugin",
          title: "List issues",
          pluginId: "github",
          pluginActionId: "list_issues",
        }],
      },
    });

    expect(proposal.operationDiffs[0]?.riskLabels).toEqual(["external_source"]);
    expect(proposal.operationDiffs[0]?.riskLabels).not.toContain("unsupported");
  });

  it("adds secret-consuming risk to an authenticated plugin proposal", () => {
    const proposal = createRunbookCreationProposal({
      id: "proposal-authenticated-plugin",
      prompt: "Create an authenticated GitHub issue lookup runbook.",
      now: "2026-07-05T00:09:00.000Z",
      draftRunbook: {
        title: "Authenticated GitHub issue lookup",
        description: "Read issue data with plugin authentication.",
        actions: [{
          id: "action-authenticated-plugin",
          type: "plugin",
          title: "List private issues",
          pluginId: "github",
          pluginActionId: "list_issues",
          pluginAuth: '{"token":"${globals.github_token}"}',
        }],
      },
    });

    expect(proposal.operationDiffs[0]?.riskLabels).toEqual([
      "external_source",
      "secret_consuming",
    ]);
  });

  it("does not approve invalid creation proposals", () => {
    const unsafeCreationProposal = createRunbookCreationProposal({
      id: "proposal-unsafe-create",
      prompt: "Create a runbook with an unsafe secret default.",
      now: "2026-07-05T00:07:00.000Z",
      draftRunbook: {
        title: "Unsafe secret runbook",
        description: "Should not be approvable.",
        actions: [{
          id: "action-secret",
          type: "http",
          title: "Call secret API",
          method: "POST",
          url: "https://example.com/webhook",
          parameters: [{ id: "token", key: "token", secure: true, defaultValue: "plaintext-secret" }],
        }],
      },
    });

    expect(unsafeCreationProposal.validation.valid).toBe(false);
    expect(() => approveRunbookAuthoringProposal({ proposal: unsafeCreationProposal })).toThrow();
  });

  it("lists available action ids when an edit targets a missing action", () => {
    expect(() => createRunbookEditProposal({
      prompt: "Update the log step.",
      targetRunbook: makeBaseRunbook(),
      operations: [{
        id: "op-1",
        type: "update_action",
        rationale: "Use the existing log step.",
        actionId: "invented-action",
        action: { id: "invented-action", type: "shell", title: "Updated status", command: "systemctl is-active bitsentry" },
      }],
    })).toThrow("Available actions: action-logs (external_source: Search error logs).");
  });

  it("flags an out-of-range idle timeout before approval", () => {
    const validation = validateRunbook({ ...makeBaseRunbook(), idleTimeout: 3600 });

    expect(validation.valid).toBe(false)
    expect(validation.errors).toContain(
      "Runbook idle timeout must be an integer from 0 to 1440 minutes.",
    );
  });
});
