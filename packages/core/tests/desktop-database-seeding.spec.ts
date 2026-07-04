import { describe, expect, it, vi } from "vitest";

import {
  createDesktopDatabaseSeeders,
  type DesktopDatabaseSeedClient,
} from "../src/features/desktop/desktop-database-seeding";

function createClient() {
  const runbookActionUpdate = vi.fn(() => Promise.resolve({}));
  const client: DesktopDatabaseSeedClient = {
    role: {
      findUnique: vi.fn(() => Promise.resolve({ id: 1, name: "operator" })),
      create: vi.fn(() => Promise.resolve({})),
    },
    status: {
      findUnique: vi.fn(({ where }: { where: { id: number } }) => {
        if (where.id === 1) return Promise.resolve({ id: 1, name: "active" });
        if (where.id === 2) return Promise.resolve({ id: 2, name: "inactive" });
        return Promise.resolve(null);
      }),
      create: vi.fn(() => Promise.resolve({})),
    },
    setting: {
      findUnique: vi.fn(() => Promise.resolve(null)),
      create: vi.fn(() => Promise.resolve({})),
      update: vi.fn(() => Promise.resolve({})),
      findMany: vi.fn(() => Promise.resolve([])),
      delete: vi.fn(() => Promise.resolve({})),
    },
    agent: {
      create: vi.fn(() => Promise.resolve({})),
      count: vi.fn(() => Promise.resolve(1)),
    },
    agentHealth: { create: vi.fn(() => Promise.resolve({})) },
    agentTag: { create: vi.fn(() => Promise.resolve({})) },
    vulnerability: { create: vi.fn(() => Promise.resolve({})) },
    vulnerabilityAgent: { create: vi.fn(() => Promise.resolve({})) },
    vulnerabilityTimeline: { create: vi.fn(() => Promise.resolve({})) },
    threatIntelligence: { create: vi.fn(() => Promise.resolve({})) },
    threatIndicator: { create: vi.fn(() => Promise.resolve({})) },
    auditLog: { create: vi.fn(() => Promise.resolve({})) },
    runbookAction: {
      findMany: vi.fn(() => Promise.resolve([
        {
          id: "kanye-llm-action",
          title: "What did kanye say?",
          prompt: "Make a philosophical break down of what Kanye said.",
          llmProviderKey: "groq",
          llmModel: "openai/gpt-oss-20b",
        },
      ])),
      update: runbookActionUpdate,
    },
  };
  return { client, runbookActionUpdate };
}

describe("createDesktopDatabaseSeeders", () => {
  it("migrates the CE Kanye Rest action to Codex GPT-5.4 Mini", async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };
    const { client, runbookActionUpdate } = createClient();
    const seeders = createDesktopDatabaseSeeders({
      defaultLlmProvider: "codex",
      migrateCeKanyeRestRunbook: true,
      logger,
    });

    await seeders.seedDefaults(client);

    expect(runbookActionUpdate).toHaveBeenCalledWith({
      where: { id: "kanye-llm-action" },
      data: {
        llmProviderKey: "codex",
        llmModel: "gpt-5.4-mini",
      },
    });
  });
});
