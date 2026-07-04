import { describe, expect, it, vi } from "vitest";

import type { DesktopRunbookExportArtifactV1 } from "@bitsentry-ce/core/features/runbooks/desktop-runbook-ce.types";
import { createDesktopYamlRunbookHandlers as createRunbookHandlers } from "@bitsentry-ce/core/features/runbooks/desktop-runbook-handler-yaml-bindings";
import { DesktopRunbookStore as RunbookStore } from "@bitsentry-ce/core/features/runbooks/desktop-runbook.store";

function createDb(overrides?: Partial<Record<string, unknown>>) {
  return {
    runbook: {
      findMany: vi.fn(() => []),
      create: vi.fn(
        ({ data }: { data: Record<string, unknown> }) => data,
      ),
      delete: vi.fn(() => {}),
      ...((overrides?.runbook as Record<string, unknown> | undefined) ?? {}),
    },
    runbookAction: {
      findMany: vi.fn(() => []),
      create: vi.fn(
        ({ data }: { data: Record<string, unknown> }) => data,
      ),
      deleteMany: vi.fn(() => {}),
      ...((overrides?.runbookAction as Record<string, unknown> | undefined) ??
        {}),
    },
    errorSource: {
      findMany: vi.fn(() => []),
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      findUnique: vi.fn(() => null),
      ...((overrides?.errorSource as Record<string, unknown> | undefined) ??
        {}),
    },
  };
}

function createStore(dbOverrides?: Partial<Record<string, unknown>>) {
  const db = createDb(dbOverrides);
  const globalVariablesService = {
    list: vi.fn(() => []),
  };

  return {
    db,
    store: new RunbookStore(db as never, globalVariablesService as never),
  };
}

describe("RunbookStore importRunbooks", () => {
  it("imports a duplicate copy when actions match an existing runbook by fingerprint", async () => {
    const existingRunbookId = "runbook-existing";
    const action = {
      id: "action-existing",
      runbookId: existingRunbookId,
      sortOrder: 0,
      type: "shell",
      title: "Check disk",
      command: "df -h",
    };
    const { store } = createStore({
      runbook: {
        findMany: vi.fn(() => [
          {
            id: existingRunbookId,
            title: "Server health",
            description: "",
            revisionNumber: 1,
            createdAt: "2026-05-31T00:00:00.000Z",
            updatedAt: "2026-05-31T00:00:00.000Z",
          },
        ]),
      },
      runbookAction: {
        findMany: vi.fn(({ where }: { where: { runbookId: string } }) => {
          if (where.runbookId === existingRunbookId) {
            return [action];
          }

          return [];
        }),
      },
    });
    const artifact: DesktopRunbookExportArtifactV1 = {
      format: "bitsentry.runbooks.export",
      version: 1,
      exportedAt: "2026-05-31T00:00:00.000Z",
      runbooks: [
        {
          title: "Server health",
          actions: [
            {
              type: "shell",
              title: "Check disk",
              command: "df -h",
            },
          ],
        },
      ],
    };

    const summary = await store.importRunbooks({
      artifact,
      options: { dryRun: true },
    });

    expect(summary).toMatchObject({
      imported: 1,
      skipped: 0,
      failed: 0,
    });
    expect(summary.results[0]).toMatchObject({
      status: "imported",
      title: "Server health (imported)",
    });
  });

  it("skips matching runbook fingerprints when conflictPolicy is skip", async () => {
    const existingRunbookId = "runbook-existing";
    const action = {
      id: "action-existing",
      runbookId: existingRunbookId,
      sortOrder: 0,
      type: "shell",
      title: "Check disk",
      command: "df -h",
    };
    const { store } = createStore({
      runbook: {
        findMany: vi.fn(() => [
          {
            id: existingRunbookId,
            title: "Server health",
            description: "",
            revisionNumber: 1,
            createdAt: "2026-05-31T00:00:00.000Z",
            updatedAt: "2026-05-31T00:00:00.000Z",
          },
        ]),
      },
      runbookAction: {
        findMany: vi.fn(({ where }: { where: { runbookId: string } }) => {
          if (where.runbookId === existingRunbookId) {
            return [action];
          }

          return [];
        }),
      },
    });
    const artifact: DesktopRunbookExportArtifactV1 = {
      format: "bitsentry.runbooks.export",
      version: 1,
      exportedAt: "2026-05-31T00:00:00.000Z",
      runbooks: [
        {
          title: "Server health",
          actions: [
            {
              type: "shell",
              title: "Check disk",
              command: "df -h",
            },
          ],
        },
      ],
    };

    const summary = await store.importRunbooks({
      artifact,
      options: { conflictPolicy: "skip", dryRun: true },
    });

    expect(summary).toMatchObject({
      imported: 0,
      skipped: 1,
      failed: 0,
    });
    expect(summary.results[0]).toMatchObject({
      status: "skipped",
      runbookId: existingRunbookId,
      reason: 'same runbook actions already exist in "Server health"',
    });
  });

  it("includes plugin action fields in skip-conflict fingerprints", async () => {
    const existingRunbookId = "runbook-existing-plugin";
    const action = {
      id: "action-existing-plugin",
      runbookId: existingRunbookId,
      sortOrder: 0,
      type: "plugin",
      title: "Query GitHub issues",
      sourceId: "github",
      query: "list_issues",
      body: '{"owner":"bitsentry-ai","repo":"desktop"}',
      url: '{"token":"${globals.github_token}"}',
    };
    const { store } = createStore({
      runbook: {
        findMany: vi.fn(() => [
          {
            id: existingRunbookId,
            title: "Existing plugin runbook",
            description: "",
            revisionNumber: 1,
            createdAt: "2026-05-31T00:00:00.000Z",
            updatedAt: "2026-05-31T00:00:00.000Z",
          },
        ]),
      },
      runbookAction: {
        findMany: vi.fn(({ where }: { where: { runbookId: string } }) => {
          if (where.runbookId === existingRunbookId) {
            return [action];
          }

          return [];
        }),
      },
    });
    const artifact: DesktopRunbookExportArtifactV1 = {
      format: "bitsentry.runbooks.export",
      version: 1,
      exportedAt: "2026-05-31T00:00:00.000Z",
      runbooks: [
        {
          title: "Plugin runbook",
          actions: [
            {
              type: "plugin",
              title: "Query GitHub issues",
              pluginId: "github",
              pluginActionId: "list_issues",
              pluginInput: '{"owner":"bitsentry-ai","repo":"api"}',
              pluginAuth: '{"token":"${globals.github_token}"}',
            },
          ],
        },
      ],
    };

    const summary = await store.importRunbooks({
      artifact,
      options: { conflictPolicy: "skip", dryRun: true },
    });

    expect(summary).toMatchObject({
      imported: 1,
      skipped: 0,
      failed: 0,
    });
    expect(summary.results[0]).toMatchObject({
      status: "imported",
      title: "Plugin runbook",
    });
  });

  it("imports legacy external source actions without artifact externalSources", async () => {
    const { store, db } = createStore();
    const artifact: DesktopRunbookExportArtifactV1 = {
      format: "bitsentry.runbooks.export",
      version: 1,
      exportedAt: "2026-05-31T00:00:00.000Z",
      runbooks: [
        {
          title: "Retrieve issues",
          actions: [
            {
              type: "external_source",
              title: "Query GitHub issues",
              query: "is:issue is:open",
              sourceRef: "jagad",
              sourceName: "Jagad GitHub",
            },
          ],
        },
      ],
    };

    const summary = await store.importRunbooks({
      artifact,
      options: { dryRun: false },
    });

    expect(summary).toMatchObject({
      imported: 1,
      skipped: 0,
      failed: 0,
    });
    expect(summary.results[0].warnings).toContain(
      'Action "Query GitHub issues" references external source "Jagad GitHub" and should be reviewed in the target environment.',
    );
    const [createRunbookActionCall] = db.runbookAction.create.mock.calls;
    expect(createRunbookActionCall[0]).toMatchObject({
      data: {
        sourceId: null,
      },
    });
  });

  it("rejects external source actions that reference an undefined artifact sourceRef", async () => {
    const { store } = createStore();
    const artifact: DesktopRunbookExportArtifactV1 = {
      format: "bitsentry.runbooks.export",
      version: 1,
      exportedAt: "2026-05-31T00:00:00.000Z",
      runbooks: [
        {
          title: "Retrieve issues",
          actions: [
            {
              type: "external_source",
              title: "Query GitHub issues",
              query: "is:issue is:open",
              sourceRef: "jagad",
            },
          ],
        },
      ],
      externalSources: [
        {
          ref: "other",
          sourceType: "github",
          name: "Other",
          configuration: {
            owner: "other",
            repo: "issues",
          },
        },
      ],
    };

    await expect(
      store.importRunbooks({
        artifact,
        options: { dryRun: true },
      }),
    ).rejects.toThrow(
      'External Source action "Query GitHub issues" references sourceRef "jagad" but the import YAML does not define it under externalSources.',
    );
  });

  it("reuses an existing matching external source even when YAML credentials are blank", async () => {
    const existingSourceId = "source-existing";
    const { store, db } = createStore({
      errorSource: {
        findMany: vi.fn(() => [
          {
            id: existingSourceId,
            sourceType: "github",
            name: "Jagad GitHub",
            accessTokenRef: "stored-token",
            refreshTokenRef: null,
            expiresAt: null,
            grantedScopes: "[]",
            configuration: JSON.stringify({
              owner: "jagad",
              repo: "api",
            }),
            logLevelThreshold: "error",
            additionalMetadata: null,
            syncEnabled: false,
            autoDiagnosisEnabled: false,
            lastSyncAt: null,
            lastSyncStatus: null,
            lastSyncError: null,
            createdAt: "2026-05-31T00:00:00.000Z",
            updatedAt: "2026-05-31T00:00:00.000Z",
          },
        ]),
      },
    });

    const artifact: DesktopRunbookExportArtifactV1 = {
      format: "bitsentry.runbooks.export",
      version: 1,
      exportedAt: "2026-05-31T00:00:00.000Z",
      runbooks: [
        {
          title: "Retrieve issues from Jagad",
          actions: [
            {
              type: "external_source",
              title: "Query GitHub issues",
              query: "is:issue is:open label:backend",
              sourceRef: "jagad",
              sourceName: "Jagad GitHub",
              sourceType: "github",
            },
          ],
        },
      ],
      externalSources: [
        {
          ref: "jagad",
          sourceType: "github",
          name: "Jagad GitHub",
          configuration: {
            owner: "jagad",
            repo: "api",
          },
          credentials: {
            authToken: "",
          },
          credentialsRedacted: true,
        },
      ],
    };

    const summary = await store.importRunbooks({
      artifact,
      options: { dryRun: false },
    });

    expect(summary).toMatchObject({
      imported: 1,
      skipped: 0,
      failed: 0,
    });
    expect(
      db.errorSource.create as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
    const [createRunbookActionCall] = db.runbookAction.create.mock.calls;
    expect(createRunbookActionCall[0]).toMatchObject({
      data: {
        sourceId: existingSourceId,
      },
    });
  });

  it("imports external sources without plugin-specific auth enforcement", async () => {
    const { store, db } = createStore();
    const artifact: DesktopRunbookExportArtifactV1 = {
      format: "bitsentry.runbooks.export",
      version: 1,
      exportedAt: "2026-05-31T00:00:00.000Z",
      runbooks: [
        {
          title: "Retrieve issues from Jagad",
          actions: [
            {
              type: "external_source",
              title: "Query GitHub issues",
              query: "is:issue is:open label:backend",
              sourceRef: "jagad",
              sourceName: "Jagad GitHub",
              sourceType: "github",
            },
          ],
        },
      ],
      externalSources: [
        {
          ref: "jagad",
          sourceType: "github",
          name: "Jagad GitHub",
          configuration: {
            owner: "jagad",
            repo: "api",
          },
        },
      ],
    };

    const summary = await store.importRunbooks({
      artifact,
      options: { dryRun: false },
    });

    expect(summary).toMatchObject({
      imported: 1,
      skipped: 0,
      failed: 0,
    });
    const [createSourceCall] = db.errorSource.create.mock.calls;
    expect(createSourceCall[0].data).toMatchObject({
      sourceType: "github",
      name: "Jagad GitHub",
      accessTokenRef: null,
      refreshTokenRef: null,
    });
    const [createRunbookActionCall] = db.runbookAction.create.mock.calls;
    expect(createRunbookActionCall[0]).toMatchObject({
      data: {
        sourceId: createSourceCall[0].data.id,
      },
    });
  });

  it("rejects external source actions that omit sourceRef", async () => {
    const { store } = createStore();
    const artifact: DesktopRunbookExportArtifactV1 = {
      format: "bitsentry.runbooks.export",
      version: 1,
      exportedAt: "2026-05-31T00:00:00.000Z",
      runbooks: [
        {
          title: "Retrieve issues",
          actions: [
            {
              type: "external_source",
              title: "Query GitHub issues",
              query: "is:issue is:open",
            },
          ],
        },
      ],
      externalSources: [
        {
          ref: "jagad",
          sourceType: "github",
          name: "Jagad GitHub",
          configuration: {
            owner: "jagad",
            repo: "api",
          },
          credentials: {
            authToken: "",
          },
        },
      ],
    };

    await expect(
      store.importRunbooks({
        artifact,
        options: { dryRun: true },
      }),
    ).rejects.toThrow(
      'External Source action "Query GitHub issues" is missing sourceRef in the import YAML.',
    );
  });
});
