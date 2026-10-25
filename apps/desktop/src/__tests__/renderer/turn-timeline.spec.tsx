// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveTurnTimeline } from "@bitsentry-ce/components/chat/turnTimelineRows";
import { summarizeToolGroup } from "@bitsentry-ce/components/chat/toolPresentation";
import { TurnTimeline } from "@bitsentry-ce/components/chat/TurnTimeline";
import type { ChatMessage, ToolCallCard } from "@bitsentry-ce/components/chat/types";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values === undefined ? key : `${key}(${Object.values(values).join(",")})`,
  }),
}));

afterEach(() => {
  cleanup();
});

type AgentMessage = Extract<ChatMessage, { kind: "agent" }>;

const at = (second: number) => `2026-10-19T10:00:${String(second).padStart(2, "0")}.000Z`;

function tool(id: string, name: string, startedAt: number, extra: Partial<ToolCallCard> = {}): ToolCallCard {
  return { toolCallId: id, toolName: name, state: "done", startedAt: at(startedAt), completedAt: at(startedAt + 1), ...extra };
}

function agentMessage(overrides: Partial<AgentMessage>): AgentMessage {
  return { kind: "agent", iterations: [], activeIterationId: null, toolCalls: [], finalText: null, status: "done", ...overrides };
}

const directApiTurn = agentMessage({
  iterations: [
    { id: "i1", startedAt: at(0), completedAt: at(4), text: "Checking the runbooks first.", streamDeltas: [{ timestamp: at(1), text: "Checking" }], toolCallIds: ["t1", "t2"], status: "done" },
    { id: "i2", startedAt: at(5), completedAt: at(9), text: "nginx is out of workers.", streamDeltas: [{ timestamp: at(6), text: "nginx" }], toolCallIds: [], status: "done" },
  ],
  toolCalls: [tool("t1", "list_runbooks", 2), tool("t2", "execute_runbook", 3, { input: { runbookTitle: "Check nginx" } })],
  finalText: "nginx is out of workers.",
});

describe("turn timeline", () => {
  it("shows a running turn in the order things happened", () => {
    const timeline = deriveTurnTimeline({ ...directApiTurn, status: "streaming" });

    expect(timeline.foldedRows).toEqual([]);
    expect(timeline.rows.map((row) => row.kind)).toEqual(["text", "tool-group", "text"]);
  });

  it("puts a coding agent's tool calls before the answer it streams at the end", () => {
    const timeline = deriveTurnTimeline(agentMessage({
      status: "streaming",
      iterations: [{ id: "i1", startedAt: at(0), text: "Found the cause.", toolCallIds: ["t1"], status: "streaming" }],
      toolCalls: [tool("t1", "mcp__bitsentry__ssh_journal_query", 1, { state: "running" })],
    }));

    expect(timeline.rows.map((row) => row.kind)).toEqual(["tool", "text"]);
  });

  it("folds a finished turn's work behind the answer", () => {
    const timeline = deriveTurnTimeline(directApiTurn);

    expect(timeline.rows).toEqual([expect.objectContaining({ kind: "text", text: "nginx is out of workers." })]);
    expect(timeline.foldedRows.map((row) => row.kind)).toEqual(["text", "tool-group"]);
    expect(timeline.workedMs).toBe(9_000);
  });

  it("keeps a failed turn and a turn without tools unfolded", () => {
    expect(deriveTurnTimeline({ ...directApiTurn, status: "error" }).foldedRows).toEqual([]);
    expect(deriveTurnTimeline(agentMessage({ finalText: "Hello." })).rows).toEqual([
      expect.objectContaining({ kind: "text", text: "Hello." }),
    ]);
  });

  it("summarizes a group by its most frequent kinds", () => {
    const t = (key: string, values?: Record<string, unknown>) => `${key}(${Object.values(values ?? {}).join(",")})`;
    const summary = summarizeToolGroup(
      [tool("a", "execute_runbook", 1), tool("b", "mcp__bitsentry__execute_runbook", 2), tool("c", "ssh_journal_query", 3), tool("d", "list_runbooks", 4)],
      t,
    );

    expect(summary).toBe(
      "common.chat.tools.joinMore(common.chat.tools.runbook.group(2),common.chat.tools.logs.group(1),1)",
    );
  });
});

describe("TurnTimeline", () => {
  it("opens the fold, then a tool group, then one call's details", () => {
    render(<TurnTimeline msg={directApiTurn} nowMs={Date.parse(at(10))} />);

    expect(screen.getByText("nginx is out of workers.")).toBeTruthy();
    expect(screen.queryByText("Checking the runbooks first.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /common.chat.tools.workedFor/ }));
    expect(screen.getByText("Checking the runbooks first.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /common.chat.tools.joinTwo/ }));
    fireEvent.click(screen.getByText("Check nginx"));
    expect(screen.getByText(/"runbookTitle": "Check nginx"/)).toBeTruthy();
  });

  it("shows a tool's latest progress only while it runs", () => {
    const progress = "Checked 12 of 40 findings, 28 remaining";
    const turn = (state: ToolCallCard["state"]) => agentMessage({
      status: "streaming",
      iterations: [{ id: "i1", startedAt: at(0), text: "", toolCallIds: ["t1"], status: "streaming" }],
      toolCalls: [tool("t1", "evaluate_remediation", 1, { state, progress })],
    });

    const { rerender } = render(<TurnTimeline msg={turn("running")} nowMs={Date.parse(at(10))} />);
    expect(screen.getByText(progress)).toBeTruthy();

    rerender(<TurnTimeline msg={turn("done")} nowMs={Date.parse(at(10))} />);
    expect(screen.queryByText(progress)).toBeNull();
  });

  it("explains a failed host tool with its sentence and field issues", () => {
    const error = JSON.stringify({
      code: "invalid_input",
      message: "The runbook draft is missing a plugin.",
      issues: [{ path: "operations.0.action.pluginId", message: "Required" }],
    });
    const turn = agentMessage({
      status: "streaming",
      iterations: [{ id: "i1", startedAt: at(0), text: "", toolCallIds: ["t1"], status: "streaming" }],
      toolCalls: [tool("t1", "propose_runbook", 1, { state: "failed", error })],
    });

    render(<TurnTimeline msg={turn} nowMs={Date.parse(at(10))} />);
    fireEvent.click(screen.getByRole("button", { name: /common.chat.tools/ }));

    expect(screen.getByText("The runbook draft is missing a plugin.")).toBeTruthy();
    expect(screen.getByText("operations.0.action.pluginId")).toBeTruthy();
    expect(screen.getByText("Required")).toBeTruthy();
  });
});
