// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatBubble } from "@bitsentry-ce/components/chat/ChatBubble";
import type { ChatMessage } from "@bitsentry-ce/components/chat/types";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

afterEach(() => {
  cleanup();
});

describe("ChatBubble long user text", () => {
  it("wraps an unbroken CSV header inside the user bubble", () => {
    const message: ChatMessage = {
      kind: "user",
      text: "agent.name,package.name,cve.id,severity,status,installed.version,fixed.version,host.name,host.os,source,detected.at,resolved.at,description,reference,notes",
    };

    const { container } = render(<ChatBubble msg={message} />);
    const text = container.querySelector(".whitespace-pre-wrap");

    expect(text).not.toBeNull();
    expect(text?.classList.contains("break-words")).toBe(true);
  });
});
