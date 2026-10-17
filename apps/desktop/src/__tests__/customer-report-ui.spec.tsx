// @vitest-environment jsdom

import React, { useLayoutEffect, useMemo, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CustomerReportIntakeService,
  customerReportProvenance,
  formatCustomerReportMessage,
  parseCustomerReportAnswerMessage,
  parseCustomerReportDismissMessage,
  type CustomerReport,
  type CustomerReportInput,
  type CustomerReportIntake,
  type CustomerReportIntakeStart,
  type IntegrationOperation,
} from "@bitsentry-ce/core/features/plugins";
import { ChatBubble } from "@bitsentry-ce/components/chat/ChatBubble";
import { Composer } from "@bitsentry-ce/components/chat/Composer";
import { CustomerReportIntakeChatContext, useCustomerReportIntake } from "@bitsentry-ce/components/chat/useCustomerReportIntake";
import { formatReceivedAt } from "@bitsentry-ce/components/chat/customerReport";
import type { ChatMessage } from "@bitsentry-ce/components/chat/types";
import { OperationBody } from "@bitsentry-ce/components/investigation/IntegrationActionsView";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const K = "common.incidents.customerReport";
const THREAD = "thread-1";
// The engineer works in Jakarta; typed times are read on that clock. 09:00 in Jakarta.
process.env.TZ = "Asia/Jakarta";
const NOW = new Date("2026-10-17T02:00:00.000Z");

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

/** The stores a host keeps; the service is the same one Desktop and the Dashboard use. */
function intakeService() {
  const intakes = new Map<string, CustomerReportIntake>();
  const reports: CustomerReport[] = [];
  const service = new CustomerReportIntakeService({
    latest: async (threadId) => [...intakes.values()].filter((row) => row.threadId === threadId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null,
    get: async (threadId, id) => { const row = intakes.get(id); return row?.threadId === threadId ? row : null; },
    save: async (intake) => { intakes.set(intake.id, intake); return intake; },
  }, {
    save: async (input: CustomerReportInput, submittedBy: string) => {
      const existing = reports.find((row) => row.clientRequestId === input.clientRequestId);
      if (existing) return existing;
      const row = { ...input, id: crypto.randomUUID(), submittedBy, operationId: null, supersededById: null, createdAt: NOW.toISOString() };
      reports.push(row);
      return row;
    },
    get: async (threadId, id) => reports.find((row) => row.threadId === threadId && row.id === id) ?? null,
    link: async () => true,
    supersede: async (_threadId, id, supersededById) => { const row = reports.find((item) => item.id === id); if (row) row.supersededById = supersededById; },
  });
  /** What the agent's request_customer_report_input call does. */
  const agentAsks = (start: CustomerReportIntakeStart, engineerMessages: string[]) => service.start(THREAD, { start, timeZone: "Asia/Jakarta", engineerMessages });
  return { service, reports, agentAsks };
}

/** An Incident thread: the chat shows what was sent, the composer shows the open question. */
function Thread({ service, busy, sent, initial = [] }: { service: CustomerReportIntakeService; busy: boolean; sent: string[]; initial?: string[] }) {
  const client = useMemo(() => ({
    latest: (threadId: string) => service.latest(threadId),
    answer: (input: Parameters<CustomerReportIntakeService["answer"]>[0]) => service.answer(input, "wira"),
    dismiss: (input: Parameters<CustomerReportIntakeService["dismiss"]>[0]) => service.dismiss(input),
  }), [service]);
  const [messages, setMessages] = useState<string[]>(initial);
  const intake = useCustomerReportIntake({ client, threadId: THREAD, busy, send: (text) => { sent.push(text); setMessages((previous) => [...previous, text]); } });
  return (
    <CustomerReportIntakeChatContext.Provider value={intake.chat}>
      {messages.map((text, index) => <ChatBubble key={index} msg={{ kind: "user", text } as ChatMessage} providerKey="openai" />)}
      <Composer
        prompt=""
        onPromptChange={vi.fn()}
        onSend={vi.fn()}
        onCancel={vi.fn()}
        isProcessing={busy}
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
        customerReportIntake={intake.composer}
      />
    </CustomerReportIntakeChatContext.Provider>
  );
}

/** A step the test lets finish. */
function gate() {
  let open = () => {};
  const done = new Promise<void>((resolve) => { open = resolve; });
  return { done, open };
}

/** What the page does, step by step, while the agent answers. */
interface PageSteps {
  answer?: Promise<void>;
  messageSaved?: Promise<void>;
  runStarted?: Promise<void>;
  latest?: () => Promise<void>;
}
interface PageAgent { start: () => void; reply: (text: string) => void; toolDone: () => void; finish: (text: string) => void }
/** What one committed render shows. */
interface Frame { question: string | null; rows: number; reply: string | null; busy: boolean; panel: HTMLElement | null }

/**
 * The Dashboard's Incident page: the sent message and the busy composer show in one render, the agent's turn starts
 * later, its reply streams, and the turn ends with the final reply and the idle composer in one render.
 */
function Page({ service, steps, agent, frames }: { service: CustomerReportIntakeService; steps: PageSteps; agent: { current: PageAgent | null }; frames: Frame[] }) {
  const client = useMemo(() => ({
    latest: async (threadId: string) => { const latest = await service.latest(threadId); await steps.latest?.(); return latest; },
    answer: async (input: Parameters<CustomerReportIntakeService["answer"]>[0]) => { const result = await service.answer(input, "wira"); await steps.answer; return result; },
    dismiss: (input: Parameters<CustomerReportIntakeService["dismiss"]>[0]) => service.dismiss(input),
  }), [service, steps]);
  const [rows, setRows] = useState<string[]>([]);
  const [reply, setReply] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toolCalls, setToolCalls] = useState(0);
  agent.current = {
    start: () => { setBusy(true); },
    reply: setReply,
    toolDone: () => { setToolCalls((count) => count + 1); },
    finish: (text) => { setReply(text); setBusy(false); },
  };
  const intake = useCustomerReportIntake({
    client,
    threadId: THREAD,
    busy,
    refresh: toolCalls,
    send: async (text) => {
      await steps.messageSaved;
      setRows((previous) => [...previous, text]);
      setReply(null);
      setToolCalls(0);
      setBusy(true);
      await steps.runStarted;
    },
  });
  useLayoutEffect(() => {
    const shown = panel();
    const question = shown === null ? null : (["sender", "subject", "receivedAt"].find((key) => within(shown).queryByText(`${K}.questions.${key}`) !== null) ?? "other");
    frames.push({ question, rows: rows.length, reply, busy, panel: shown });
  });
  return (
    <CustomerReportIntakeChatContext.Provider value={intake.chat}>
      {rows.map((text, index) => <ChatBubble key={index} msg={{ kind: "user", text } as ChatMessage} providerKey="openai" />)}
      {reply !== null && <p>{reply}</p>}
      <Composer
        prompt=""
        onPromptChange={vi.fn()}
        onSend={vi.fn()}
        onCancel={vi.fn()}
        isProcessing={busy}
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
        customerReportIntake={intake.composer}
      />
    </CustomerReportIntakeChatContext.Provider>
  );
}

const panel = () => screen.queryByRole("region", { name: `${K}.title` });
/** The open question, read inside the panel: the timeline repeats answered questions. */
const asked = (key: string) => waitFor(() => within(screen.getByRole("region", { name: `${K}.title` })).getByText(key));
/** An option button; its name also carries the number key that picks it. */
const option = (label: string) => within(panel() as HTMLElement).getByRole("button", { name: new RegExp(`^${label.replace(/\./g, "\\.")}`) });
const answerBox = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const answered = (text: string) => parseCustomerReportAnswerMessage(text)?.header;

describe("customer report question in the composer", () => {
  it("opens after the agent's reply, and a picked option is saved and sent to the agent", async () => {
    const { service, agentAsks } = intakeService();
    await agentAsks({ origin: "customer", extracted: [{ field: "channel", value: "email", quote: "by email" }] }, ["We just got a customer report by email: the service desk keeps loading."]);
    const sent: string[] = [];
    const view = render(<Thread service={service} busy sent={sent} />);
    expect(panel()).toBeNull();

    view.rerender(<Thread service={service} busy={false} sent={sent} />);
    expect(await asked(`${K}.questions.sender`)).toBeTruthy();
    fireEvent.click(option(`${K}.options.notSure`));

    await waitFor(() => { expect(sent).toHaveLength(1); });
    expect(answered(sent[0])).toMatchObject({ field: "sender", answer: `${K}.options.notSure`, next: "subject" });
    expect((await service.latest(THREAD))?.answers.sender).toBeNull();
    expect(await asked(`${K}.questions.subject`)).toBeTruthy();
    expect(screen.queryByText(/\[customer-report-answer\]/)).toBeNull();
  });

  it("never shows the next question before the agent's reply that asks it, through every step of the turn", async () => {
    const { service, agentAsks } = intakeService();
    await agentAsks({ origin: "customer", extracted: [{ field: "channel", value: "email", quote: "by email" }] }, ["We just got a customer report by email: the service desk keeps loading."]);
    const answer = gate();
    const messageSaved = gate();
    const runStarted = gate();
    const refreshed = gate();
    let slowRefresh = false;
    const steps: PageSteps = { answer: answer.done, messageSaved: messageSaved.done, runStarted: runStarted.done, latest: () => (slowRefresh ? refreshed.done : Promise.resolve()) };
    const agent: { current: PageAgent | null } = { current: null };
    const frames: Frame[] = [];
    render(<Page service={service} steps={steps} agent={agent} frames={frames} />);
    expect(await asked(`${K}.questions.sender`)).toBeTruthy();
    fireEvent.click(option(`${K}.options.notSure`));

    // The answer is saving: the answered question stays, disabled.
    await waitFor(() => { expect((option(`${K}.options.notSure`) as HTMLButtonElement).disabled).toBe(true); });
    answer.open();
    // The answer is saved and the chat message is saving: still the answered question, and no row yet.
    await waitFor(async () => { expect((await service.latest(THREAD))?.question).toBe("subject"); });
    expect(within(panel() as HTMLElement).getByText(`${K}.questions.sender`)).toBeTruthy();
    messageSaved.open();
    // The row is in: the panel is gone and the composer is busy, in the same render.
    await waitFor(() => { expect(frames.at(-1)).toMatchObject({ rows: 1, busy: true, question: null }); });
    // The agent's turn starts late, its reply streams, and the turn ends while the intake is read again slowly.
    runStarted.open();
    act(() => { agent.current?.reply("Noted, Wira"); });
    slowRefresh = true;
    act(() => { agent.current?.finish("Noted. What was the email's subject line?"); });
    expect(frames.at(-1)).toMatchObject({ question: "subject", busy: false, reply: "Noted. What was the email's subject line?" });
    const opened = frames.at(-1)?.panel;
    refreshed.open();
    await waitFor(() => { expect(frames.at(-1)?.panel).toBe(opened); });

    // In no render did the next question show before its reply, nor the answered question after its row.
    expect(frames.filter((frame) => frame.question === "subject" && (frame.busy || frame.reply !== "Noted. What was the email's subject line?"))).toEqual([]);
    expect(frames.filter((frame) => frame.rows === 1 && frame.question === "sender")).toEqual([]);
    // Once it opened, the next question stayed open: no gap, no second opening.
    const first = frames.findIndex((frame) => frame.question === "subject");
    expect(frames.slice(first).filter((frame) => frame.question !== "subject" || frame.panel !== opened)).toEqual([]);
  });

  it("opens the first question with the agent's reply that asks it", async () => {
    const { service, agentAsks } = intakeService();
    const agent: { current: PageAgent | null } = { current: null };
    const frames: Frame[] = [];
    render(<Page service={service} steps={{}} agent={agent} frames={frames} />);
    // The engineer's first message is sent by the page itself; the agent works.
    act(() => { agent.current?.start(); });
    expect(panel()).toBeNull();

    // During its turn, the agent opens the intake with its tool, then writes the question.
    const busyFrames = frames.length;
    await agentAsks({ origin: "customer", extracted: [{ field: "channel", value: "email", quote: "by email" }] }, ["We just got a customer report by email: the service desk keeps loading."]);
    act(() => { agent.current?.toolDone(); });
    // The agent writes its reply after the tool; the intake read ends in that time.
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    act(() => { agent.current?.finish("I'll record the customer report first. Who sent it?"); });
    expect(frames.at(-1)).toMatchObject({ question: "sender", reply: "I'll record the customer report first. Who sent it?" });
    expect(frames.slice(busyFrames).filter((frame) => frame.question !== null && frame.reply !== "I'll record the customer report first. Who sent it?")).toEqual([]);
  });

  it("takes a typed answer, and refuses a received time in the future without saving it", async () => {
    const { service, agentAsks } = intakeService();
    await agentAsks({ origin: "customer", extracted: [{ field: "sender", value: "Rina", quote: "Rina from Acme" }, { field: "channel", value: "phone", quote: "called" }] }, ["Rina from Acme called, she cannot log in."]);
    const sent: string[] = [];
    render(<Thread service={service} busy={false} sent={sent} />);
    expect(await asked(`${K}.questions.receivedAtPhone`)).toBeTruthy();

    fireEvent.change(answerBox(), { target: { value: "09:30" } });
    fireEvent.keyDown(answerBox(), { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toBe(`${K}.errors.future`);
    expect(sent).toEqual([]);

    fireEvent.change(answerBox(), { target: { value: "08:15" } });
    fireEvent.keyDown(answerBox(), { key: "Enter" });
    await waitFor(() => { expect(sent).toHaveLength(1); });
    expect((await service.latest(THREAD))?.answers.receivedAt).toBe("2026-10-17T08:15:00+07:00");
  });

  it("closes a new report for good when the engineer dismisses it", async () => {
    const { service, agentAsks } = intakeService();
    await agentAsks({ origin: "customer" }, ["A customer complained the VPN keeps dropping."]);
    const sent: string[] = [];
    render(<Thread service={service} busy={false} sent={sent} />);
    expect(await asked(`${K}.questions.channel`)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: `${K}.dismiss` }));
    await waitFor(() => { expect(sent).toHaveLength(1); });
    expect(parseCustomerReportDismissMessage(sent[0])).not.toBeNull();
    expect((await service.latest(THREAD))?.status).toBe("dismissed");
    expect(panel()).toBeNull();
    expect(screen.getByText(`${K}.dismissed`)).toBeTruthy();
  });

  it("changes one earlier answer from its row; closing the change keeps the open question", async () => {
    const { service, agentAsks } = intakeService();
    await agentAsks({ origin: "customer", extracted: [{ field: "channel", value: "email", quote: "by email" }] }, ["We just got a customer report by email: the service desk keeps loading."]);
    const sent: string[] = [];
    render(<Thread service={service} busy={false} sent={sent} />);
    await asked(`${K}.questions.sender`);
    fireEvent.change(answerBox(), { target: { value: "Dewi" } });
    fireEvent.click(screen.getByRole("button", { name: `${K}.submit` }));
    await asked(`${K}.questions.subject`);

    fireEvent.click(screen.getByRole("button", { name: `${K}.changeAnswer` }));
    expect(await asked(`${K}.questions.sender`)).toBeTruthy();
    expect(answerBox().value).toBe("Dewi");
    fireEvent.click(screen.getByRole("button", { name: `${K}.cancelChange` }));
    expect(await asked(`${K}.questions.subject`)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: `${K}.changeAnswer` }));
    await asked(`${K}.questions.sender`);
    fireEvent.change(answerBox(), { target: { value: "Sari" } });
    fireEvent.click(screen.getByRole("button", { name: `${K}.update` }));
    await waitFor(() => { expect(sent).toHaveLength(2); });
    expect(answered(sent[1])).toMatchObject({ field: "sender", answer: "Sari", edit: true, next: "subject" });
    expect(await asked(`${K}.questions.subject`)).toBeTruthy();
  });
});

describe("a forwarded email that gives every value", () => {
  it("only asks to save it, then saves the customer's words", async () => {
    const { service, agentAsks, reports } = intakeService();
    const body = "Hi team, our service desk page keeps loading and then times out.";
    await agentAsks({ origin: "customer", extracted: [
      { field: "channel", value: "email", quote: "forwarded customer email" },
      { field: "sender", value: "Rina from Acme", quote: "From: Rina from Acme" },
      { field: "subject", value: "Service desk timeout", quote: "Subject: Service desk timeout" },
      { field: "receivedAt", value: "2026-10-17T08:15:00+08:00", quote: "08:15 WITA (UTC+08:00)" },
      { field: "reportText", value: body, quote: body },
    ] }, [`Please collect this forwarded customer email.\nFrom: Rina from Acme\nSubject: Service desk timeout\nDate: 17 October 2026, 08:15 WITA (UTC+08:00)\n\n${body}`]);
    const sent: string[] = [];
    render(<Thread service={service} busy={false} sent={sent} />);
    await asked(`${K}.questions.confirm`);
    fireEvent.click(option(`${K}.options.save`));

    await waitFor(() => { expect(sent).toHaveLength(1); });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ sender: "Rina from Acme", subject: "Service desk timeout", reportText: body });
    expect(answered(sent[0])).toMatchObject({ field: "confirm", next: null, customerReportId: reports[0].id });
  });
});

describe("a received time", () => {
  it("shows the clock it was recorded with, and the zone name only when the offsets match", () => {
    expect(formatReceivedAt("2026-10-17T10:15:00+08:00", "UTC", "en-US")).toBe("Oct 17, 2026, 10:15 AM (UTC+08:00)");
    expect(formatReceivedAt("2026-10-17T10:15:00+08:00", "Asia/Makassar", "en-US")).toBe("Oct 17, 2026, 10:15 AM (Asia/Makassar, UTC+08:00)");
  });
});

describe("a saved customer report in the chat", () => {
  async function savedWithoutSource() {
    const { service, agentAsks, reports } = intakeService();
    const started = await agentAsks({ origin: "customer", extracted: [{ field: "channel", value: "whatsapp", quote: "barusan WA" }] }, ["Klien barusan WA, katanya VPN putus."]);
    const intakeId = started.intake.id;
    await service.answer({ threadId: THREAD, intakeId, clientRequestId: crypto.randomUUID(), answer: { field: "sender", value: null } }, "wira");
    await service.answer({ threadId: THREAD, intakeId, clientRequestId: crypto.randomUUID(), answer: { field: "receivedAt", value: null } }, "wira");
    const done = await service.answer({ threadId: THREAD, intakeId, clientRequestId: crypto.randomUUID(), answer: { field: "reportText", value: "VPN putus terus dari pagi." } }, "wira");
    const message = `[customer-report-answer]${JSON.stringify({ intakeId, field: "reportText", answer: "VPN putus terus dari pagi.", next: null, customerReportId: done.report?.id })}\n${formatCustomerReportMessage(done.report as CustomerReport)}`;
    return { service, reports, message };
  }

  it("shows an unknown sender and time as not provided, never as a guess", async () => {
    const { service, message } = await savedWithoutSource();
    render(<Thread service={service} busy={false} sent={[]} initial={[message]} />);
    expect(screen.getByText(`${K}.senderNotProvided · ${K}.receivedNotProvided`)).toBeTruthy();
    expect(screen.getByText("VPN putus terus dari pagi.")).toBeTruthy();
    expect(screen.queryByText(/\[customer-report/)).toBeNull();
  });

  it("lets the engineer change one answer from the card, which saves a corrected report", async () => {
    const { service, reports, message } = await savedWithoutSource();
    const sent: string[] = [];
    render(<Thread service={service} busy={false} sent={sent} initial={[message]} />);
    fireEvent.click(await screen.findByRole("button", { name: `${K}.edit` }));
    expect(await asked(`${K}.questions.fix`)).toBeTruthy();
    fireEvent.click(option(`${K}.fields.sender`));
    await asked(`${K}.questions.sender`);
    fireEvent.change(answerBox(), { target: { value: "Pak Budi" } });
    fireEvent.click(screen.getByRole("button", { name: `${K}.update` }));

    await waitFor(() => { expect(sent).toHaveLength(1); });
    expect(reports).toHaveLength(2);
    expect(reports[0].supersededById).toBe(reports[1].id);
    expect(reports[1]).toMatchObject({ sender: "Pak Budi", reportText: "VPN putus terus dari pagi." });
    expect(answered(sent[0])).toMatchObject({ field: "sender", edit: true, customerReportId: reports[1].id });
    await waitFor(() => { expect(screen.getByText(`${K}.fromSender · ${K}.receivedNotProvided`)).toBeTruthy(); });
  });
});

describe("customer report ticket proposal", () => {
  const report = {
    id: "33333333-3333-4333-8333-333333333333", threadId: THREAD, clientRequestId: "44444444-4444-4444-8444-444444444444",
    channel: "whatsapp" as const, sender: "Budi – IT PT X", receivedAt: "2026-10-15T09:12:00+07:00", timeZone: "Asia/Jakarta",
    reportText: "Portal HR timeout sejak jam 9.", submittedBy: "wira", operationId: null, createdAt: "2026-10-15T02:13:00.000Z",
  };
  const row: IntegrationOperation = {
    id: "22222222-2222-4222-8222-222222222222", threadId: THREAD, connectionId: "11111111-1111-4111-8111-111111111111",
    connectionName: "Itop Bitsentry", target: "https://itop.example", pluginId: "itop", actionId: "create_object",
    input: { class: "UserRequest", fields: { title: "HR portal timeout", private_log: { add_item: { message: customerReportProvenance(report), format: "text" } } } },
    publicUpdate: false, requiresCloseRequest: false, pluginVersion: "1.0.0", connectionRevision: "1", ticketOperation: "create",
    customerReport: { id: report.id, channel: "whatsapp", sender: report.sender, receivedAt: report.receivedAt, timeZone: report.timeZone, submittedBy: "wira" },
    status: "proposed", createdAt: "2026-10-15T02:14:00.000Z", updatedAt: "2026-10-15T02:14:00.000Z",
  };

  it("lists the report in its own internal section instead of a raw field change", () => {
    render(<OperationBody row={row} disabled={false} busy={false} refusal={undefined} closeRequested={false} onCloseRequestedChange={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} service={{ list: vi.fn(), approve: vi.fn(), cancel: vi.fn() }} onRefresh={vi.fn()} />);
    expect(screen.getByRole("region", { name: "incidents.integrationWrites.customerReport.title" })).toBeTruthy();
    expect(screen.getByText("incidents.integrationWrites.customerReport.internalOnly")).toBeTruthy();
    expect(screen.getByText("incidents.integrationWrites.customerReport.unverified")).toBeTruthy();
    expect(screen.getByText(report.sender)).toBeTruthy();
    expect(screen.getByText("title")).toBeTruthy();
    expect(screen.queryByText("private_log")).toBeNull();
  });

  it("shows a sender the engineer did not know as not provided", () => {
    render(<OperationBody row={{ ...row, customerReport: { ...row.customerReport!, sender: null, receivedAt: null } }} disabled={false} busy={false} refusal={undefined} closeRequested={false} onCloseRequestedChange={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} service={{ list: vi.fn(), approve: vi.fn(), cancel: vi.fn() }} onRefresh={vi.fn()} />);
    expect(screen.getAllByText("incidents.integrationWrites.customerReport.notProvided")).toHaveLength(2);
  });
});

