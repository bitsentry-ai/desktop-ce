// @vitest-environment jsdom

import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { customerReportProvenance, formatCustomerReportMessage, type IntegrationOperation } from "@bitsentry-ce/core/features/plugins";
import { ChatBubble } from "@bitsentry-ce/components/chat/ChatBubble";
import { Composer, type ComposerProps } from "@bitsentry-ce/components/chat/Composer";
import { toCustomerReportInput, type CustomerReportDraft } from "@bitsentry-ce/components/chat/customerReport";
import type { ChatMessage } from "@bitsentry-ce/components/chat/types";
import { OperationBody } from "@bitsentry-ce/components/investigation/IntegrationActionsView";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

const report = {
  id: "33333333-3333-4333-8333-333333333333", threadId: "thread-1", clientRequestId: "44444444-4444-4444-8444-444444444444",
  channel: "whatsapp" as const, sender: "Budi – IT PT X", receivedAt: "2026-10-15T09:12:00+07:00", timeZone: "Asia/Jakarta",
  reportText: "Portal HR timeout sejak jam 9.", submittedBy: "wira", operationId: null, createdAt: "2026-10-15T02:13:00.000Z",
};

function ComposerHarness({ prompt, initial, onSend }: { prompt: string; initial: CustomerReportDraft | null; onSend: ComposerProps["onSend"] }) {
  const [draft, setDraft] = useState<CustomerReportDraft | null>(initial);
  return (
    <Composer
      prompt={prompt}
      onPromptChange={vi.fn()}
      onSend={onSend}
      onCancel={vi.fn()}
      isProcessing={false}
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
      customerReport={{ draft, onDraftChange: setDraft, defaultTimeZone: "Asia/Jakarta" }}
    />
  );
}

describe("customer report composer", () => {
  const panel = () => screen.queryByRole("group", { name: "common.incidents.customerReport.title" });

  it("opens the report panel from the attach menu, focused on the sender, in the default time zone", () => {
    render(<ComposerHarness prompt="Portal HR timeout" initial={null} onSend={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "common.incidents.composerOptions" }));
    fireEvent.click(screen.getByRole("button", { name: "common.incidents.customerReport.menu" }));
    expect(panel()).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText(/common\.incidents\.customerReport\.sender/));
    expect(screen.getByRole("combobox", { name: /common\.incidents\.customerReport\.timeZone/ }).textContent).toContain("Asia/Jakarta (UTC+07:00)");
  });

  it("moves the channel choice with the arrow keys", () => {
    const draft: CustomerReportDraft = { clientRequestId: report.clientRequestId, channel: "whatsapp", sender: "", receivedAtLocal: "", timeZone: "UTC" };
    render(<ComposerHarness prompt="x" initial={draft} onSend={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole("radio", { name: "common.incidents.customerReport.channels.whatsapp" }), { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "common.incidents.customerReport.channels.email" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(screen.getByRole("radio", { name: "common.incidents.customerReport.channels.email" }), { key: "ArrowLeft" });
    fireEvent.keyDown(screen.getByRole("radio", { name: "common.incidents.customerReport.channels.whatsapp" }), { key: "ArrowLeft" });
    expect(screen.getByRole("radio", { name: "common.incidents.customerReport.channels.other" }).getAttribute("aria-checked")).toBe("true");
  });

  it("does not send until the sender and received time are filled in, and says which field is missing", () => {
    const draft: CustomerReportDraft = { clientRequestId: report.clientRequestId, channel: "phone", sender: "", receivedAtLocal: "", timeZone: "Asia/Jakarta" };
    render(<ComposerHarness prompt="Portal HR timeout" initial={draft} onSend={vi.fn()} />);
    const send = screen.getByRole("button", { name: "common.incidents.sendMessage" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const sender = screen.getByLabelText(/common\.incidents\.customerReport\.sender/);
    fireEvent.blur(sender);
    expect(screen.getByRole("alert").textContent).toBe("common.incidents.customerReport.senderRequired");
    expect(sender.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(sender, { target: { value: "Ana" } });
    fireEvent.click(screen.getByRole("button", { name: "common.incidents.customerReport.now" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(send.disabled).toBe(false);
  });

  it("refuses a received time in the future", () => {
    const draft: CustomerReportDraft = { clientRequestId: report.clientRequestId, channel: "phone", sender: "Ana", receivedAtLocal: "2099-01-01T09:00", timeZone: "UTC" };
    render(<ComposerHarness prompt="Portal HR timeout" initial={draft} onSend={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toBe("common.incidents.customerReport.receivedAtFuture");
    expect((screen.getByRole("button", { name: "common.incidents.sendMessage" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("removes the draft from the panel", () => {
    const draft: CustomerReportDraft = { clientRequestId: report.clientRequestId, channel: "email", sender: "Ana", receivedAtLocal: "2026-10-15T09:12", timeZone: "UTC" };
    render(<ComposerHarness prompt="x" initial={draft} onSend={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "common.incidents.customerReport.remove" }));
    expect(panel()).toBeNull();
  });
});

describe("customer report save input", () => {
  it("saves the pasted text exactly, including leading and trailing whitespace", () => {
    const draft: CustomerReportDraft = { clientRequestId: report.clientRequestId, channel: "email", sender: "  Ana  ", receivedAtLocal: "2026-10-15T09:12", timeZone: "Asia/Jakarta" };
    expect(toCustomerReportInput(draft, "thread-1", "  Portal down  \n")).toMatchObject({ reportText: "  Portal down  \n", sender: "Ana", receivedAt: "2026-10-15T09:12:00+07:00" });
    expect(toCustomerReportInput(draft, "thread-1", "   ")).toBeNull();
  });
});

describe("customer report message", () => {
  it("shows the source as an internal chip and only the report text in the bubble", () => {
    const message: ChatMessage = { kind: "user", text: formatCustomerReportMessage(report) } as ChatMessage;
    render(<ChatBubble msg={message} providerKey="openai" />);
    expect(screen.getByText(/common\.incidents\.customerReport\.title · common\.incidents\.customerReport\.channels\.whatsapp/)).toBeTruthy();
    expect(screen.getByText("common.incidents.customerReport.internalOnly")).toBeTruthy();
    expect(screen.getByText("common.incidents.customerReport.unverified")).toBeTruthy();
    expect(screen.getByText(report.reportText)).toBeTruthy();
    expect(screen.queryByText(/\[customer-report\]/)).toBeNull();
  });
});

describe("customer report ticket proposal", () => {
  const row: IntegrationOperation = {
    id: "22222222-2222-4222-8222-222222222222", threadId: "thread-1", connectionId: "11111111-1111-4111-8111-111111111111",
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
});
