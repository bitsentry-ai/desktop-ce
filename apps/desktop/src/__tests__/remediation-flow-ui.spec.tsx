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
function Page({ steps, processing = false, intake }: { steps: Step[]; processing?: boolean; intake?: ComposerCustomerReportIntake }) {
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [text, setText] = useState("");
  const next = () => { setIndex((value) => value + 1); setSelected(undefined); setText(""); };
  const flow: ComposerRemediationFlow = {
    open,
    close: () => { setOpen(false); },
    resume: () => { setOpen(true); },
    status: { tone: "neutral", label: "Needs input" },
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
    { label: "Bitsentry Biznet Gio", hint: "ubuntu@103.89.5.97" },
    { label: "Sandbox Worker", hint: "dev@129.212.227.169" },
    { label: "New SSH connection" },
  ],
  primary: { label: "Next", disabled: selected === undefined, run: next },
});

const hostnameStep: Step = ({ next, selected, text, setText }) => ({
  step: { index: 2, total: 3 },
  question: "Which hostname must the server report before the fix runs?",
  options: [{ label: "bitsentry-sandbox", hint: "Wazuh agent 003" }],
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
  status: { tone: "neutral", label: "Pending approval" },
  question: "Approve this remediation?",
  options: [
    { label: "Approve", hint: "Runs on dev@129.212.227.169:22 after the hostname check for bitsentry-sandbox" },
    { label: "Reject", hint: "Closes this request. Nothing runs." },
  ],
  details: [{ label: "Rollback command", text: "apt-get install -y --allow-downgrades 'cpio=2.15+dfsg-1ubuntu2'" }],
  primary: { label: selected === 1 ? "Reject" : "Approve", danger: selected === 1, disabled: selected === undefined, run: next },
});

const runningStep: Step = () => ({ status: { tone: "neutral", label: "Running" }, running: "Applying the fix on dev@129.212.227.169" });

const doneStep: Step = () => ({
  status: { tone: "success", label: "Verified" },
  result: { tone: "success", title: "cpio 2.15+dfsg-1ubuntu2.1 installed", detail: "bitsentry-sandbox · dev@129.212.227.169" },
  primary: { label: "Done", run: vi.fn() },
});

const failedStep: Step = () => ({
  status: { tone: "destructive", label: "Outcome unknown" },
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
    expect(pressed()).toEqual(["RejectCloses this request. Nothing runs."]);
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
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

  it("closes from the close button and shows the status on the resume chip", () => {
    render(<Page steps={[approvalStep]} />);

    fireEvent.click(screen.getByRole("button", { name: `${K}.close` }));

    const chip = screen.getByRole("button", { name: new RegExp(`${K}.resume`) });
    expect(chip.textContent).toBe(`${K}.titlePending approval${K}.resume`);
  });

  it("waits while the agent works", () => {
    render(<Page steps={[connectionStep]} processing />);

    expect(screen.queryByRole("region", { name: `${K}.title` })).toBeNull();
    expect((screen.getByRole("button", { name: new RegExp(`${K}.resume`) }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an open customer report question first", () => {
    render(<Page steps={[connectionStep]} intake={intake()} />);

    expect(screen.getByText("Is this a message from a customer?")).toBeTruthy();
    expect(screen.queryByRole("region", { name: `${K}.title` })).toBeNull();
    expect(screen.queryByRole("button", { name: new RegExp(`${K}.resume`) })).toBeNull();
  });

  it("keeps the customer report card as it was before the shared parts", () => {
    render(<Page steps={[connectionStep]} intake={intake({ selected: 0, error: "Could not save the answer" })} />);

    expect(screen.getByRole("region", { name: "common.incidents.customerReport.title" }).outerHTML).toMatchInlineSnapshot(`"<section aria-label="common.incidents.customerReport.title" class="rounded-t-[19px] border-b border-violet-200 bg-gradient-to-b from-violet-50 to-violet-50/30 px-4 py-3 duration-200 animate-in fade-in slide-in-from-bottom-1 dark:border-violet-500/30 dark:from-violet-500/10 dark:to-transparent"><div class="mb-1.5 flex items-center gap-2"><span class="text-[11px] font-bold uppercase tracking-widest text-violet-700 dark:text-violet-300">common.incidents.customerReport.title</span><button type="button" aria-label="common.incidents.customerReport.dismiss" class="ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-violet-100 hover:text-violet-800 disabled:opacity-50 dark:hover:bg-violet-500/15 dark:hover:text-violet-200"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div><p class="text-sm text-foreground/90">Is this a message from a customer?</p><div role="group" aria-label="Is this a message from a customer?" class="mt-2.5 grid gap-1.5"><button type="button" aria-pressed="true" class="group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-colors duration-150 focus-visible:border-violet-400 focus-visible:ring-2 focus-visible:ring-violet-500/20 disabled:cursor-not-allowed disabled:opacity-60 border-violet-300 bg-violet-100/70 dark:border-violet-400/40 dark:bg-violet-500/15"><span class="flex min-w-0 flex-1 flex-col gap-0.5"><span class="text-sm font-medium text-foreground">Yes</span><span class="truncate text-xs text-muted-foreground">A customer wrote to us</span></span><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check size-3.5 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg></button><button type="button" aria-pressed="false" class="group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-colors duration-150 focus-visible:border-violet-400 focus-visible:ring-2 focus-visible:ring-violet-500/20 disabled:cursor-not-allowed disabled:opacity-60 border-transparent bg-muted/60 hover:bg-muted"><span class="flex min-w-0 flex-1 flex-col gap-0.5"><span class="text-sm font-medium text-foreground">No</span></span><kbd class="flex size-5 shrink-0 items-center justify-center rounded border border-border bg-background text-[11px] font-medium tabular-nums text-muted-foreground">2</kbd></button></div><p role="alert" class="mt-2 text-xs text-destructive">Could not save the answer</p></section>"`);
    expect(screen.getByRole("button", { name: "common.incidents.customerReport.submit" }).outerHTML).toMatchInlineSnapshot(`"<button type="button" class="h-8 whitespace-nowrap rounded-[10px] bg-violet-600 px-3.5 text-[13px] font-semibold text-white transition-colors hover:bg-violet-700 disabled:cursor-default disabled:bg-violet-200 dark:disabled:bg-violet-500/30">common.incidents.customerReport.submit</button>"`);
  });
});

function intake(patch: Partial<ComposerCustomerReportIntake> = {}): ComposerCustomerReportIntake {
  return {
    question: {
      key: "origin",
      title: "Is this a message from a customer?",
      options: [{ label: "Yes", hint: "A customer wrote to us", value: true }, { label: "No", value: false }],
      multiline: false,
    },
    editing: false,
    selected: undefined,
    select: vi.fn(),
    answerText: "",
    setAnswerText: vi.fn(),
    error: null,
    submitting: false,
    canSubmit: true,
    submit: vi.fn(),
    dismiss: vi.fn(),
    ...patch,
  } as unknown as ComposerCustomerReportIntake;
}
