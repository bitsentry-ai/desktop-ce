import {
  createDesktopEditionRunbookRuntimeBindings,
  createDesktopEditionRunbookRuntimeFactory,
  type DesktopRunbookRuntimeExecutionService,
  type DesktopRunbookRuntimeDatabase,
  type DesktopRunbookRuntimeHandlers,
  type DesktopRunbookRuntimeOptions,
} from "@bitsentry-ce/core/features/runbooks/desktop-runbook-runtime";
import { DesktopGlobalVariablesService } from "@bitsentry-ce/core/features/runbooks";
import { closeDatabase, initializeDatabase } from "./database-index";
import { createDesktopYamlRunbookHandlers as createRunbookHandlers } from "@bitsentry-ce/core/features/runbooks/desktop-runbook-handler-yaml-bindings";
import { ExternalSourceRunbookQueryService } from "@bitsentry-ce/core/features/error-sources";
import {
  SqliteRunbookResultStore,
  DEFAULT_RUNBOOK_EXECUTION_HEARTBEAT_GRACE_MS,
} from "@bitsentry-ce/core/features/runbooks/desktop-runbook-result.store";
import {
  createDesktopAgentLlmAdapter,
  type AgentLlmCredentialsStore,
} from "@bitsentry-ce/coding-agents";
import path from "path";
import { DesktopRunbookStore as RunbookStore } from "@bitsentry-ce/core/features/runbooks/desktop-runbook.store";
import { CodingAgentsProviderService } from "./desktop-coding-agents";
import { SqliteErrorSourcesRepositoryAdapter } from "@bitsentry-ce/core/features/error-sources/desktop-sqlite-error-sources.adapter";
import {
  approveRunbookExportPath,
  approveRunbookImportPaths,
} from "@bitsentry-ce/core/features/runbooks/desktop-trusted-runbook-paths";
import {
  createDesktopNodePluginRuntimeService,
  resolveDesktopPluginDirectories,
} from "@bitsentry-ce/core/features/plugins/node";
import {
  getRuntimeUserDataPath,
  setRuntimeDefaultAppDataName,
} from "./runtime-paths";
import { LocalPluginCredentialsStore } from "./plugin-credentials-store";

type DesktopRunbookDatabase = Awaited<ReturnType<typeof initializeDatabase>> &
  DesktopRunbookRuntimeDatabase;

async function initializeRunbookDatabase(): Promise<DesktopRunbookDatabase> {
  return (await initializeDatabase()) as DesktopRunbookDatabase;
}

const createRuntimeRunbookHandlers = (
  db: DesktopRunbookDatabase,
  args: Parameters<typeof createRunbookHandlers>[1],
): DesktopRunbookRuntimeHandlers => createRunbookHandlers(db, args);

type DesktopRunbookExecutionServiceClass = new (
  runbookStore: InstanceType<typeof RunbookStore>,
  globalVariablesService: DesktopGlobalVariablesService,
  agentLlmAdapter: ReturnType<typeof createDesktopAgentLlmAdapter>,
  externalSourceRunbookQueryService: InstanceType<
    typeof ExternalSourceRunbookQueryService
  >,
  runbookResultStore: InstanceType<typeof SqliteRunbookResultStore>,
  windowGetter: () => null,
  executionOptions: undefined,
  localAiProvider: InstanceType<typeof CodingAgentsProviderService>,
) => DesktopRunbookRuntimeExecutionService;

type CreateDesktopEditionRunbookRuntimeFactoryOptions = {
  RunbookExecutionService: DesktopRunbookExecutionServiceClass;
  setRuntimeUserDataPath(userDataPath: string): void;
  defaultAppDataName?: string;
  createLlmProviderCredentialsStore?: () => AgentLlmCredentialsStore;
};

export { type DesktopRunbookRuntimeOptions };

export function createDesktopEditionRunbookRuntime(
  options: CreateDesktopEditionRunbookRuntimeFactoryOptions,
): ReturnType<typeof createDesktopEditionRunbookRuntimeFactory> {
  if (options.defaultAppDataName !== undefined) {
    setRuntimeDefaultAppDataName(options.defaultAppDataName);
  }

  const bindings = createDesktopEditionRunbookRuntimeBindings({
    defaultStaleHeartbeatGraceMs: DEFAULT_RUNBOOK_EXECUTION_HEARTBEAT_GRACE_MS,
    initializeDatabase: initializeRunbookDatabase,
    closeDatabase,
    setRuntimeUserDataPath(userDataPath: string) {
      options.setRuntimeUserDataPath(userDataPath);
    },
    createAgentLlmAdapter(db: DesktopRunbookDatabase) {
      return createDesktopAgentLlmAdapter(
        db,
        options.createLlmProviderCredentialsStore?.(),
      );
    },
    GlobalVariablesService: DesktopGlobalVariablesService,
    RunbookStore,
    ErrorSourcesRepositoryAdapter: SqliteErrorSourcesRepositoryAdapter,
    ExternalSourceRunbookQueryService,
    RunbookResultStore: SqliteRunbookResultStore,
    LocalAiProvider: CodingAgentsProviderService,
    RunbookExecutionService: options.RunbookExecutionService,
    createPluginRuntime() {
      const userDataPath = getRuntimeUserDataPath();
      return createDesktopNodePluginRuntimeService(
        resolveDesktopPluginDirectories([path.join(userDataPath, "plugins")]),
        new LocalPluginCredentialsStore(userDataPath),
      );
    },
    createRunbookHandlers: createRuntimeRunbookHandlers,
    approveRunbookExportPath,
    approveRunbookImportPaths,
  });

  return createDesktopEditionRunbookRuntimeFactory(bindings);
}
