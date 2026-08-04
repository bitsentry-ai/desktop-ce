import { describe, expect, it, vi } from "vitest";
import {
  sendIncidentAgentMessage,
} from "@bitsentry-ce/components/investigation/Incidents";

describe("incident composer agent requests", () => {
  it("does not attach a runbook to the actual start or follow-up agent calls", async () => {
    const common = {
      text: "List the existing runbooks.",
      sessionId: "session-1",
      attachments: [],
      llm: { providerKey: "codex" as const, model: "gpt-5.6" },
      incidentThreadId: "incident-1",
      accessLevel: "auto-accept-edits" as const,
    };
    const agent = {
      start: vi.fn().mockResolvedValue({ sessionId: "new-session" }),
      send: vi.fn().mockResolvedValue({ sessionId: "follow-up-session" }),
    };

    await sendIncidentAgentMessage(agent, { ...common, continueSession: false });
    await sendIncidentAgentMessage(agent, { ...common, continueSession: true });

    expect(agent.start).toHaveBeenCalledOnce();
    expect(agent.send).toHaveBeenCalledOnce();
    expect(agent.start.mock.calls[0]?.[0]).not.toHaveProperty("runbookId");
    expect(agent.send.mock.calls[0]?.[0]).not.toHaveProperty("runbookId");
  });
});
