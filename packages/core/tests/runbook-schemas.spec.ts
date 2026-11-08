import {
  applyRunbookLogFilter,
  collectRunbookGlobalReferences,
  createImportedRunbookTitle,
  exportRunbooksInputSchema,
  exportRunbookContextOutputSchema,
  exportedGlobalVariableV1Schema,
  findDuplicateRunbookActionId,
  importRunbooksInputSchema,
  logFilterConfigSchema,
  normalizeRunbookImportOptions,
  previewRunbookLogFilter,
  runbookActionParameterSchema,
  runbookExportArtifactV1Schema,
  runbookResolvedGlobalsSchema,
  runbookWorkerExecutionContextResponseSchema,
  RunbookLogFilterError,
  validateRunbookLogFilterConfig,
} from "../src/features/runbooks/index";
import { expect, it } from "vitest";

it("keeps secure parameters free of plaintext defaults", () => {
  expect(
    runbookActionParameterSchema.safeParse({
      id: "param-1",
      key: "api_token",
      secure: true,
    }).success,
    "runbook action parameter schema should accept secure metadata",
  ).toBe(true);

  expect(
    !runbookActionParameterSchema.safeParse({
      id: "param-1",
      key: "api_token",
      secure: true,
      defaultValue: "secret-token",
    }).success,
    "runbook action parameter schema should reject plaintext defaults on secure parameters",
  ).toBe(true);
});

it("accepts only named-group log filters with supported, unique flags", () => {
  expect(
    logFilterConfigSchema.safeParse({
      pattern: "(?<active>\\d+)",
      flags: "imsu",
      match: "first",
    }).success,
    "log filter schema should accept named-group regex config",
  ).toBe(true);

  expect(
    !logFilterConfigSchema.safeParse({
      pattern: "(\\d+)",
    }).success,
    "log filter schema should reject patterns without named capture groups",
  ).toBe(true);

  expect(
    !logFilterConfigSchema.safeParse({
      pattern: "(?<active>\\d+)",
      flags: "g",
    }).success,
    "log filter schema should reject unsupported regex flags",
  ).toBe(true);

  expect(
    !logFilterConfigSchema.safeParse({
      pattern: "(?<active>\\d+)",
      flags: "ii",
    }).success,
    "log filter schema should reject duplicate regex flags",
  ).toBe(true);
});

it("extracts first, all, multiline and missing log filter matches", () => {
  const firstMatchFilter = applyRunbookLogFilter("active=47\ntrace=abc-123", {
    pattern: "active=(?<active_connections>\\d+)",
    match: "first",
  });
  expect(
    firstMatchFilter.structuredOutput.active_connections === "47",
    "log filter should capture the first named-group match",
  ).toBe(true);

  const allMatchFilter = applyRunbookLogFilter("trace=abc-123\ntrace=def-456", {
    pattern: "trace=(?<trace_id>[a-z0-9-]+)",
    match: "all",
    maxMatches: 5,
  });
  expect(
    JSON.stringify(allMatchFilter.structuredOutput.trace_id) ===
      JSON.stringify(["abc-123", "def-456"]),
    "log filter should collect all matches into arrays",
  ).toBe(true);

  const multilineFilter = applyRunbookLogFilter("service=api\nstatus=down", {
    pattern: "^service=(?<service>.+)$\\n^status=(?<status>.+)$",
    multiline: true,
    match: "first",
  });
  expect(
    multilineFilter.structuredOutput.service === "api" &&
      multilineFilter.structuredOutput.status === "down",
    "log filter should support multiline extraction",
  ).toBe(true);

  const noMatchFilter = applyRunbookLogFilter("service=api", {
    pattern: "active=(?<active_connections>\\d+)",
    match: "first",
  });
  expect(
    !noMatchFilter.metadata.matched &&
      noMatchFilter.metadata.matchCount === 0 &&
      Object.keys(noMatchFilter.structuredOutput).length === 0,
    "log filter should report explicit no-match metadata",
  ).toBe(true);

  let invalidFilterError: unknown;
  try {
    applyRunbookLogFilter("value=1", {
      pattern: "(?<broken>\\d+",
    });
  } catch (error) {
    invalidFilterError = error;
  }
  expect(
    invalidFilterError instanceof RunbookLogFilterError,
    "invalid log filter config should throw a typed runtime error",
  ).toBe(true);

  const validationErrors = validateRunbookLogFilterConfig({
    pattern: "(\\d+)",
  });
  expect(
    validationErrors.length > 0,
    "log filter validation helper should surface schema errors",
  ).toBe(true);

  const preview = previewRunbookLogFilter("trace=abc-123", {
    pattern: "trace=(?<trace_id>[a-z0-9-]+)",
  });
  expect(
    preview.structuredOutput?.trace_id === "abc-123" && preview.matchCount === 1,
    "log filter preview helper should reuse extraction behavior",
  ).toBe(true);
});

it("exports secure globals and source credentials only as redacted stubs", () => {
  expect(
    exportedGlobalVariableV1Schema.safeParse({
      key: "incident_webhook",
      secure: true,
      redacted: true,
    }).success,
    "exported secure global schema should accept redacted stubs",
  ).toBe(true);

  expect(
    !exportedGlobalVariableV1Schema.safeParse({
      key: "incident_webhook",
      secure: true,
      value: "secret",
    }).success,
    "exported secure global schema should reject plaintext secure values",
  ).toBe(true);

  expect(
    runbookExportArtifactV1Schema.safeParse({
      format: "bitsentry.runbooks.export",
      version: 1,
      exportedAt: "2026-04-13T00:00:00.000Z",
      runbooks: [
        {
          id: "runbook-1",
          title: "Check active connections",
          revisionNumber: 4,
          actions: [
            {
              id: "action-1",
              type: "external_source",
              title: "Search GitHub issues",
              query: "is:issue is:open",
              sourceId: "source-1",
              sourceRef: "github-issues",
              sourceName: "GitHub Issues",
              sourceType: "github",
              logFilter: {
                pattern: "(?<issue_count>\\d+)",
              },
              parameters: [
                {
                  id: "parameter-1",
                  key: "query",
                },
              ],
            },
            {
              id: "action-2",
              type: "plugin",
              title: "List GitHub issues",
              pluginId: "github",
              pluginActionId: "list_issues",
              pluginInput:
                "{\"owner\":\"bitsentry-ai\",\"repo\":\"monorepo\",\"limit\":10}",
              pluginAuth: "{\"token\":\"${globals.github_token}\"}",
            },
          ],
        },
      ],
      globals: [
        {
          key: "incident_webhook",
          secure: true,
          redacted: true,
        },
        {
          key: "github_token",
          secure: true,
          redacted: true,
        },
      ],
      externalSources: [
        {
          ref: "github-issues",
          sourceType: "github",
          name: "GitHub Issues",
          configuration: {
            owner: "bitsentry-ai",
            repo: "monorepo",
          },
          credentials: {
            authToken: "",
          },
          credentialsRedacted: true,
        },
      ],
    }).success,
    "runbook export artifact schema should include secure metadata, log filters, and external source definitions",
  ).toBe(true);
});

it("drops plugin auth from exported context but keeps it for the worker execution context", () => {
  const exportedContextResult = exportRunbookContextOutputSchema.safeParse({
    format: "bitsentry.runbook.context",
    version: 1,
    runbook: {
      id: "runbook-1",
      title: "Context export",
      description: "Checks global references",
      revisionNumber: 3,
      updatedAt: "2026-04-15T00:00:00.000Z",
      actionCount: 2,
    },
    summary: {
      purposeText: "Checks global references",
      actionTypeCounts: {
        shell: 1,
        llm: 0,
        http: 0,
        plugin: 1,
        external_source: 0,
        telemetry_existing_entry: 0,
        data_source_query: 0,
        telemetry_ingest: 0,
        diagnosis: 0,
      },
      orderedActionTitles: ["Echo env", "List GitHub issues"],
    },
    globalReferences: [
      {
        key: "environment",
        description: "Deployment target",
      },
      {
        key: "incident_api_token",
        secure: true,
      },
      {
        key: "github_token",
        secure: true,
      },
    ],
    actions: [
      {
        id: "action-1",
        order: 1,
        type: "shell",
        title: "Echo env",
        payload: {
          command: "echo ${globals.environment}",
        },
      },
      {
        id: "action-2",
        order: 2,
        type: "plugin",
        title: "List GitHub issues",
        payload: {
          pluginId: "github",
          pluginActionId: "list_issues",
          pluginInput:
            "{\"owner\":\"bitsentry-ai\",\"repo\":\"monorepo\",\"limit\":5}",
          pluginAuth: "{\"token\":\"${globals.github_token}\"}",
        },
      },
    ],
  });

  expect(
    exportedContextResult.success,
    "runbook context export schema should accept plugin metadata",
  ).toBe(true);
  expect(
    exportedContextResult.success &&
      exportedContextResult.data !== null &&
      !Object.prototype.hasOwnProperty.call(
        exportedContextResult.data.actions[1].payload,
        "pluginAuth",
      ),
    "runbook context export schema should drop plugin auth",
  ).toBe(true);

  expect(
    runbookResolvedGlobalsSchema.safeParse({
      values: {
        environment: "production",
        incident_api_token: "secret-token",
      },
      definitions: [
        { key: "environment" },
        { key: "incident_api_token", secure: true },
      ],
    }).success,
    "resolved globals schema should accept transient execution payloads",
  ).toBe(true);

  const workerContextResult =
    runbookWorkerExecutionContextResponseSchema.safeParse({
      executionId: "execution-1",
      userId: 1,
      runbookId: "runbook-1",
      runbookTitle: "Runbook",
      claimToken: "claim-token",
      snapshot: {
        executionId: "execution-1",
        runbookId: "runbook-1",
        runbookTitle: "Runbook",
        status: "queued",
        startedAt: "2026-04-15T00:00:00.000Z",
        source: "manual",
        steps: [],
      },
      context: {
        format: "bitsentry.runbook.context",
        version: 1,
        runbook: {
          id: "runbook-1",
          title: "Runbook",
          description: "Checks globals",
          revisionNumber: 1,
          updatedAt: "2026-04-15T00:00:00.000Z",
          actionCount: 2,
        },
        summary: {
          purposeText: "Checks globals",
          actionTypeCounts: {
            shell: 1,
            llm: 0,
            http: 0,
            plugin: 1,
            external_source: 0,
            telemetry_existing_entry: 0,
            data_source_query: 0,
            telemetry_ingest: 0,
            diagnosis: 0,
          },
          orderedActionTitles: ["Echo env", "List GitHub issues"],
        },
        actions: [
          {
            id: "action-1",
            order: 1,
            type: "shell",
            title: "Echo env",
            payload: {
              command: "echo ${globals.environment}",
            },
          },
          {
            id: "action-2",
            order: 2,
            type: "plugin",
            title: "List GitHub issues",
            payload: {
              pluginId: "github",
              pluginActionId: "list_issues",
              pluginInput:
                "{\"owner\":\"bitsentry-ai\",\"repo\":\"monorepo\",\"limit\":5}",
              pluginAuth: "{\"token\":\"${globals.github_token}\"}",
            },
          },
        ],
      },
      resolvedGlobals: {
        values: {
          environment: "production",
          github_token: "secret-token",
        },
        definitions: [
          { key: "environment" },
          { key: "github_token", secure: true },
        ],
      },
    });

  expect(
    workerContextResult.success,
    "worker execution context schema should require resolved globals",
  ).toBe(true);
  expect(
    workerContextResult.success &&
      workerContextResult.data.context.actions[1].payload.pluginId === "github" &&
      workerContextResult.data.context.actions[1].payload.pluginActionId ===
        "list_issues" &&
      workerContextResult.data.context.actions[1].payload.pluginInput !==
        undefined &&
      workerContextResult.data.context.actions[1].payload.pluginAuth !==
        undefined,
    "worker execution context schema should retain all plugin fields",
  ).toBe(true);
});

it("validates runbook import and export inputs and helpers", () => {
  expect(
    exportRunbooksInputSchema.safeParse({
      ids: ["runbook-1"],
    }).success,
    "export runbooks input schema should require at least one runbook id",
  ).toBe(true);

  expect(
    importRunbooksInputSchema.safeParse({
      artifact: {
        format: "bitsentry.runbooks.export",
        version: 1,
        exportedAt: "2026-04-15T00:00:00.000Z",
        runbooks: [
          {
            id: "runbook-1",
            title: "Imported runbook",
            actions: [
              {
                id: "action-1",
                type: "external_source",
                title: "Import external source",
                sourceId: "source-1",
              },
              {
                id: "action-2",
                type: "plugin",
                title: "Import plugin action",
                pluginId: "github",
                pluginActionId: "list_issues",
                pluginInput:
                  "{\"owner\":\"bitsentry-ai\",\"repo\":\"monorepo\"}",
              },
            ],
          },
        ],
      },
    }).success,
    "import runbooks input schema should accept valid artifacts with preserved ids and source ids",
  ).toBe(true);

  const normalizedImportOptions = normalizeRunbookImportOptions({
    preserveIds: true,
  });
  expect(
    normalizedImportOptions.conflictPolicy === "duplicate" &&
      !normalizedImportOptions.includeGlobals &&
      normalizedImportOptions.preserveIds,
    "import option helper should apply defaults without losing explicit flags",
  ).toBe(true);

  const globalRefs = collectRunbookGlobalReferences({
    actions: [
      {
        type: "http",
        title: "Call API",
        url: "https://${globals.api_host}/health",
        headers: [{ key: "Authorization", value: "Bearer ${globals.api_token}" }],
      },
    ],
  });
  expect(
    JSON.stringify(globalRefs) === JSON.stringify(["api_host", "api_token"]),
    "global reference helper should detect references in URLs and headers",
  ).toBe(true);

  const pluginGlobalRefs = collectRunbookGlobalReferences({
    actions: [
      {
        type: "plugin",
        title: "Query GitHub issues",
        pluginId: "github",
        pluginActionId: "list_issues",
        pluginInput:
          "{\"owner\":\"bitsentry-ai\",\"repo\":\"monorepo\",\"limit\":\"${globals.issue_limit}\"}",
        pluginAuth: "{\"token\":\"${globals.github_token}\"}",
      },
    ],
  });
  expect(
    JSON.stringify(pluginGlobalRefs) ===
      JSON.stringify(["github_token", "issue_limit"]),
    "global reference helper should detect references in plugin auth and input payloads",
  ).toBe(true);

  const duplicateActionId = findDuplicateRunbookActionId({
    actions: [
      {
        id: "action-1",
        type: "shell",
        title: "Step 1",
        command: "echo first",
      },
      {
        id: "action-1",
        type: "shell",
        title: "Step 2",
        command: "echo second",
      },
    ],
  });
  expect(
    duplicateActionId === "action-1",
    "duplicate action id helper should detect repeated preserved action ids within one runbook",
  ).toBe(true);

  const importedTitle = createImportedRunbookTitle("Count connections", [
    "Count connections",
    "Count connections (imported)",
  ]);
  expect(
    importedTitle === "Count connections (imported 2)",
    "duplicate title helper should create deterministic imported suffixes",
  ).toBe(true);
  expect(importedTitle).toBe("Count connections (imported 2)");
});
