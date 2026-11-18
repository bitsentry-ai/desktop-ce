// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeRunOutcome,
  formatRunDuration,
  runDurationMs,
  type RunOutcomeInput,
} from "@bitsentry-ce/components/runbook/runOutcome";
import { RunOutcomeLine } from "@bitsentry-ce/components/runbook/RunOutcomeLine";
import {
  RESULTS_STEP_TITLE_CLASS,
  resultsStepCardClass,
  resultsStepStatusClass,
} from "@bitsentry-ce/components/runbook/resultsStepStyles";

const messages: Record<string, string> = {
  "common.results.outcomeCompleted": "Completed {{completed}} of {{count}} steps in {{duration}}",
  "common.results.outcomeCompletedSteps": "Completed {{completed}} of {{count}} steps",
  "common.results.outcomeFailedAt": "Failed at step {{position}} of {{total}}: {{title}}",
  "common.results.outcomeFailedAtUntitled": "Failed at step {{position}} of {{total}}",
  "common.results.outcomeFailed": "Failed after {{completed}} of {{count}} steps",
  "common.results.outcomeCancelled": "Cancelled after {{completed}} of {{count}} steps",
  "common.results.outcomeInterrupted": "Interrupted after {{completed}} of {{count}} steps",
  "common.results.outcomeRunning": "Running: {{completed}} of {{count}} steps done",
  "common.results.outcomeWaiting": "Waiting to start",
  "common.results.durationSeconds": "{{value}} s",
  "common.results.durationMinutes": "{{minutes}} min {{seconds}} s",
  "common.results.durationHours": "{{hours}} h {{minutes}} min",
};

function t(key: string, options: Record<string, unknown> = {}) {
  const template = messages[key] ?? key;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name]));
}

const STEPS = [
  { status: "completed", title: "Uptime" },
  { status: "failed", title: "Disk usage" },
  { status: "pending", title: "Memory" },
];

function input(overrides: Partial<RunOutcomeInput>): RunOutcomeInput {
  return {
    status: "completed",
    steps: STEPS,
    completedSteps: 3,
    totalSteps: 3,
    startedAt: "2026-11-17T10:00:00.000Z",
    completedAt: "2026-11-17T10:00:00.600Z",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("formatRunDuration", () => {
  it("keeps a decimal under ten seconds and rolls up into minutes and hours", () => {
    expect(formatRunDuration(600, t)).toBe("0.6 s");
    expect(formatRunDuration(42_400, t)).toBe("42 s");
    expect(formatRunDuration(185_000, t)).toBe("3 min 5 s");
    expect(formatRunDuration(4_320_000, t)).toBe("1 h 12 min");
  });

  it("ignores missing or inverted timestamps", () => {
    expect(runDurationMs(undefined, "2026-11-17T10:00:00Z")).toBeNull();
    expect(runDurationMs("2026-11-17T10:00:01Z", "2026-11-17T10:00:00Z")).toBeNull();
    expect(runDurationMs("nope", "2026-11-17T10:00:00Z")).toBeNull();
  });
});

describe("describeRunOutcome", () => {
  it("reports a completed run with its duration", () => {
    expect(describeRunOutcome(input({}), t)).toEqual({
      text: "Completed 3 of 3 steps in 0.6 s",
      tone: "success",
    });
    expect(describeRunOutcome(input({ completedAt: undefined }), t).text).toBe(
      "Completed 3 of 3 steps",
    );
  });

  it("names the step a failed run stopped at", () => {
    expect(describeRunOutcome(input({ status: "failed", completedSteps: 1 }), t)).toEqual({
      text: "Failed at step 2 of 3: Disk usage",
      tone: "danger",
    });
    const untitled = STEPS.map((step) => ({ ...step, title: "" }));
    expect(
      describeRunOutcome(input({ status: "failed", steps: untitled, completedSteps: 1 }), t).text,
    ).toBe("Failed at step 2 of 3");
    expect(
      describeRunOutcome(input({ status: "failed", steps: null, completedSteps: 1 }), t).text,
    ).toBe("Failed after 1 of 3 steps");
  });

  it("describes runs that are waiting, running, cancelled or interrupted", () => {
    expect(describeRunOutcome(input({ status: "queued" }), t).text).toBe("Waiting to start");
    expect(describeRunOutcome(input({ status: "running", completedSteps: 1 }), t).text).toBe(
      "Running: 1 of 3 steps done",
    );
    expect(describeRunOutcome(input({ status: "cancelled", completedSteps: 2 }), t)).toEqual({
      text: "Cancelled after 2 of 3 steps",
      tone: "warning",
    });
    expect(describeRunOutcome(input({ status: "claim_expired", completedSteps: 0 }), t).text).toBe(
      "Interrupted after 0 of 3 steps",
    );
  });
});

describe("RunOutcomeLine", () => {
  it("renders the outcome text with its tone", () => {
    render(<RunOutcomeLine outcome={{ text: "Completed 3 of 3 steps in 0.6 s", tone: "success" }} />);
    const line = screen.getByText("Completed 3 of 3 steps in 0.6 s").closest("p");
    expect(line?.getAttribute("data-tone")).toBe("success");
    expect(line?.className).toContain("text-foreground");
  });
});

describe("results step card styles", () => {
  it("marks selection with a neutral surface and a brand bar, not success green", () => {
    const selected = resultsStepCardClass(true);
    expect(selected).toContain("bg-[hsl(var(--selection))]");
    expect(selected).toContain("before:bg-[hsl(var(--brand-emphasis))]");
    expect(selected).toContain("before:inset-y-2.5");
    expect(selected).not.toContain("before:inset-y-1.5");
    expect(selected).not.toContain("primary");
    expect(selected).not.toContain("success");
    expect(resultsStepCardClass(false)).not.toContain("brand-emphasis");
  });

  it("keeps success colour for the completed status and clamps titles to two lines", () => {
    expect(resultsStepStatusClass("completed")).toContain("success");
    expect(resultsStepStatusClass("pending")).toBe("text-muted-foreground");
    expect(RESULTS_STEP_TITLE_CLASS).toContain("line-clamp-2");
  });
});
