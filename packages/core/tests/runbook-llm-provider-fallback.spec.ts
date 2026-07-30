import { describe, expect, it } from "vitest";

import { RunbookExecutionService } from "../src/features/runbooks/desktop-runbook-execution.service";
import type { RunbookActionRecord } from "../src/features/runbooks/desktop-runbook.types";

type Dispatch = {
  local: string[];
  remote: number;
};

function createService(defaultProviderKey: string | null): {
  service: RunbookExecutionService;
  dispatch: Dispatch;
} {
  const dispatch: Dispatch = { local: [], remote: 0 };

  const llmAdapter = {
    chatWithTools: async () => {
      dispatch.remote += 1;
      return { content: "" } as never;
    },
    getDefaultProviderKey: async () => defaultProviderKey,
  };

  const localAiProvider = {
    execute: async (provider: string) => {
      dispatch.local.push(provider);
      return { output: "local output", exitCode: 0 } as never;
    },
  };

  const service = new RunbookExecutionService(
    {} as never,
    {} as never,
    llmAdapter as never,
    {} as never,
    {} as never,
    () => null,
    { edition: "ce" },
    localAiProvider as never,
    {} as never,
  );

  return { service, dispatch };
}

function resolveProvider(
  service: RunbookExecutionService,
): Promise<RunbookActionRecord["llmProviderKey"]> {
  return (
    service as unknown as {
      resolveDefaultProviderKey(): Promise<
        RunbookActionRecord["llmProviderKey"]
      >;
    }
  ).resolveDefaultProviderKey();
}

function usesLocalPath(
  service: RunbookExecutionService,
  providerKey: RunbookActionRecord["llmProviderKey"],
): boolean {
  return (
    service as unknown as {
      shouldUseDedicatedLocalAiExecution(
        providerKey: RunbookActionRecord["llmProviderKey"],
      ): boolean;
    }
  ).shouldUseDedicatedLocalAiExecution(providerKey);
}

describe("runbook LLM action provider fallback", () => {
  it("falls back to the configured default provider when the action names none", async () => {
    const { service } = createService("codex");

    const providerKey = await resolveProvider(service);

    expect(providerKey).toBe("codex");
    expect(usesLocalPath(service, providerKey)).toBe(true);
  });

  it("routes a provider-less action to the local path instead of the tool-calling path", async () => {
    const { service } = createService("claude_code");

    const providerKey = await resolveProvider(service);

    // The tool-calling remote path cannot be served by a local CLI provider,
    // which is what produced "LLM action completed with no output".
    expect(usesLocalPath(service, providerKey)).toBe(true);
  });

  it("leaves the remote path in place when no default provider is configured", async () => {
    const { service } = createService(null);

    const providerKey = await resolveProvider(service);

    expect(providerKey).toBeUndefined();
    expect(usesLocalPath(service, providerKey)).toBe(false);
  });
});
