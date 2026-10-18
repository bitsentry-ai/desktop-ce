// @vitest-environment jsdom

import React, { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "@bitsentry-ce/components/chat/Composer";
import type { ComposerRemediationFlow } from "@bitsentry-ce/components/chat/RemediationQuestionPanel";
import type { ComposerCustomerReportIntake } from "@bitsentry-ce/components/chat/useCustomerReportIntake";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

const K = "common.incidents.remediation";

/** What a step shows, given the controls the host page gives it. */
type Step = (page: { next: () => void; selected: number | undefined; text: string; setText: (text: string) => void }) => Partial<ComposerRemediationFlow>;

/** A host page with its own steps: the primary button moves to the next step, as the Dashboard's flow does. */
function Page({ steps, finished = false, processing = false, intake }: { steps: Step[]; finished?: boolean; processing?: boolean; intake?: ComposerCustomerReportIntake }) {
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [text, setText] = useState("");
  const next = () => { setIndex((value) => value + 1); setSelected(undefined); setText(""); };
  const flow: ComposerRemediationFlow = {
    open,
    close: () => { setOpen(false); },
    resume: () => { setOpen(true); },
    status: { tone: "need", label: "Needs input" },
    finished,
    summary: "1 candidate · 0 actions",
    context: ["CVE-2026-66485", "cpio 2.15+dfsg-1ubuntu2 → 2.15+dfsg-1ubuntu2.1"],
    options: [],
    selected,
    select: setSelected,
    submitting: false,
    ...steps[index]({ next, selected, text, setText }),
  };
  return (
    <Composer
      prompt=""
      onPromptChange={vi.fn()}
      onSend={vi.fn()}
      onCancel={vi.fn()}
      isProcessing={processing}
      isBlocked={false}
      isArchived={false}
      composerImages={[]}
      onRemoveImage={vi.fn()}
      onPickImages={vi.fn()}
      onPickFiles={vi.fn()}
      onImageFilesSelected={vi.fn()}
      onPaste={vi.fn()}
      imageInputRef={React.createRef<HTMLInputElement>()}
      fileInputRef={React.createRef<HTMLInputElement>()}
      selectedProviderKey={null}
      selectedModelId=""
      onSelectProvider={vi.fn()}
      onSelectModel={vi.fn()}
      configuredProviderKeys={[]}
      providerConfigs={{}}
      selectedModelCapability={undefined}
      thinkingEnabled={false}
      onThinkingToggle={vi.fn()}
      customerReportIntake={intake}
      remediationFlow={flow}
    />
  );
}

const connectionStep: Step = ({ next, selected }) => ({
  step: { index: 1, total: 3 },
  question: "Which SSH connection should run the fix?",
  options: [
    { label: "Bitsentry Biznet Gio", hint: "ubuntu@103.89.5.97", icon: "server" },
    { label: "Sandbox Worker", hint: "dev@129.212.227.169", icon: "server" },
    { label: "New SSH connection", icon: "plus" },
  ],
  primary: { label: "Next", disabled: selected === undefined, run: next },
});

const hostnameStep: Step = ({ next, selected, text, setText }) => ({
  step: { index: 2, total: 3 },
  question: "Which hostname must the server report before the fix runs?",
  options: [{ label: "bitsentry-sandbox", hint: "Wazuh agent 003", icon: "host" }],
  input: { value: text, placeholder: "Expected hostname", onChange: setText },
  back: vi.fn(),
  primary: { label: "Next", disabled: selected === undefined && text.trim() === "", run: next },
});

// Edit leads to the next step here, so the test sees where it goes.
const reviewStep: Step = ({ next }) => ({
  step: { index: 3, total: 3 },
  question: "Create the approval request?",
  rows: [
    { label: "SSH connection", value: "Sandbox Worker", detail: "dev@129.212.227.169", edit: next },
    { label: "Expected hostname", value: "bitsentry-sandbox" },
  ],
  primary: { label: "Create approval request", run: next },
});

const approvalStep: Step = ({ next, selected }) => ({
  status: { tone: "wait", label: "Pending approval" },
  question: "Approve this remediation?",
  options: [
    { label: "Approve", hint: "Runs on dev@129.212.227.169 after the hostname check", icon: "approve" },
    { label: "Reject", icon: "reject", danger: true },
  ],
  details: [{ label: "Rollback command", text: "apt-get install -y --allow-downgrades 'cpio=2.15+dfsg-1ubuntu2'" }],
  primary: { label: selected === 1 ? "Reject" : "Approve", danger: selected === 1, disabled: selected === undefined, run: next },
});

const runningStep: Step = () => ({ status: { tone: "run", label: "Running" }, running: "Applying the fix on dev@129.212.227.169" });

const doneStep: Step = () => ({
  status: { tone: "ok", label: "Verified" },
  result: { tone: "ok", title: "cpio 2.15+dfsg-1ubuntu2.1 installed", detail: "bitsentry-sandbox · dev@129.212.227.169" },
  primary: { label: "Done", run: vi.fn() },
});

const failedStep: Step = () => ({
  status: { tone: "bad", label: "Outcome unknown" },
  question: "The fix did not finish",
  notice: "Verify this host by hand before creating another attempt.",
  error: "Connection closed",
  secondary: { label: "Close", run: vi.fn() },
  primary: { label: "Create next attempt", run: vi.fn() },
});

const card = () => screen.getByRole("region", { name: `${K}.title` });
const option = (name: RegExp) => screen.getByRole("button", { name, pressed: false });
const pressed = () => screen.queryAllByRole("button", { pressed: true }).map((element) => element.textContent);

describe("CVE remediation in the composer", () => {
  it("number keys pick an option and Enter goes to the next step", () => {
    render(<Page steps={[connectionStep, hostnameStep]} />);

    expect(within(card()).getByText("1/3")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document.body, { key: "2" });
    expect(pressed()).toEqual(["Sandbox Workerdev@129.212.227.169"]);
    fireEvent.keyDown(document.body, { key: "Enter" });

    expect(screen.getByText("Which hostname must the server report before the fix runs?")).toBeTruthy();
    expect(within(card()).getByText("2/3")).toBeTruthy();
  });

  it("keeps typed digits in the text area and sends the typed answer with Enter", () => {
    render(<Page steps={[hostnameStep, reviewStep]} />);
    const field = screen.getByPlaceholderText("Expected hostname");

    fireEvent.keyDown(field, { key: "1" });
    fireEvent.change(field, { target: { value: "vps-948ecff0" } });
    expect(pressed()).toEqual([]);
    fireEvent.keyDown(field, { key: "Enter" });

    expect(screen.getByText("Create the approval request?")).toBeTruthy();
  });

  it("hides the text area on steps without typed input", () => {
    render(<Page steps={[approvalStep]} />);

    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(option(/^Reject/));
    expect(screen.getByRole("button", { name: "Reject", pressed: true })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(2);
    fireEvent.click(screen.getByText("Rollback command"));
    expect(screen.getByText("apt-get install -y --allow-downgrades 'cpio=2.15+dfsg-1ubuntu2'")).toBeTruthy();
  });

  it("shows the review rows with Edit links to the step that sets them", () => {
    render(<Page steps={[reviewStep, connectionStep]} />);

    expect(within(card()).getByText("Sandbox Worker")).toBeTruthy();
    expect(screen.queryByRole("button", { name: `${K}.edit Expected hostname` })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: `${K}.edit SSH connection` }));
    expect(screen.getByText("Which SSH connection should run the fix?")).toBeTruthy();
  });

  it("shows the running state without a button to press", () => {
    render(<Page steps={[runningStep]} />);

    expect(within(card()).getByRole("status").textContent).toBe("Applying the fix on dev@129.212.227.169");
    expect(within(card()).getByText("Running")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });

  it("shows the result of a finished fix", () => {
    render(<Page steps={[doneStep]} />);

    expect(screen.getByText("cpio 2.15+dfsg-1ubuntu2.1 installed")).toBeTruthy();
    expect(screen.getByText("bitsentry-sandbox · dev@129.212.227.169")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("shows why a fix did not finish and offers the next attempt", () => {
    render(<Page steps={[failedStep]} />);

    expect(screen.getByRole("alert").textContent).toBe("Connection closed");
    expect(screen.getByText("Verify this host by hand before creating another attempt.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create next attempt" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("Escape closes the card and Resume opens it again at the same step", () => {
    render(<Page steps={[connectionStep]} />);
    fireEvent.keyDown(document.body, { key: "2" });

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("region", { name: `${K}.title` })).toBeNull();
    expect(screen.getByPlaceholderText("common.incidents.describeTheSecurityIssueTo")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: new RegExp(`${K}.resume`) }));
    expect(screen.getByText("Which SSH connection should run the fix?")).toBeTruthy();
    expect(pressed()).toEqual(["Sandbox Workerdev@129.212.227.169"]);
  });

  it("closes from the close button and offers View when nothing is left to do", () => {
    render(<Page steps={[doneStep]} finished />);

    fireEvent.click(screen.getByRole("button", { name: `${K}.close` }));

    const chip = screen.getByRole("button", { name: new RegExp(`${K}.view`) });
    expect(chip.textContent).toContain("Verified");
  });

  it("waits while the agent works", () => {
    render(<Page steps={[connectionStep]} processing />);

    expect(screen.queryByRole("region", { name: `${K}.title` })).toBeNull();
    expect((screen.getByRole("button", { name: new RegExp(`${K}.resume`) }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an open customer report question first", () => {
    const intake: ComposerCustomerReportIntake = {
      question: { key: "origin", title: "Is this a message from a customer?", options: [{ label: "Yes", value: true }], multiline: false },
      editing: false,
      selected: undefined,
      select: vi.fn(),
      answerText: "",
      setAnswerText: vi.fn(),
      error: null,
      submitting: false,
      canSubmit: false,
      submit: vi.fn(),
      dismiss: vi.fn(),
    } as unknown as ComposerCustomerReportIntake;
    render(<Page steps={[connectionStep]} intake={intake} />);

    expect(screen.getByText("Is this a message from a customer?")).toBeTruthy();
    expect(screen.queryByRole("region", { name: `${K}.title` })).toBeNull();
    expect(screen.queryByRole("button", { name: new RegExp(`${K}.resume`) })).toBeNull();
  });
});
