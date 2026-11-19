// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemediationResumeChip, type ComposerRemediationFlow } from "@bitsentry-ce/components/chat/RemediationQuestionPanel";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
});

function flow(): ComposerRemediationFlow {
  return {
    open: false,
    close: vi.fn(),
    resume: vi.fn(),
    status: { tone: "neutral", label: "Needs input" },
    context: ["CVE-2026-1"],
    step: { index: 1, total: 3 },
    question: "Which SSH connection should run the fix?",
    options: [],
    select: vi.fn(),
    submitting: false,
  };
}

describe("the closed remediation row", () => {
  it("offers a green Resume and no blocked note while chat is available", () => {
    render(<RemediationResumeChip flow={flow()} disabled={false} />);
    const resume = screen.getByRole("button", { name: /common.incidents.remediation.resume/ });
    expect((resume as HTMLButtonElement).disabled).toBe(false);
    expect(resume.className).toContain("bg-primary");
    expect(screen.queryByText("common.incidents.remediation.resumeBlocked")).toBeNull();
  });

  it("says why Resume is unavailable and shows it as a neutral control while chat is blocked", () => {
    render(<RemediationResumeChip flow={flow()} disabled />);
    const resume = screen.getByRole("button", { name: /common.incidents.remediation.resume/ });
    expect((resume as HTMLButtonElement).disabled).toBe(true);
    expect(resume.className).not.toContain("bg-primary");
    expect(screen.getByText("common.incidents.remediation.resumeBlocked")).toBeTruthy();
    expect(screen.getByText("Which SSH connection should run the fix?")).toBeTruthy();
  });
});
