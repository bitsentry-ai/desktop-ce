import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DbClient } from "../src/features/desktop/desktop-database-client";
import {
  createDesktopStateHandlers,
  loadIncidentThreadMessages,
} from "../src/features/desktop-state/desktop-state.handlers";

const createdAt = "2026-10-01T10:00:00.000Z";

const persistedIteration = {
  id: "iteration-1",
  startedAt: createdAt,
  completedAt: createdAt,
  text: "Disk is full",
  toolCallIds: ["tool-1"],
  status: "done",
};

const richAgentMessage = {
  id: "message-agent-1",
  kind: "agent",
  iterations: [persistedIteration],
  activeIterationId: null,
  toolCalls: [{ toolCallId: "tool-1", toolName: "execute_shell_command", state: "done", output: "100%", modelContext: "df" }],
  finalText: "Disk is full",
  status: "done",
  customerReport: { title: "Disk usage", parts: [{ type: "remediation", text: "Rotate logs" }] },
};

let directory: string;
let db: DbClient;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "incident-messages-"));
  db = new DbClient({ datasources: { db: { url: `file:${path.join(directory, "profile.db")}` } } });
  await db.$executeRawUnsafe(`
    CREATE TABLE "IncidentThread" (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, state TEXT, "sessionId" TEXT,
      "createdAt" TEXT, "updatedAt" TEXT, "archivedAt" TEXT, "deletedAt" TEXT);
    CREATE TABLE "IncidentMessage" (id TEXT PRIMARY KEY, "threadId" TEXT, "sortOrder" INTEGER, kind TEXT, text TEXT,
      "streamText" TEXT, "toolCallsJson" TEXT, "finalText" TEXT, status TEXT, "errorMsg" TEXT, "messageJson" TEXT,
      "createdAt" TEXT, "updatedAt" TEXT);
  `);
});

afterEach(async () => {
  await db.$disconnect();
  await rm(directory, { recursive: true, force: true });
});

describe("incident message persistence", () => {
  it("round-trips chat message fields through SQLite", async () => {
    const handlers = createDesktopStateHandlers(db);
    const threadA = [
      { id: "message-user-1", kind: "user", text: "Why is api-1 down?", attachments: [{ id: "a-1", type: "text", name: "log.txt" }] },
      richAgentMessage,
    ];
    const threadB = [{ id: "message-user-2", kind: "user", text: "Other thread" }];
    await handlers["desktopState:syncIncidents"]({
      incidents: [
        { id: "thread-a", title: "A", prompt: "Why is api-1 down?", state: "completed", createdAt },
        { id: "thread-b", title: "B", prompt: "Other thread", state: "completed", createdAt },
      ],
      incidentMessages: { "thread-a": threadA, "thread-b": threadB },
    });

    expect(await loadIncidentThreadMessages(db, "thread-a")).toEqual(threadA);
    expect(await loadIncidentThreadMessages(db, "thread-b")).toEqual(threadB);
  });

  it("reads rows written before messageJson from the summary columns", async () => {
    await db.$executeRawUnsafe(`
      INSERT INTO "IncidentMessage" (id, "threadId", "sortOrder", kind, text, "createdAt", "updatedAt")
        VALUES ('m-0', 'thread-a', 0, 'user', 'Legacy question', '${createdAt}', '${createdAt}');
      INSERT INTO "IncidentMessage" (id, "threadId", "sortOrder", kind, "streamText", "toolCallsJson", "finalText", status, "createdAt", "updatedAt")
        VALUES ('m-1', 'thread-a', 1, 'agent', 'Legacy answer', '[]', 'Legacy answer', 'done', '${createdAt}', '${createdAt}');
    `);

    expect(await loadIncidentThreadMessages(db, "thread-a")).toEqual([
      { id: "m-0", kind: "user", text: "Legacy question" },
      { id: "m-1", kind: "agent", streamText: "Legacy answer", toolCalls: [], finalText: "Legacy answer", status: "done", errorMsg: undefined },
    ]);
  });
});
