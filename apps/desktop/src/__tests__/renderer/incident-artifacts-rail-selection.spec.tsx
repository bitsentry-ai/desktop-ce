// @vitest-environment jsdom

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IncidentArtifactsRail, {
  countIncidentArtifacts,
} from "@bitsentry-ce/components/investigation/IncidentArtifactsRail";
import { BitsentryServicesProvider } from "@bitsentry-ce/components/services/context";
import type {
  BitsentryServicePorts,
  RunbookExecutionRecord,
} from "@bitsentry-ce/components/services/contracts";

const storage = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    clear: () => storage.clear(),
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  },
});

function getPluralTranslationKey(key: string, count: unknown): string {
  if (typeof count !== "number") {
    return key;
  }

  if (count === 1) {
    return `${key}_one`;
  }

  return `${key}_other`;
}

function formatTranslationValue(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  return "";
}

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Partial<Record<string, string>> = {
        "common.incidentArtifactsRail.actionType.llm": "LLM",
        "common.incidentArtifactsRail.runbookExecutionCount_one":
          "{{count}} runbook execution",
        "common.incidentArtifactsRail.runbookExecutionCount_other":
          "{{count}} runbook executions",
        "common.incidentArtifactsRail.status.completed": "Completed",
        "common.incidentArtifactsRail.stepStatus.completed": "Completed",
        "common.incidentArtifactsRail.stepsComplete":
          "{{completed}}/{{total}} steps complete",
      };
      const count = options?.count;
      const pluralKey = getPluralTranslationKey(key, count);
      const template = translations[pluralKey] ?? translations[key] ?? key;

      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        formatTranslationValue(options?.[name]),
      );
    },
  }),
}));

const execution: RunbookExecutionRecord = {
  executionId: "11111111-1111-4111-8111-111111111111",
  runbookId: "runbook-1",
  runbookTitle: "Retrieve errors from Jagad's Sentry",
  status: "completed",
  startedAt: "2026-05-26T01:00:00.000Z",
  completedAt: "2026-05-26T01:00:20.000Z",
  completionReason: "success",
  source: "agent",
  steps: [
    {
      actionId: "duplicated-action-id",
      order: 1,
      type: "external_source",
      title: "Retrieve errors from Sentry",
      status: "completed",
      output: "SERVER-292 last seen at 2026-05-26T00:59:00.000Z",
    },
    {
      actionId: "duplicated-action-id",
      order: 2,
      type: "llm",
      title: "Retrieve the errors and timestamps",
      status: "completed",
      input: {
        llmProviderKey: "codex",
        llmModel: "gpt-5.3-codex-spark",
      },
      metadata: {
        providerKey: "codex",
      },
      output: "Use 2026-05-26 00:55:00 UTC for backend log checks.",
    },
  ],
};

function rejectUnusedRunbookMethod(): Promise<never> {
  return Promise.reject(new Error("Unexpected runbook service call"));
}

function createRailServices(
  getExecution = vi.fn().mockResolvedValue(execution),
): BitsentryServicePorts {
  return {
    runbooks: {
      list: vi.fn().mockResolvedValue([]),
      get: rejectUnusedRunbookMethod,
      create: rejectUnusedRunbookMethod,
      updateMetadata: rejectUnusedRunbookMethod,
      updateActions: rejectUnusedRunbookMethod,
      saveAction: rejectUnusedRunbookMethod,
      deleteAction: rejectUnusedRunbookMethod,
      reorderActions: rejectUnusedRunbookMethod,
      delete: rejectUnusedRunbookMethod,
      exportContext: rejectUnusedRunbookMethod,
      exportRunbooks: rejectUnusedRunbookMethod,
      importRunbooks: rejectUnusedRunbookMethod,
      listTelemetryNeeds: vi.fn().mockResolvedValue([]),
      execute: rejectUnusedRunbookMethod,
      continueDiagnosis: rejectUnusedRunbookMethod,
      getExecution,
      listExecutions: vi.fn().mockResolvedValue({
        executions: [],
        total: 0,
        hasMore: false,
      }),
      listTelemetryActivity: vi.fn().mockResolvedValue({
        executions: [],
        total: 0,
        hasMore: false,
      }),
      getLinkedTelemetryExecution: vi.fn().mockResolvedValue(null),
      cancelExecution: rejectUnusedRunbookMethod,
      onExecutionEvent: vi.fn(() => () => {}),
    },
  };
}

function renderRail() {
  const services = createRailServices();

  return render(
    <BitsentryServicesProvider services={services}>
      <IncidentArtifactsRail
        isOpen
        onClose={() => {}}
        messages={[
          {
            kind: "agent",
            toolCalls: [
              {
                toolCallId: "call-1",
                toolName: "get_runbook_execution",
                state: "done",
                output: JSON.stringify(execution),
              },
            ],
          },
        ]}
      />
    </BitsentryServicesProvider>,
  );
}

beforeEach(() => {
  globalThis.localStorage?.clear?.();
});

afterEach(() => {
  cleanup();
  globalThis.localStorage?.clear?.();
});

describe("IncidentArtifactsRail step selection", () => {
  it("selects only the clicked step when execution steps share an action id", async () => {
    renderRail();

    let stepButtons: HTMLElement[] = [];
    await waitFor(() => {
      stepButtons = screen
        .getAllByRole("button")
        .filter((button) => button.hasAttribute("aria-pressed"));
      expect(stepButtons).toHaveLength(2);
    });

    const sentryStep = stepButtons.find((button) =>
      button.textContent.includes("Retrieve errors from Sentry"),
    );
    const timestampsStep = stepButtons.find((button) =>
      button.textContent.includes("Retrieve the errors and timestamps"),
    );

    if (sentryStep === undefined || timestampsStep === undefined) {
      throw new Error("Expected both runbook step buttons to render");
    }

    fireEvent.click(sentryStep);

    await waitFor(() => {
      expect(sentryStep.getAttribute("aria-pressed")).toBe("true");
      expect(timestampsStep.getAttribute("aria-pressed")).toBe("false");
      expect(
        stepButtons.filter(
          (button) => button.getAttribute("aria-pressed") === "true",
        ),
      ).toHaveLength(1);
    });
  });

  it("shows the selected llm provider, model, and output preview in the step list", async () => {
    renderRail();

    await waitFor(() => {
      expect(screen.getByText("Codex • gpt-5.3-codex-spark")).toBeTruthy();
      expect(
        screen.getAllByText(
          "Use 2026-05-26 00:55:00 UTC for backend log checks.",
        ).length,
      ).toBeGreaterThan(0);
    });
  });

  it("prefers the latest execution snapshot over a stale stored trace", async () => {
    localStorage.setItem(
      "bitsentry_results",
      JSON.stringify([
        {
          id: "result-1",
          executionId: execution.executionId,
          incidentThreadId: "incident-1",
          runbookId: execution.runbookId,
          runbookTitle: execution.runbookTitle,
          status: "completed",
          startedAt: execution.startedAt,
          completedAt: execution.completedAt,
        },
      ]),
    );
    localStorage.setItem(
      "bitsentry_result_traces",
      JSON.stringify({
        "result-1": {
          execution: {
            ...execution,
            status: "running",
            completedAt: undefined,
            steps: [
              execution.steps[0],
              {
                ...execution.steps[1],
                status: "running",
                completedAt: undefined,
                output: undefined,
              },
            ],
          },
        },
      }),
    );

    const services = createRailServices();

    render(
      <BitsentryServicesProvider services={services}>
        <IncidentArtifactsRail
          isOpen
          incidentId="incident-1"
          onClose={() => {}}
          messages={[]}
        />
      </BitsentryServicesProvider>,
    );

    await waitFor(() => {
      expect(screen.getAllByText("Completed").length).toBeGreaterThan(0);
      expect(screen.getByText("2/2 steps complete")).toBeTruthy();
      expect(screen.getByText("LLM • Completed")).toBeTruthy();
      expect(screen.queryByText("Running")).toBeNull();
    });
  });

  it("hydrates completed execution output when a tool result only contains a summary", async () => {
    const summarizedExecution = {
      executionId: execution.executionId,
      runbookId: execution.runbookId,
      runbookTitle: execution.runbookTitle,
      status: execution.status,
      startedAt: execution.startedAt,
      steps: execution.steps.map((step) => ({
        order: step.order,
        title: step.title,
        type: step.type,
        status: step.status,
        outputExcerpt: "Summary only",
      })),
    };
    const getExecution = vi.fn().mockResolvedValue(execution);

    render(
      <BitsentryServicesProvider services={createRailServices(getExecution)}>
        <IncidentArtifactsRail
          isOpen
          onClose={() => {}}
          messages={[
            {
              kind: "agent",
              toolCalls: [
                {
                  toolCallId: "call-summary-only",
                  toolName: "get_runbook_execution",
                  state: "done",
                  output: JSON.stringify(summarizedExecution),
                },
              ],
            },
          ]}
        />
      </BitsentryServicesProvider>,
    );

    await waitFor(() => {
      expect(getExecution).toHaveBeenCalledWith(execution.executionId);
      expect(
        screen.getAllByText(
          "Use 2026-05-26 00:55:00 UTC for backend log checks.",
        ).length,
      ).toBeGreaterThan(0);
    });
  });

  it("keeps started and failed executions visible as Results rail artifacts", async () => {
    const startedExecution: RunbookExecutionRecord = {
      ...execution,
      executionId: "22222222-2222-4222-8222-222222222222",
      runbookId: "runbook-started",
      runbookTitle: "Started PostHog Check",
      status: "running",
      completedAt: undefined,
      completionReason: undefined,
      steps: [],
    };
    const failedExecution: RunbookExecutionRecord = {
      ...execution,
      executionId: "33333333-3333-4333-8333-333333333333",
      runbookId: "runbook-failed",
      runbookTitle: "Failed PostHog Check",
      status: "failed",
      completionReason: "failed",
      steps: [
        {
          actionId: "failed-step",
          order: 1,
          type: "external_source",
          title: "PostHog Sandbox API Error Check",
          status: "failed",
          error: "PostHog API returned 403.",
        },
      ],
    };
    const getExecution = vi.fn().mockImplementation((executionId: string) => {
      if (executionId === startedExecution.executionId) {
        return Promise.resolve(startedExecution);
      }

      return Promise.resolve(failedExecution);
    });
    const messages = [
      {
        kind: "agent" as const,
        toolCalls: [
          {
            toolCallId: "call-started",
            toolName: "execute_runbook",
            state: "done" as const,
            input: { runbookId: startedExecution.runbookId },
            output: JSON.stringify({
              executionId: startedExecution.executionId,
              runbookId: startedExecution.runbookId,
              runbookTitle: startedExecution.runbookTitle,
              status: startedExecution.status,
            }),
          },
          {
            toolCallId: "call-failed",
            toolName: "execute_runbook",
            state: "done" as const,
            input: { runbookId: failedExecution.runbookId },
            output: JSON.stringify({
              executionId: failedExecution.executionId,
              runbookId: failedExecution.runbookId,
              runbookTitle: failedExecution.runbookTitle,
              status: failedExecution.status,
              error: "PostHog API returned 403.",
            }),
          },
        ],
      },
    ];

    expect(countIncidentArtifacts(messages)).toBe(2);

    render(
      <BitsentryServicesProvider services={createRailServices(getExecution)}>
        <IncidentArtifactsRail isOpen onClose={() => {}} messages={messages} />
      </BitsentryServicesProvider>,
    );

    await waitFor(() => {
      expect(getExecution).toHaveBeenCalledWith(startedExecution.executionId);
      expect(getExecution).toHaveBeenCalledWith(failedExecution.executionId);
      expect(screen.getAllByText("PostHog API returned 403.").length).toBeGreaterThan(0);
    });
  });

  it("collapses duplicate incident retries down to the latest runbook identities", async () => {
    localStorage.setItem(
      "bitsentry_results",
      JSON.stringify([
        {
          id: "result-sentry-1",
          incidentThreadId: "incident-dup",
          runbookId: "runbook-sentry",
          runbookTitle: "Retrieve errors from Jagad's Sentry",
          status: "completed",
          startedAt: "2026-05-26T01:00:00.000Z",
          completedAt: "2026-05-26T01:00:20.000Z",
        },
        {
          id: "result-logs-1",
          incidentThreadId: "incident-dup",
          runbookId: "runbook-logs",
          runbookTitle: "Check Logs in the Jagad backend server",
          status: "completed",
          startedAt: "2026-05-26T01:01:00.000Z",
          completedAt: "2026-05-26T01:01:20.000Z",
        },
        {
          id: "result-sentry-2",
          incidentThreadId: "incident-dup",
          runbookId: "runbook-sentry",
          runbookTitle: "Retrieve errors from Jagad's Sentry",
          status: "completed",
          startedAt: "2026-05-26T01:02:00.000Z",
          completedAt: "2026-05-26T01:02:20.000Z",
        },
        {
          id: "result-logs-2",
          incidentThreadId: "incident-dup",
          runbookId: "runbook-logs",
          runbookTitle: "Check Logs in the Jagad backend server",
          status: "completed",
          startedAt: "2026-05-26T01:03:00.000Z",
          completedAt: "2026-05-26T01:03:20.000Z",
        },
      ]),
    );

    expect(countIncidentArtifacts([], "incident-dup")).toBe(2);

    const services = createRailServices(vi.fn());

    render(
      <BitsentryServicesProvider services={services}>
        <IncidentArtifactsRail
          isOpen
          incidentId="incident-dup"
          onClose={() => {}}
          messages={[]}
        />
      </BitsentryServicesProvider>,
    );

    await waitFor(() => {
      const rail = document.querySelector('[data-tour="incidents-artifacts-rail"]');
      const artifactList = document.querySelector(
        '[data-tour="incidents-artifacts-list"] .space-y-2',
      );

      if (rail === null || artifactList === null) {
        throw new Error("Expected incident artifacts rail and list to render");
      }

      const railText = rail.textContent.replace(/\s+/g, " ");
      expect(railText).toContain("2 runbook executions");
      expect(artifactList.children).toHaveLength(2);
    });
  });
});
