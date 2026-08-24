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

function createStore(
  dbOverrides?: Partial<Record<string, unknown>>,
  errorSourceCredentialsStore?: {
    get: (sourceId: string) => Promise<{ accessToken: string | null; refreshToken: string | null }>;
    set: (sourceId: string, credentials: { accessToken: string | null; refreshToken: string | null }) => Promise<void>;
    clear: (sourceId: string) => Promise<void>;
  },
) {
  const db = createDb(dbOverrides);
  const globalVariablesService = {
    list: vi.fn(() => []),
  };

  return {
    db,
    store: new RunbookStore(
      db as never,
      globalVariablesService as never,
      errorSourceCredentialsStore,
    ),
  };
}

describe("RunbookStore exportRunbooks", () => {
  it("exports redacted credential metadata from encrypted storage", async () => {
    const credentialsStore = {
      get: vi.fn().mockResolvedValue({
        accessToken: "stored-access-token",
        refreshToken: "stored-refresh-token",
      }),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    const source = {
      id: "source-1",
      sourceType: "sentry",
      name: "Sentry",
      accessTokenRef: null,
      refreshTokenRef: null,
      expiresAt: null,
      grantedScopes: JSON.stringify([]),
      configuration: JSON.stringify({ organization: "bitsentry" }),
      logLevelThreshold: "error",
      additionalMetadata: JSON.stringify({ pluginId: "sentry" }),
      syncEnabled: true,
      autoDiagnosisEnabled: false,
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
      createdAt: "2026-05-31T00:00:00.000Z",
      updatedAt: "2026-05-31T00:00:00.000Z",
    };
    const { store } = createStore(
      {
        runbook: {
          findUnique: vi.fn(() => ({
            id: "runbook-1",
            title: "Sentry triage",
            description: "",
            revisionNumber: 1,
            createdAt: "2026-05-31T00:00:00.000Z",
            updatedAt: "2026-05-31T00:00:00.000Z",
          })),
        },
        runbookAction: {
          findMany: vi.fn(() => [
            {
              id: "action-1",
              runbookId: "runbook-1",
              sortOrder: 0,
              type: "external_source",
              title: "Query Sentry",
              query: "is:unresolved",
              sourceId: "source-1",
            },
          ]),
        },
        errorSource: {
          findUnique: vi.fn(() => source),
        },
      },
      credentialsStore,
    );

    const artifact = await store.exportRunbooks({ ids: ["runbook-1"] });
    const exportedSource = artifact.externalSources?.[0];

    expect(exportedSource).toMatchObject({
      ref: "sentry",
      credentialsRedacted: true,
      credentials: {
        authToken: "",
        refreshToken: "",
      },
    });
    expect(JSON.stringify(artifact)).not.toContain("stored-access-token");
    expect(JSON.stringify(artifact)).not.toContain("stored-refresh-token");
  });
});

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

  it("omits empty plugin auth after import round-trip", async () => {
    const storedRunbooks: Array<Record<string, unknown>> = [];
    const storedActions: Array<Record<string, unknown>> = [];
    const { store } = createStore({
      runbook: {
        findMany: vi.fn(() => storedRunbooks),
        findUnique: vi.fn(({ where }: { where: { id: string } }) =>
          storedRunbooks.find((runbook) => runbook.id === where.id) ?? null),
        create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
          const row = { deletedAt: null, ...data };
          storedRunbooks.push(row);
          return row;
        }),
      },
      runbookAction: {
        findMany: vi.fn(({ where }: { where: { runbookId: string } }) =>
          storedActions.filter((action) => action.runbookId === where.runbookId)),
        create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
          storedActions.push(data);
          return data;
        }),
      },
    });
    const artifact: DesktopRunbookExportArtifactV1 = {
      format: "bitsentry.runbooks.export",
      version: 1,
      exportedAt: "2026-05-31T00:00:00.000Z",
      runbooks: [
        {
          title: "Empty auth runbook",
          actions: [
            {
              type: "plugin",
              title: "Query GitHub issues",
              pluginId: "github",
              pluginActionId: "list_issues",
              pluginInput: '{"owner":"bitsentry-ai","repo":"api"}',
              pluginAuth: "",
            },
          ],
        },
      ],
    };

    const summary = await store.importRunbooks({
      artifact,
      options: { dryRun: false },
    });

    expect(summary).toMatchObject({ imported: 1, skipped: 0, failed: 0 });
    expect(storedActions[0]).toMatchObject({ url: null });
    const imported = await store.get(String(storedRunbooks[0].id));
    expect(imported?.actions[0]?.pluginAuth).toBeUndefined();
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

  it("stores imported external-source credentials outside the SQLite row", async () => {
    const credentialsStore = {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    const { store, db } = createStore(undefined, credentialsStore);
    const artifact: DesktopRunbookExportArtifactV1 = {
      format: "bitsentry.runbooks.export",
      version: 1,
      exportedAt: "2026-05-31T00:00:00.000Z",
      runbooks: [
        {
          title: "Query imported Sentry source",
          actions: [
            {
              type: "external_source",
              title: "Query Sentry",
              query: "is:unresolved",
              sourceRef: "jagad",
            },
          ],
        },
      ],
      externalSources: [
        {
          ref: "jagad",
          sourceType: "sentry",
          name: "Jagad Sentry",
          configuration: {},
          credentials: { authToken: "import-token" },
        },
      ],
    };

    await store.importRunbooks({ artifact, options: { dryRun: false } });

    expect(credentialsStore.set).toHaveBeenCalledWith(expect.any(String), {
      accessToken: "import-token",
      refreshToken: null,
    });
    const [createSourceCall] = db.errorSource.create.mock.calls;
    expect(createSourceCall[0].data).toMatchObject({
      accessTokenRef: null,
      refreshTokenRef: null,
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

describe("Runbook import handlers", () => {
  it("passes encrypted credential storage to the IPC import store", async () => {
    const db = createDb();
    const credentialsStore = {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    const handlers = createRunbookHandlers(
      db as never,
      {
        executionService: {} as never,
        globalVariablesService: { list: vi.fn(() => []) } as never,
        errorSourceCredentialsStore: credentialsStore,
      },
      { edition: "ce" },
    );

    await handlers["runbooks:import"]({
      artifact: {
        format: "bitsentry.runbooks.export",
        version: 1,
        exportedAt: "2026-06-15T00:00:00.000Z",
        runbooks: [
          {
            title: "Imported Sentry triage",
            actions: [
              {
                type: "external_source",
                title: "Query Sentry",
                query: "is:unresolved",
                sourceRef: "sentry",
                sourceType: "sentry",
              },
            ],
          },
        ],
        externalSources: [
          {
            ref: "sentry",
            sourceType: "sentry",
            name: "Sentry",
            configuration: {},
            credentials: { authToken: "imported-token" },
          },
        ],
      },
      options: { dryRun: false },
    });

    expect(credentialsStore.set).toHaveBeenCalledWith(expect.any(String), {
      accessToken: "imported-token",
      refreshToken: null,
    });
    const createCall = (db.errorSource.create as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(createCall?.data).toMatchObject({
      accessTokenRef: null,
      refreshTokenRef: null,
    });
  });

  it("starts GUI executions through the runbook gateway", async () => {
    const db = createDb({
      auditLog: { create: vi.fn(() => undefined) },
    });
    const executionService = {
      start: vi.fn(),
      get: vi.fn(),
      cancel: vi.fn(),
    };
    const runbookGateway = {
      start: vi.fn(async (request: { source: string; runbookId: string }) => {
        if (request.source !== "manual" || request.runbookId !== "rb-gui") {
          throw new Error("Unexpected GUI execution request");
        }
        return {
          executionId: "10000000-0000-4000-8000-000000000001",
          resultId: "result-gui",
        };
      }),
      get: vi.fn(),
      cancel: vi.fn(),
    };
    const handlers = createRunbookHandlers(
      db as never,
      {
        executionService: executionService as never,
        globalVariablesService: { list: vi.fn(() => []) } as never,
      },
      { edition: "ce", runbookGateway: runbookGateway as never },
    );

    await expect(
      handlers["runbooks:execute"]({
        runbookId: "rb-gui",
        incidentThreadId: "incident-gui",
        requestKey: "renderer-action-1",
      }),
    ).resolves.toMatchObject({
      executionId: "10000000-0000-4000-8000-000000000001",
      resultId: "result-gui",
    });
  });

  it("rejects Pro-only LLM providers in CE imports", async () => {
    const db = createDb();
    const executionService = {};
    const globalVariablesService = {
      list: vi.fn(() => []),
    };
    const handlers = createRunbookHandlers(
      db as never,
      {
        executionService: executionService as never,
        globalVariablesService: globalVariablesService as never,
      },
      { edition: "ce" },
    );

    await expect(
      handlers["runbooks:import"]({
        artifact: {
          format: "bitsentry.runbooks.export",
          version: 1,
          exportedAt: "2026-06-15T00:00:00.000Z",
          runbooks: [
            {
              title: "Kanye Rest",
              actions: [
                {
                  type: "llm",
                  title: "What did kanye say?",
                  prompt: "Make a philosophical break down of what Kanye said.",
                  llmProviderKey: "groq",
                  llmModel: "openai/gpt-oss-20b",
                },
              ],
            },
          ],
        },
        options: { dryRun: true },
      }),
    ).rejects.toThrow(
      'Runbook "Kanye Rest" action "What did kanye say?" uses unsupported LLM provider "groq". Supported providers: claude_code, codex, opencode, cursor.',
    );
  });
});
