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
} = {}) {
  const services: BitsentryServicePorts = {
    runbooks: createRunbookServices(),
    agent: options.agent,
  };

  render(
    <BitsentryServicesProvider services={services}>
      <IncidentArtifactsRail
        isOpen
        onClose={() => {}}
        messages={options.messages ?? []}
        incidentId={INCIDENT_ID}
      />
    </BitsentryServicesProvider>,
  );

  return services;
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
    fireEvent.change(screen.getByLabelText("Artifact version"), {
      target: { value: v1.proposalId },
    });
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
