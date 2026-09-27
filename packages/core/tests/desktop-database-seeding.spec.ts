import { describe, expect, it, vi } from "vitest";

import {
  createDesktopDatabaseSeeders,
  type DesktopDatabaseSeedClient,
} from "../src/features/desktop/desktop-database-seeding";

function createClient() {
  const runbookActionUpdate = vi.fn(() => Promise.resolve({}));
  const client: DesktopDatabaseSeedClient = {
    setting: {
      findUnique: vi.fn(() => Promise.resolve(null)),
      create: vi.fn(() => Promise.resolve({})),
      update: vi.fn(() => Promise.resolve({})),
      findMany: vi.fn(() => Promise.resolve([])),
      delete: vi.fn(() => Promise.resolve({})),
    },
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T00:00:00.000Z"));
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

    try {
      await seeders.seedDefaults(client);

      expect(runbookActionUpdate).toHaveBeenCalledWith({
        where: { id: "kanye-llm-action" },
        data: {
          llmProviderKey: "codex",
          llmModel: "gpt-5.4-mini",
          updatedAt: "2026-07-12T00:00:00.000Z",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
