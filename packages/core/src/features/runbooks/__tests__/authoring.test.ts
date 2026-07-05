import {
  approveRunbookAuthoringProposal,
  createRunbookCreationProposal,
  createRunbookEditProposal,
  rejectRunbookAuthoringProposal,
  requestRunbookAuthoringRevision,
} from "../index";
import type { RunbookRecord } from "../desktop-runbook.types";

const assert = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const baseRunbook: RunbookRecord = {
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
      metadata: {
        title: "Investigate API errors and pod restarts",
      },
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

assert(
  proposal.status === "pending_approval",
  "runbook edit proposals should wait for explicit approval",
);
assert(
  baseRunbook.title === "Investigate API errors" &&
    baseRunbook.actions.length === 1,
  "creating an edit proposal should not mutate the current runbook",
);
assert(
  proposal.proposedRunbook.actions.length === 2 &&
    proposal.proposedRunbook.revisionNumber === 4,
  "edit proposals should show the proposed next revision before saving",
);
assert(
  proposal.operationDiffs.some((diff) => diff.riskLabels.includes("shell")),
  "proposal diffs should label risky shell operations before approval",
);
assert(
  proposal.validation.valid,
  "valid proposed edits should pass validation",
);

const selectedApproval = approveRunbookAuthoringProposal({
  proposal,
  approvedOperationIds: ["op-title"],
  now: "2026-07-05T00:01:00.000Z",
});
assert(
  selectedApproval.runbook.title ===
    "Investigate API errors and pod restarts",
  "approving one edit should apply that edit",
);
assert(
  selectedApproval.runbook.actions.length === 1,
  "approving one edit should not apply unapproved operations",
);

const fullApproval = approveRunbookAuthoringProposal({
  proposal,
  now: "2026-07-05T00:02:00.000Z",
});
assert(
  fullApproval.runbook.actions.some((action) => action.id === "action-oom"),
  "approving all edits should apply the proposed action",
);
assert(
  fullApproval.proposal.status === "approved",
  "approval should resolve the proposal as approved",
);

const rejection = rejectRunbookAuthoringProposal({
  proposal,
  reason: "Use journalctl instead of kubectl.",
  now: "2026-07-05T00:03:00.000Z",
});
assert(
  rejection.proposal.status === "rejected" && baseRunbook.actions.length === 1,
  "rejecting a proposal should leave the current runbook unchanged",
);

const revisionRequest = requestRunbookAuthoringRevision({
  proposal,
  requestedEdit: "Suggest a read-only journalctl action instead.",
  now: "2026-07-05T00:04:00.000Z",
});
assert(
  revisionRequest.proposal.status === "revision_requested" &&
    revisionRequest.requestedEdit ===
      "Suggest a read-only journalctl action instead.",
  "requesting a revision should keep the authoring loop open without saving",
);

const creationProposal = createRunbookCreationProposal({
  id: "proposal-create",
  incidentThreadId: "incident-2",
  prompt: "Create a Redis latency triage runbook.",
  now: "2026-07-05T00:05:00.000Z",
  draftRunbook: {
    title: "Redis latency triage",
    description: "Gather Redis latency evidence.",
    actions: [
      {
        id: "action-redis-info",
        type: "shell",
        title: "Collect Redis latency info",
        command: "redis-cli --latency-history -i 1",
      },
    ],
  },
});
assert(
  creationProposal.kind === "create_new_runbook" &&
    creationProposal.status === "pending_approval",
  "new runbooks should be proposed as drafts before they are saved",
);
assert(
  creationProposal.operationDiffs[0]?.before === null &&
    creationProposal.operationDiffs[0]?.riskLabels.includes("shell"),
  "new-runbook proposals should expose their before/after diff and risks",
);

const creationApproval = approveRunbookAuthoringProposal({
  proposal: creationProposal,
  now: "2026-07-05T00:06:00.000Z",
});
assert(
  creationApproval.runbook.title === "Redis latency triage" &&
    creationApproval.proposal.status === "approved",
  "approving a new-runbook proposal should return the runbook to save",
);

const unsafeCreationProposal = createRunbookCreationProposal({
  id: "proposal-unsafe-create",
  prompt: "Create a runbook with an unsafe secret default.",
  now: "2026-07-05T00:07:00.000Z",
  draftRunbook: {
    title: "Unsafe secret runbook",
    description: "Should not be approvable.",
    actions: [
      {
        id: "action-secret",
        type: "http",
        title: "Call secret API",
        method: "POST",
        url: "https://example.com/webhook",
        parameters: [
          {
            id: "token",
            key: "token",
            secure: true,
            defaultValue: "plaintext-secret",
          },
        ],
      },
    ],
  },
});
assert(
  !unsafeCreationProposal.validation.valid,
  "proposal validation should reject plaintext defaults for secure parameters",
);

let unsafeApprovalError: unknown;
try {
  approveRunbookAuthoringProposal({ proposal: unsafeCreationProposal });
} catch (error) {
  unsafeApprovalError = error;
}
assert(
  unsafeApprovalError instanceof Error,
  "invalid creation proposals should not be approvable",
);
