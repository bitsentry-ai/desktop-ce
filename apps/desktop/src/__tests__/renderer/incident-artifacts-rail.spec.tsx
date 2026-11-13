// @vitest-environment jsdom

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IncidentArtifactsRail from "@bitsentry-ce/components/investigation/IncidentArtifactsRail";
import { BitsentryServicesProvider } from "@bitsentry-ce/components/services/context";
import type {
  BitsentryServicePorts,
  AgentServicePort,
  RunbookAuthoringProposalReview,
  RunbookExecutionRecord,
  RunbookExecutionStepStatus,
  RunbookExecutionStatus,
} from "@bitsentry-ce/components/services/contracts";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Partial<Record<string, string>> = {
        "common.incidentArtifactsRail.runbookExecutionCount_one":
          "{{count}} runbook execution",
        "common.incidentArtifactsRail.runbookExecutionCount_other":
          "{{count}} runbook executions",
        "common.incidentArtifactsRail.proposal.actionsUnavailableInClient":
          "Runbook proposal actions are unavailable in this client.",
        "common.incidentArtifactsRail.proposal.approve": "Approve",
        "common.incidentArtifactsRail.proposal.approveOperation":
          "Approve {{type}}",
        "common.incidentArtifactsRail.proposal.artifactVersion":
          "Artifact version",
        "common.incidentArtifactsRail.proposal.latestSuffix": " · Latest",
        "common.incidentArtifactsRail.proposal.newRunbook": "New runbook",
        "common.incidentArtifactsRail.proposal.noDescription":
          "No description.",
        "common.incidentArtifactsRail.proposal.proposedChanges":
          "Proposed changes",
        "common.incidentArtifactsRail.proposal.rawJson": "Raw JSON",
        "common.incidentArtifactsRail.proposal.reject": "Reject",
        "common.incidentArtifactsRail.proposal.restore": "Restore",
        "common.incidentArtifactsRail.proposal.reviewNotes": "Review notes",
        "common.incidentArtifactsRail.proposal.reviseInChat": "Revise in chat",
        "common.incidentArtifactsRail.proposal.revisionPlaceholder":
          "Describe what the agent should revise…",
        "common.incidentArtifactsRail.proposal.risks": "Risks: {{risks}}",
        "common.incidentArtifactsRail.proposal.runbookUpdate":
          "Runbook update",
        "common.incidentArtifactsRail.proposal.steps": "Steps",
        "common.incidentArtifactsRail.proposal.versionOption": "v{{version}}",
        "common.incidentArtifactsRail.proposal.versionSummary":
          "Runbook proposal · v{{version}}",
        "common.incidentArtifactsRail.status.completed": "Completed",
        "common.incidentArtifactsRail.status.failed": "Failed",
        "common.incidentArtifactsRail.stepStatus.completed": "Completed",
        "common.incidentArtifactsRail.stepStatus.failed": "Failed",
        "common.incidentArtifactsRail.stepsComplete":
          "{{completed}}/{{total}} steps complete",
      };
      const count = options?.count;
      let lookupKey = key;
      if (typeof count === "number") {
        lookupKey = `${key}_other`;
        if (count === 1) {
          lookupKey = `${key}_one`;
        }
      }

      let template = key;
      const translated = translations[lookupKey];
      if (translated !== undefined) {
        template = translated;
      }

      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
        const value = options?.[name];
        if (typeof value === "string") return value;
        if (typeof value === "number") return String(value);
        return "";
      });
    },
  }),
}));

Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});

function stepStatusFor(status: RunbookExecutionStatus): RunbookExecutionStepStatus {
  if (status === "queued") {
    return "pending";
  }

  if (status === "claim_expired") {
    return "failed";
  }

  return status;
}

function completedAtFor(status: RunbookExecutionStatus): string | undefined {
  if (status === "running") {
    return undefined;
  }

  return "2026-05-26T12:01:00.000Z";
}

function unusedRunbookPortMethod(method: string): () => Promise<never> {
  return () => Promise.reject(new Error(`Unexpected runbook service call: ${method}`));
}

function createRunbookServices(): BitsentryServicePorts["runbooks"] {
  return {
    list: unusedRunbookPortMethod("list"),
    get: unusedRunbookPortMethod("get"),
    create: unusedRunbookPortMethod("create"),
    updateMetadata: unusedRunbookPortMethod("updateMetadata"),
    updateActions: unusedRunbookPortMethod("updateActions"),
    saveAction: unusedRunbookPortMethod("saveAction"),
    deleteAction: unusedRunbookPortMethod("deleteAction"),
    reorderActions: unusedRunbookPortMethod("reorderActions"),
    delete: unusedRunbookPortMethod("delete"),
    exportContext: unusedRunbookPortMethod("exportContext"),
    exportRunbooks: unusedRunbookPortMethod("exportRunbooks"),
    importRunbooks: unusedRunbookPortMethod("importRunbooks"),
    listTelemetryNeeds: unusedRunbookPortMethod("listTelemetryNeeds"),
    execute: unusedRunbookPortMethod("execute"),
    continueDiagnosis: unusedRunbookPortMethod("continueDiagnosis"),
    getExecution: vi.fn(() => Promise.resolve(null)),
    listExecutions: unusedRunbookPortMethod("listExecutions"),
    listTelemetryActivity: unusedRunbookPortMethod("listTelemetryActivity"),
    getLinkedTelemetryExecution: unusedRunbookPortMethod(
      "getLinkedTelemetryExecution",
    ),
    cancelExecution: unusedRunbookPortMethod("cancelExecution"),
    onExecutionEvent: vi.fn(() => () => {}),
    onChanged: vi.fn(() => () => {}),
  };
}

const RESULTS_KEY = "bitsentry_results";
const RESULT_TRACES_KEY = "bitsentry_result_traces";
const INCIDENT_ID = "incident-chat-1";
const OTHER_INCIDENT_ID = "incident-chat-2";

const ids = {
  failedResult: "11111111-1111-4111-8111-111111111111",
  failedExecution: "22222222-2222-4222-8222-222222222222",
  successResult: "33333333-3333-4333-8333-333333333333",
  successExecution: "44444444-4444-4444-8444-444444444444",
  manualResult: "55555555-5555-4555-8555-555555555555",
  manualExecution: "66666666-6666-4666-8666-666666666666",
  otherResult: "77777777-7777-4777-8777-777777777777",
  otherExecution: "88888888-8888-4888-8888-888888888888",
};

function execution(
  executionId: string,
  status: RunbookExecutionStatus,
  output: string,
  incidentThreadId: string | null = INCIDENT_ID,
  options: {
    structuredOutput?: Record<string, unknown>;
    type?: "shell" | "plugin";
  } = {},
): RunbookExecutionRecord {
  return {
    executionId,
    runbookId: "runbook-227",
    incidentThreadId,
    runbookTitle: "analyze server 227",
    status,
    startedAt: "2026-05-26T12:00:00.000Z",
    completedAt: completedAtFor(status),
    steps: [
      {
        actionId: `step-${executionId}`,
        order: 1,
        type: options.type ?? "shell",
        title: "SSH for journalctl",
        status: stepStatusFor(status),
        output,
        structuredOutput: options.structuredOutput,
      },
    ],
  };
}

function storedResult(
  resultId: string,
  executionRecord: RunbookExecutionRecord,
  incidentThreadId: string | undefined = INCIDENT_ID,
): {
  id: string;
  executionId: string;
  incidentThreadId?: string;
  runbookId: string;
  runbookTitle: string;
  status: RunbookExecutionStatus;
  startedAt: string;
  completedAt?: string;
} {
  return {
    id: resultId,
    executionId: executionRecord.executionId,
    incidentThreadId,
    runbookId: executionRecord.runbookId,
    runbookTitle: executionRecord.runbookTitle,
    status: executionRecord.status,
    startedAt: executionRecord.startedAt,
    completedAt: executionRecord.completedAt,
  };
}

function writeStoredArtifacts(
  results: Array<ReturnType<typeof storedResult>>,
  executions: Record<string, RunbookExecutionRecord>,
) {
  localStorage.setItem(RESULTS_KEY, JSON.stringify(results));
  localStorage.setItem(
    RESULT_TRACES_KEY,
    JSON.stringify(
      Object.fromEntries(
        results.map((result) => [
          result.id,
          { execution: executions[result.executionId] ?? null },
        ]),
      ),
    ),
  );
}

function renderRail(options: {
  agent?: AgentServicePort;
  messages?: React.ComponentProps<typeof IncidentArtifactsRail>["messages"];
  incidentId?: string;
} = {}) {
  const services: BitsentryServicePorts = {
    runbooks: createRunbookServices(),
    agent: options.agent,
  };

  const view = render(
    <BitsentryServicesProvider services={services}>
      <IncidentArtifactsRail
        isOpen
        onClose={() => {}}
        messages={options.messages ?? []}
        incidentId={options.incidentId ?? INCIDENT_ID}
      />
    </BitsentryServicesProvider>,
  );

  return { ...view, services };
}

function artifactButtonWithText(text: string): HTMLElement {
  const button = [...document.querySelectorAll("button")].find((element) =>
    element.textContent.includes(text),
  );

  if (button === undefined) {
    throw new Error(`Artifact button not found for text: ${text}`);
  }

  return button;
}

function detailPane(): HTMLElement {
  const pane = document.querySelector<HTMLElement>(
    '[data-tour="incidents-artifacts-detail"]',
  );
  if (pane === null) {
    throw new Error("Artifacts detail pane not found");
  }
  return pane;
}

function detailOutputText(): string {
  return detailPane().querySelector("pre")?.textContent ?? "";
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("IncidentArtifactsRail", () => {
  it("shows proposal versions and restores an earlier artifact as a new latest version", async () => {
    const proposal = (
      proposalId: string,
      artifactVersion: number,
      isLatest: boolean,
    ): RunbookAuthoringProposalReview => ({
      proposalId,
      artifactId: "artifact-1",
      artifactVersion,
      parentProposalId: artifactVersion === 1 ? undefined : "proposal-v1",
      isLatest,
      status: "pending_approval",
      approvalRequired: true,
      saved: false,
      supportsOperationApproval: false,
      kind: "create_new_runbook",
      incidentThreadId: INCIDENT_ID,
      proposedRunbook: {
        id: "draft-runbook",
        title: `API triage v${artifactVersion}`,
        description: "Collect API health evidence.",
        revisionNumber: 1,
        actionCount: 1,
        actions: [{ id: "health", type: "http", title: "Check health" }],
      },
      validation: { valid: true, errors: [], warnings: [] },
      operationDiffs: [{
        operationId: "create-runbook",
        type: "create_runbook",
        rationale: "Create the runbook.",
        riskLabels: [],
        before: null,
        after: {},
      }],
      nextStep: "Review the proposal.",
    });
    const v1 = proposal("proposal-v1", 1, false);
    const v2 = proposal("proposal-v2", 2, true);
    const v3 = {
      ...proposal("proposal-v3", 3, true),
      restoredFromProposalId: v1.proposalId,
    };
    const listRunbookAuthoringProposals = vi
      .fn()
      .mockResolvedValueOnce([v1, v2])
      .mockResolvedValue([v1, { ...v2, isLatest: false }, v3]);
    const restoreRunbookAuthoringProposal = vi.fn().mockResolvedValue({
      proposal: v3,
    });
    const agent = {
      listRunbookAuthoringProposals,
      restoreRunbookAuthoringProposal,
    } as unknown as AgentServicePort;

    renderRail({
      agent,
      messages: [{
        kind: "agent",
        toolCalls: [{
          toolCallId: "proposal-tool-v2",
          toolName: "propose_runbook_create",
          state: "done",
          output: JSON.stringify(v2),
        }],
      }],
    });

    expect((await screen.findAllByText("API triage v2")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText("Artifact version"));
    fireEvent.click(await screen.findByRole("option", { name: "v1" }));
    expect(await screen.findByText("API triage v1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() => {
      expect(restoreRunbookAuthoringProposal).toHaveBeenCalledWith({
        sessionId: undefined,
        incidentThreadId: INCIDENT_ID,
        proposalId: v1.proposalId,
      });
    });
    expect((await screen.findAllByText("API triage v3")).length).toBeGreaterThan(0);
  });

  it("keeps the selected artifact when another artifact is also latest", async () => {
    const proposal = (
      proposalId: string,
      artifactId: string,
      title: string,
    ): RunbookAuthoringProposalReview => ({
      proposalId,
      artifactId,
      artifactVersion: 1,
      isLatest: true,
      status: "pending_approval",
      approvalRequired: true,
      saved: false,
      supportsOperationApproval: false,
      kind: "create_new_runbook",
      incidentThreadId: INCIDENT_ID,
      proposedRunbook: {
        id: `${artifactId}-draft`,
        title,
        description: `${title} description`,
        revisionNumber: 0,
        actionCount: 1,
        actions: [{ id: `${artifactId}-action`, type: "shell", title: "Check status" }],
      },
      validation: { valid: true, errors: [], warnings: [] },
      operationDiffs: [{
        operationId: `${artifactId}-operation`,
        type: "create_runbook",
        rationale: `Create ${title}.`,
        riskLabels: [],
        before: null,
        after: {},
      }],
      nextStep: "Review the proposal.",
    });
    const alpha = proposal("proposal-alpha", "artifact-alpha", "Alpha runbook");
    const beta = proposal("proposal-beta", "artifact-beta", "Beta runbook");
    const agent = {
      listRunbookAuthoringProposals: vi.fn().mockResolvedValue([alpha, beta]),
    } as unknown as AgentServicePort;

    renderRail({ agent });

    expect(await screen.findByText("Alpha runbook")).toBeTruthy();
    fireEvent.click(artifactButtonWithText("Beta runbook"));

    await waitFor(() => {
      expect(detailPane().textContent).toContain("Beta runbook");
    });
  });

  it("sends selected operation ids for a create-kind revision", async () => {
    const proposal: RunbookAuthoringProposalReview = {
      proposalId: "proposal-create-revision",
      artifactId: "artifact-create-revision",
      artifactVersion: 2,
      parentProposalId: "proposal-create-v1",
      isLatest: true,
      status: "pending_approval",
      approvalRequired: true,
      saved: false,
      supportsOperationApproval: true,
      kind: "create_new_runbook",
      incidentThreadId: INCIDENT_ID,
      proposedRunbook: {
        id: "create-revision-draft",
        title: "Create revision",
        description: "A revised create proposal.",
        revisionNumber: 0,
        actionCount: 1,
        actions: [{ id: "status", type: "shell", title: "Check status" }],
      },
      validation: { valid: true, errors: [], warnings: [] },
      operationDiffs: [
        {
          operationId: "keep-operation",
          type: "update_metadata",
          rationale: "Keep the requested metadata.",
          riskLabels: [],
          before: null,
          after: {},
        },
        {
          operationId: "add-operation",
          type: "add_action",
          rationale: "Add the requested read-only check.",
          riskLabels: [],
          before: null,
          after: {},
        },
      ],
      nextStep: "Review the proposal.",
    };
    const approveRunbookAuthoringProposal = vi.fn().mockResolvedValue({
      proposal,
    });
    const agent = {
      listRunbookAuthoringProposals: vi.fn().mockResolvedValue([proposal]),
      approveRunbookAuthoringProposal,
    } as unknown as AgentServicePort;

    renderRail({ agent });

    const checkboxes = await screen.findAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    expect((checkboxes[0] as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(checkboxes[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(approveRunbookAuthoringProposal).toHaveBeenCalledWith({
        sessionId: undefined,
        incidentThreadId: INCIDENT_ID,
        proposalId: proposal.proposalId,
        approvedOperationIds: ["add-operation"],
      });
    });
  });

  it("renders validation warnings for a runbook proposal", async () => {
    const warning =
      'Warning: action "Removed check" was removed from the parent draft.';
    const proposal: RunbookAuthoringProposalReview = {
      proposalId: "proposal-with-warning",
      artifactId: "artifact-with-warning",
      artifactVersion: 2,
      parentProposalId: "proposal-with-warning-v1",
      isLatest: true,
      status: "pending_approval",
      approvalRequired: true,
      saved: false,
      supportsOperationApproval: false,
      kind: "create_new_runbook",
      incidentThreadId: INCIDENT_ID,
      proposedRunbook: {
        id: "warning-draft",
        title: "Warning runbook",
        description: "A runbook with a validation warning.",
        revisionNumber: 0,
        actionCount: 1,
        actions: [{ id: "kept", type: "shell", title: "Keep this check" }],
      },
      validation: { valid: true, errors: [], warnings: [warning] },
      operationDiffs: [{
        operationId: "remove-check",
        type: "delete_action",
        rationale: "Delete the removed check.",
        riskLabels: ["shell"],
        before: {},
        after: null,
      }],
      nextStep: "Review the proposal.",
    };
    const agent = {
      listRunbookAuthoringProposals: vi.fn().mockResolvedValue([proposal]),
    } as unknown as AgentServicePort;

    renderRail({ agent });

    expect(await screen.findByText("Warning runbook")).toBeTruthy();
    expect(await screen.findByText(warning)).toBeTruthy();
  });

  it("clears old proposals and ignores a stale refresh after an incident switch", async () => {
    let resolveFirst: ((proposals: RunbookAuthoringProposalReview[]) => void) | undefined;
    let resolveSecond: ((proposals: RunbookAuthoringProposalReview[]) => void) | undefined;
    const alpha: RunbookAuthoringProposalReview = {
      proposalId: "proposal-switch-alpha",
      artifactId: "artifact-switch-alpha",
      artifactVersion: 1,
      isLatest: true,
      status: "pending_approval",
      approvalRequired: true,
      saved: false,
      supportsOperationApproval: false,
      kind: "create_new_runbook",
      incidentThreadId: INCIDENT_ID,
      proposedRunbook: {
        id: "switch-alpha-draft",
        title: "Alpha incident runbook",
        description: "Alpha",
        revisionNumber: 0,
        actionCount: 0,
        actions: [],
      },
      validation: { valid: true, errors: [], warnings: [] },
      operationDiffs: [],
      nextStep: "Review the proposal.",
    };
    const beta = {
      ...alpha,
      proposalId: "proposal-switch-beta",
      artifactId: "artifact-switch-beta",
      incidentThreadId: OTHER_INCIDENT_ID,
      proposedRunbook: {
        ...alpha.proposedRunbook,
        id: "switch-beta-draft",
        title: "Beta incident runbook",
      },
    };
    const listRunbookAuthoringProposals = vi.fn(({ incidentThreadId }: { incidentThreadId?: string }) => {
      if (incidentThreadId === OTHER_INCIDENT_ID) {
        return new Promise<RunbookAuthoringProposalReview[]>((resolve) => {
          resolveSecond = resolve;
        });
      }
      return new Promise<RunbookAuthoringProposalReview[]>((resolve) => {
        resolveFirst = resolve;
      });
    });
    const agent = { listRunbookAuthoringProposals } as unknown as AgentServicePort;
    const rail = renderRail({ agent });

    await waitFor(() => {
      expect(listRunbookAuthoringProposals).toHaveBeenCalledWith({
        sessionId: undefined,
        incidentThreadId: INCIDENT_ID,
      });
    });
    rail.rerender(
      <BitsentryServicesProvider services={rail.services}>
        <IncidentArtifactsRail
          isOpen
          onClose={() => {}}
          messages={[]}
          incidentId={OTHER_INCIDENT_ID}
        />
      </BitsentryServicesProvider>,
    );
    await waitFor(() => {
      expect(listRunbookAuthoringProposals).toHaveBeenCalledWith({
        sessionId: undefined,
        incidentThreadId: OTHER_INCIDENT_ID,
      });
    });

    resolveSecond?.([beta]);
    expect(await screen.findByText("Beta incident runbook")).toBeTruthy();
    resolveFirst?.([alpha]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Alpha incident runbook")).toBeNull();
  });

  it("refreshes current incident results and selects a successful retry", async () => {
    const failedExecution = execution(
      ids.failedExecution,
      "failed",
      "old journalctl failure",
    );
    const successExecution = execution(
      ids.successExecution,
      "completed",
      "latest journalctl success",
    );

    writeStoredArtifacts(
      [storedResult(ids.failedResult, failedExecution)],
      { [failedExecution.executionId]: failedExecution },
    );

    renderRail();

    await waitFor(() => {
      expect(detailOutputText()).toContain("old journalctl failure");
    });
    expect(screen.queryByText("latest journalctl success")).toBeNull();

    writeStoredArtifacts(
      [
        storedResult(ids.successResult, successExecution),
        storedResult(ids.failedResult, failedExecution),
      ],
      {
        [successExecution.executionId]: successExecution,
        [failedExecution.executionId]: failedExecution,
      },
    );

    act(() => {
      window.dispatchEvent(new Event("bitsentry:results-updated"));
    });

    await waitFor(() => {
      expect(detailOutputText()).toContain("latest journalctl success");
    });
    expect(screen.getByText("2 runbook executions")).toBeTruthy();
  });

  it("does not show manual or other-incident results", async () => {
    const currentExecution = execution(
      ids.successExecution,
      "completed",
      "current chat output",
    );
    const manualExecution = execution(
      ids.manualExecution,
      "completed",
      "manual output should stay hidden",
      null,
    );
    const otherExecution = execution(
      ids.otherExecution,
      "completed",
      "other incident output should stay hidden",
      OTHER_INCIDENT_ID,
    );
    const manualResult = storedResult(ids.manualResult, manualExecution);
    delete manualResult.incidentThreadId;

    writeStoredArtifacts(
      [
        manualResult,
        storedResult(ids.otherResult, otherExecution, OTHER_INCIDENT_ID),
        storedResult(ids.successResult, currentExecution, INCIDENT_ID),
      ],
      {
        [manualExecution.executionId]: manualExecution,
        [otherExecution.executionId]: otherExecution,
        [currentExecution.executionId]: currentExecution,
      },
    );

    renderRail();

    await waitFor(() => {
      expect(detailOutputText()).toContain("current chat output");
    });
    expect(screen.queryByText("manual output should stay hidden")).toBeNull();
    expect(screen.queryByText("other incident output should stay hidden")).toBeNull();
    expect(screen.getByText("1 runbook execution")).toBeTruthy();
  });

  it("keeps multiple executions of the same runbook distinct within the same incident", async () => {
    const failedExecution = execution(
      ids.failedExecution,
      "failed",
      "first execution failed",
    );
    const successExecution = execution(
      ids.successExecution,
      "completed",
      "second execution completed",
    );

    writeStoredArtifacts(
      [
        storedResult(ids.successResult, successExecution),
        storedResult(ids.failedResult, failedExecution),
      ],
      {
        [successExecution.executionId]: successExecution,
        [failedExecution.executionId]: failedExecution,
      },
    );

    renderRail();

    await waitFor(() => {
      expect(
        screen.getByText("2 runbook executions"),
      ).toBeTruthy();
    });
    expect(screen.getAllByText("analyze server 227").length).toBeGreaterThanOrEqual(2);
  });

  it("shows the clicked execution details when switching between same-runbook cards", async () => {
    const failedExecution = execution(
      ids.failedExecution,
      "failed",
      "clicked failed execution",
    );
    const successExecution = execution(
      ids.successExecution,
      "completed",
      "clicked completed execution",
    );

    writeStoredArtifacts(
      [
        storedResult(ids.failedResult, failedExecution),
        storedResult(ids.successResult, successExecution),
      ],
      {
        [failedExecution.executionId]: failedExecution,
        [successExecution.executionId]: successExecution,
      },
    );

    renderRail();

    await waitFor(() => {
      expect(detailOutputText()).toContain("clicked failed execution");
    });

    fireEvent.click(artifactButtonWithText("Completed"));

    await waitFor(() => {
      expect(detailOutputText()).toContain("clicked completed execution");
    });
    expect(detailOutputText()).not.toContain("clicked failed execution");
  });

  it("renders plugin structured output in the Incident result details", async () => {
    const pluginExecution = execution(
      ids.successExecution,
      "completed",
      "Plugin completed",
      INCIDENT_ID,
      {
        type: "plugin",
        structuredOutput: {
          decisions: [
            {
              finding: { cve: "CVE-2026-1000" },
              reason: "vendor_fix_available",
              playbookDraft: { reviewRequired: true },
            },
            {
              finding: { cve: "CVE-2026-1001" },
              reason: "no_vendor_fix",
            },
          ],
        },
      },
    );

    writeStoredArtifacts(
      [storedResult(ids.successResult, pluginExecution)],
      { [pluginExecution.executionId]: pluginExecution },
    );

    renderRail();

    await waitFor(() => {
      expect(detailOutputText()).toContain("Plugin completed");
    });

    const rendered = detailPane().textContent ?? "";
    expect(rendered).toContain("structuredOutput");
    expect(rendered).toContain("CVE-2026-1000");
    expect(rendered).toContain("vendor_fix_available");
    expect(rendered).toContain("reviewRequired");
    expect(rendered).toContain("CVE-2026-1001");
    expect(rendered).toContain("no_vendor_fix");
    expect(rendered.indexOf("CVE-2026-1000")).toBeLessThan(
      rendered.indexOf("CVE-2026-1001"),
    );
  });
});

// Task 730: the rail used to ask the main process for the proposal list on every streamed update, which hit the IPC
// limit of 240 requests a minute. It now asks when something that can change the list happens.
describe("IncidentArtifactsRail proposal refresh while a reply streams", () => {
  type Messages = React.ComponentProps<typeof IncidentArtifactsRail>["messages"];
  type Rail = ReturnType<typeof renderRail>;

  function proposalReview(proposalId: string, artifactVersion: number, title: string): RunbookAuthoringProposalReview {
    return {
      proposalId,
      artifactId: "artifact-stream",
      artifactVersion,
      parentProposalId: artifactVersion === 1 ? undefined : "proposal-stream-v1",
      isLatest: true,
      status: "pending_approval",
      approvalRequired: true,
      saved: false,
      supportsOperationApproval: false,
      kind: "create_new_runbook",
      incidentThreadId: INCIDENT_ID,
      proposedRunbook: {
        id: "draft-stream",
        title,
        description: "Collect API health evidence.",
        revisionNumber: 1,
        actionCount: 1,
        actions: [{ id: "health", type: "http", title: "Check health" }],
      },
      validation: { valid: true, errors: [], warnings: [] },
      operationDiffs: [{
        operationId: "create-runbook",
        type: "create_runbook",
        rationale: "Create the runbook.",
        riskLabels: [],
        before: null,
        after: {},
      }],
      nextStep: "Review the proposal.",
    };
  }

  const proposalCall = (proposal: RunbookAuthoringProposalReview) => ({
    toolCallId: `tool-${proposal.proposalId}`,
    toolName: "propose_runbook_create",
    state: "done" as const,
    output: JSON.stringify(proposal),
  });
  const userMessage: Messages[number] = { kind: "user" };
  /** Every call returns a new list and a new message object, like each streamed update does. */
  const turn = (status: "thinking" | "streaming" | "done", toolCalls: Messages[number]["toolCalls"] = []): Messages => [
    userMessage,
    { kind: "agent", status, toolCalls: [...toolCalls] },
  ];

  function update(rail: Rail, messages: Messages, incidentId = INCIDENT_ID) {
    rail.rerender(
      <BitsentryServicesProvider services={rail.services}>
        <IncidentArtifactsRail isOpen onClose={() => {}} messages={messages} incidentId={incidentId} />
      </BitsentryServicesProvider>,
    );
  }
  const flush = () => act(async () => { await Promise.resolve(); });
  const agentWith = (listRunbookAuthoringProposals: ReturnType<typeof vi.fn>) =>
    ({ listRunbookAuthoringProposals } as unknown as AgentServicePort);

  it("asks once for a whole streamed reply, then again when the turn finishes, and shows the final proposals", async () => {
    const final = proposalReview("proposal-stream-v1", 1, "Streamed runbook");
    const list = vi.fn().mockResolvedValue([]);
    const rail = renderRail({ agent: agentWith(list), messages: turn("thinking") });
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(1); });
    expect(list).toHaveBeenCalledWith({ sessionId: undefined, incidentThreadId: INCIDENT_ID });

    // The measured flood was about 110 requests for one streamed reply. Many updates must add none.
    for (let delta = 0; delta < 300; delta += 1) update(rail, turn("streaming"));
    await flush();
    expect(list).toHaveBeenCalledTimes(1);

    list.mockResolvedValue([final]);
    update(rail, turn("done"));
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2); });
    expect((await screen.findAllByText("Streamed runbook")).length).toBeGreaterThan(0);

    // Later renders with the same finished messages stay quiet.
    update(rail, turn("done"));
    await flush();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("refreshes once when a proposal lands mid-stream and not again for the updates after it", async () => {
    const v1 = proposalReview("proposal-stream-v1", 1, "Mid-stream runbook");
    const list = vi.fn().mockResolvedValue([v1]);
    const rail = renderRail({ agent: agentWith(list), messages: turn("streaming") });
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(1); });

    update(rail, turn("streaming", [proposalCall(v1)]));
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2); });
    for (let delta = 0; delta < 200; delta += 1) update(rail, turn("streaming", [proposalCall(v1)]));
    await flush();
    expect(list).toHaveBeenCalledTimes(2);

    // A new version of the same artifact is a change; the turn ending is another.
    const v2 = proposalReview("proposal-stream-v2", 2, "Mid-stream runbook v2");
    update(rail, turn("streaming", [proposalCall(v1), proposalCall(v2)]));
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(3); });
    update(rail, turn("done", [proposalCall(v1), proposalCall(v2)]));
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(4); });
  });

  it("loads on open and on an incident change even while a reply is streaming", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const rail = renderRail({ agent: agentWith(list), messages: turn("streaming") });
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(1); });
    expect(list).toHaveBeenLastCalledWith({ sessionId: undefined, incidentThreadId: INCIDENT_ID });

    update(rail, turn("streaming"), OTHER_INCIDENT_ID);
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2); });
    expect(list).toHaveBeenLastCalledWith({ sessionId: undefined, incidentThreadId: OTHER_INCIDENT_ID });
    for (let delta = 0; delta < 100; delta += 1) update(rail, turn("streaming"), OTHER_INCIDENT_ID);
    await flush();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("still refreshes at once after a proposal action while a reply is streaming", async () => {
    const v1 = proposalReview("proposal-stream-v1", 1, "Action runbook v1");
    const v2 = { ...proposalReview("proposal-stream-v2", 2, "Action runbook v2"), isLatest: true };
    const v3 = { ...proposalReview("proposal-stream-v3", 3, "Action runbook v3"), restoredFromProposalId: v1.proposalId };
    const list = vi.fn().mockResolvedValueOnce([{ ...v1, isLatest: false }, v2]).mockResolvedValue([{ ...v1, isLatest: false }, { ...v2, isLatest: false }, v3]);
    const restore = vi.fn().mockResolvedValue({ proposal: v3 });
    const agent = { listRunbookAuthoringProposals: list, restoreRunbookAuthoringProposal: restore } as unknown as AgentServicePort;
    const rail = renderRail({ agent, messages: turn("streaming", [proposalCall(v2)]) });
    expect((await screen.findAllByText("Action runbook v2")).length).toBeGreaterThan(0);
    const before = list.mock.calls.length;
    for (let delta = 0; delta < 100; delta += 1) update(rail, turn("streaming", [proposalCall(v2)]));
    await flush();
    expect(list).toHaveBeenCalledTimes(before);

    fireEvent.click(screen.getByLabelText("Artifact version"));
    fireEvent.click(await screen.findByRole("option", { name: "v1" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => { expect(restore).toHaveBeenCalled(); });
    expect((await screen.findAllByText("Action runbook v3")).length).toBeGreaterThan(0);
    expect(list).toHaveBeenCalledTimes(before + 1);
  });

  it("never lets an older response overwrite a newer one when two refreshes overlap", async () => {
    const older = proposalReview("proposal-stream-old", 1, "Older response runbook");
    const newer = proposalReview("proposal-stream-new", 2, "Newer response runbook");
    const resolvers: Array<(proposals: RunbookAuthoringProposalReview[]) => void> = [];
    const list = vi.fn(() => new Promise<RunbookAuthoringProposalReview[]>((resolve) => { resolvers.push(resolve); }));
    const rail = renderRail({ agent: agentWith(list), messages: turn("streaming") });
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(1); });
    update(rail, turn("done"));
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2); });

    await act(async () => { resolvers[1]?.([newer]); });
    expect((await screen.findAllByText("Newer response runbook")).length).toBeGreaterThan(0);
    await act(async () => { resolvers[0]?.([older]); });
    expect(screen.queryByText("Older response runbook")).toBeNull();
    expect(screen.getAllByText("Newer response runbook").length).toBeGreaterThan(0);
  });
});
