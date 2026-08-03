// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunbookAuthoringProposalCards } from "@bitsentry-ce/components/investigation/Incidents";
import type { ChatMessage } from "@bitsentry-ce/components/chat/types";
import type {
  AgentServicePort,
  RunbookAuthoringProposalReview,
} from "@bitsentry-ce/components/services/contracts";

const translations: Record<string, string> = {
  "common.incidents.approve": "Approve",
  "common.incidents.deny": "Deny",
  "common.incidents.suggest": "Suggest",
  "common.incidents.suggestDifferentEdit": "Suggest a different edit",
  "common.incidents.newRunbookProposal": "New runbook proposal",
  "common.incidents.runbookEditProposal": "Runbook edit proposal",
  "common.incidents.statusApproved": "Approved",
  "common.incidents.statusPendingApproval": "Pending approval",
  "common.incidents.statusRejected": "Rejected",
  "common.incidents.statusRevisionRequested": "Revision requested",
  "common.incidents.savedAs": "Saved as {{title}}",
  "common.incidents.reviseNewRunbookProposal": "Revise create-kind proposal {{proposalId}}: {{requestedEdit}}. Use propose_runbook_create, not propose_runbook_edit, because the draft was never saved.",
  "common.incidents.reviseExistingRunbookProposal": "Revise edit-kind proposal {{proposalId}}: {{requestedEdit}}. Use propose_runbook_edit for target {{targetRunbookId}}.",
};

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      (translations[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(options?.[name] ?? ""),
      ),
  }),
}));

afterEach(() => {
  cleanup();
});

function makeProposal(
  overrides: Partial<RunbookAuthoringProposalReview> = {},
): RunbookAuthoringProposalReview {
  return {
    status: "pending_approval",
    approvalRequired: true,
    saved: false,
    proposalId: "proposal-1",
    kind: "create_new_runbook",
    incidentThreadId: "incident-1",
    proposedRunbook: {
      id: "runbook-1",
      title: "Check service status",
      description: "Collect service health.",
      revisionNumber: 1,
      actionCount: 1,
      actions: [{ id: "step-1", type: "shell", title: "Check status" }],
    },
    validation: { valid: true, errors: [], warnings: [] },
    operationDiffs: [
      {
        operationId: "create-runbook",
        type: "create_runbook",
        rationale: "Create the requested runbook.",
        riskLabels: ["shell"],
        before: null,
        after: {},
      },
    ],
    nextStep: "Review the proposal.",
    ...overrides,
  };
}

function messageFor(proposal: RunbookAuthoringProposalReview): ChatMessage {
  return {
    kind: "agent",
    iterations: [],
    activeIterationId: null,
    toolCalls: [
      {
        toolCallId: "tool-call-1",
        toolName: "propose_runbook_create",
        state: "done",
        output: JSON.stringify(proposal),
      },
    ],
    finalText: null,
    status: "done",
  };
}

function makeAgent(
  overrides: Partial<AgentServicePort> = {},
): AgentServicePort {
  return {
    start: vi.fn(),
    send: vi.fn(),
    cancel: vi.fn(),
    getStatus: vi.fn(),
    getSnapshot: vi.fn(),
    listRunbookAuthoringProposals: vi.fn().mockResolvedValue([]),
    approveRunbookAuthoringProposal: vi.fn(),
    rejectRunbookAuthoringProposal: vi.fn(),
    requestRunbookAuthoringRevision: vi.fn(),
    onEvent: vi.fn(),
    ...overrides,
  };
}

function renderCards(
  agent: AgentServicePort,
  proposal = makeProposal(),
  onRevisionRequested = vi.fn(),
) {
  return render(
    <RunbookAuthoringProposalCards
      agent={agent}
      incidentId="incident-1"
      sessionId="session-1"
      message={messageFor(proposal)}
      onRevisionRequested={onRevisionRequested}
    />,
  );
}

describe("RunbookAuthoringProposalCards", () => {
  it("renders the live approved status over a pending tool-call snapshot", async () => {
    const approved = makeProposal({ status: "approved", saved: true });
    const agent = makeAgent({
      listRunbookAuthoringProposals: vi.fn().mockResolvedValue([approved]),
    });

    renderCards(agent)

    expect(await screen.findByText("Approved")).toBeTruthy();
    expect(screen.getByText("Saved as Check service status")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("reconciles an already-decided approval instead of surfacing the stale pending error", async () => {
    const pending = makeProposal();
    const approved = makeProposal({ status: "approved", saved: true });
    const agent = makeAgent({
      listRunbookAuthoringProposals: vi
        .fn()
        .mockResolvedValueOnce([pending])
        .mockResolvedValueOnce([approved]),
      approveRunbookAuthoringProposal: vi
        .fn()
        .mockRejectedValue(new Error("Only pending runbook authoring proposals can be approved.")),
    });

    renderCards(agent)

    expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByText("Approved")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("Only pending runbook authoring proposals can be approved.")).toBeNull();
    });
  });

  it("announces the saved runbook and publishes its catalog update", async () => {
    const pending = makeProposal();
    const approved = makeProposal({ status: "approved", saved: true });
    const savedRunbook = {
      id: "runbook-1",
      title: "Saved service status",
      description: "Collect service health.",
      revisionNumber: 1,
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      actions: [],
    };
    const onRunbooksUpdated = vi.fn();
    window.addEventListener("bitsentry:runbooks-updated", onRunbooksUpdated);
    const agent = makeAgent({
      listRunbookAuthoringProposals: vi
        .fn()
        .mockResolvedValueOnce([pending])
        .mockResolvedValueOnce([approved]),
      approveRunbookAuthoringProposal: vi.fn().mockResolvedValue({
        proposal: approved,
        savedRunbook,
      }),
    });

    renderCards(agent);

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    expect(await screen.findByText("Saved as Saved service status")).toBeTruthy();
    expect(onRunbooksUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { runbook: savedRunbook } }),
    );
    window.removeEventListener("bitsentry:runbooks-updated", onRunbooksUpdated);
  });

  it("sends create-kind revision guidance back to the chat", async () => {
    const proposal = makeProposal();
    const onRevisionRequested = vi.fn();
    const agent = makeAgent({
      listRunbookAuthoringProposals: vi.fn().mockResolvedValue([proposal]),
      requestRunbookAuthoringRevision: vi.fn().mockResolvedValue({
        proposal: makeProposal({ status: "revision_requested" }),
        requestedEdit: "Add a verification step.",
      }),
    });

    renderCards(agent, proposal, onRevisionRequested);

    const input = await screen.findByPlaceholderText("Suggest a different edit");
    fireEvent.change(input, { target: { value: "Add a verification step." } });
    fireEvent.click(screen.getByRole("button", { name: "Suggest" }));

    await waitFor(() => {
      expect(onRevisionRequested).toHaveBeenCalledWith(
        expect.stringContaining("propose_runbook_create"),
      );
    });
  });

  it("sends edit-kind revision guidance with the original target runbook", async () => {
    const proposal = makeProposal({
      kind: "edit_existing_runbook",
      targetRunbookId: "runbook-existing",
    });
    const onRevisionRequested = vi.fn();
    const agent = makeAgent({
      listRunbookAuthoringProposals: vi.fn().mockResolvedValue([proposal]),
      requestRunbookAuthoringRevision: vi.fn().mockResolvedValue({
        proposal: makeProposal({
          kind: "edit_existing_runbook",
          targetRunbookId: "runbook-existing",
          status: "revision_requested",
        }),
        requestedEdit: "Add a verification step.",
      }),
    });

    renderCards(agent, proposal, onRevisionRequested);

    const input = await screen.findByPlaceholderText("Suggest a different edit");
    fireEvent.change(input, { target: { value: "Add a verification step." } });
    fireEvent.click(screen.getByRole("button", { name: "Suggest" }));

    await waitFor(() => {
      expect(onRevisionRequested).toHaveBeenCalledWith(
        expect.stringContaining("propose_runbook_edit"),
      );
      expect(onRevisionRequested).toHaveBeenCalledWith(
        expect.stringContaining("runbook-existing"),
      );
    });
  });
});
