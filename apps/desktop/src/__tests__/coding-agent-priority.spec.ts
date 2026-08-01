import { describe, expect, it } from "vitest";
import { type SavedProviderConfig } from "@bitsentry-ce/components/chat/types";
import { CODING_AGENT_PRIORITY } from "@bitsentry-ce/components/desktop/codingAgentPriority";
import { getPrimaryCodingAgentFromSavedProviders } from "@bitsentry-ce/components/desktop/useDesktopCodingAgentPrimary";
import { listConfiguredProviderKeys } from "@bitsentry-ce/components/investigation/Incidents";

function configuredProvider(): SavedProviderConfig {
  return {
    hasApiKey: true,
    baseUrl: "",
    model: "",
    availableModels: [],
    isSelectable: true,
    isPrimary: false,
  };
}

describe("coding-agent priority", () => {
  it("uses the shared priority for primary-agent tie-breaking and incident defaults", () => {
    const configuredProviders = Object.fromEntries(
      [
        ...CODING_AGENT_PRIORITY,
        "openai",
        "anthropic",
        "gemini",
        "groq",
        "kilocode",
        "openrouter",
      ].map((providerKey) => [providerKey, configuredProvider()]),
    );

    expect(
      getPrimaryCodingAgentFromSavedProviders({
        codex: { ...configuredProvider(), isPrimary: true },
        claude_code: { ...configuredProvider(), isPrimary: true },
      }),
    ).toBe("codex");
    expect(listConfiguredProviderKeys(configuredProviders)).toEqual([
      ...CODING_AGENT_PRIORITY,
      "openai",
      "anthropic",
      "gemini",
      "groq",
      "kilocode",
      "openrouter",
    ]);
  });
});
