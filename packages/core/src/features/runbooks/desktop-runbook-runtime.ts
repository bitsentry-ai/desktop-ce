import type {
  RunbookExecutionRecord,
  RunbookRecord,
} from "./desktop-runbook.types";
import type {
  RunbookExportArtifactV1,
  RunbookImportOptions,
  RunbookImportSummary,
} from "./export.schemas";
import type { DesktopPluginRuntimeService } from "../plugins/desktop-plugin-registry";
import type { ErrorSourceType } from "../error-sources/desktop-error-sources.types";

export interface ExecuteRunbookInput {
  runbookId: string;
  parameterValues?: Record<string, string>;
  incidentThreadId?: string;
  accessLevel?: "supervised" | "auto-accept-edits" | "full-access";
  triggerContext?: {
    entrypoint:
      | "runbooks"
      | "incident_detail"
      | "incident_workspace"
      | "diagnosis";
    needId?: string;
    needLabel?: string;
    sourceId?: string;
    sourceName?: string;
    sourceType?: ErrorSourceType;
    incidentThreadId?: string;
  };
}

interface WaitForExecutionOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface DesktopRunbookRuntimeOptions {
  userDataPath?: string;
  staleHeartbeatGraceMs?: number;
}

export interface DesktopRunbookRuntimeDatabase {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
}

export interface DesktopRunbookRuntimeExecutionService {
  destroy(): Promise<void>;
}

export interface DesktopRunbookRuntimeHandlers {
  "runbooks:list": (payload?: unknown) => Promise<RunbookRecord[]>;
  "runbooks:get": (payload?: unknown) => Promise<RunbookRecord | null>;
  "runbooks:delete": (payload?: unknown) => Promise<{ ok: true }>;
  "runbooks:export": (payload?: unknown) => Promise<RunbookExportArtifactV1>;
  "runbooks:exportToFile": (payload?: unknown) => Promise<{
    ok: true;
    filePath: string;
    count: number;
  }>;
  "runbooks:importFromFile": (
    payload?: unknown,
  ) => Promise<RunbookImportSummary>;
  "runbooks:execute": (
    payload?: unknown,
  ) => Promise<{ executionId: string; resultId: string }>;
  "runbooks:getExecution": (
    payload?: unknown,
  ) => Promise<RunbookExecutionRecord | null>;
  "runbooks:cancelExecution": (payload?: unknown) => Promise<unknown>;
}

export interface DesktopRunbookRuntimeDependencies {
  db: DesktopRunbookRuntimeDatabase;
  runbookHandlers: DesktopRunbookRuntimeHandlers;
  executionService: DesktopRunbookRuntimeExecutionService;
  closeDatabase(): Promise<void>;
  approveRunbookExportPath(filePath: string): void;
  approveRunbookImportPaths(filePaths: string[]): void;
}

export interface DesktopRunbookRuntimeResultStore {
  markStaleRunningSessionsFailed(args: {
    heartbeatGraceMs: number;
  }): Promise<unknown>;
}

export interface DesktopRunbookRuntimeLocalAiProvider {
  loadSettings(): Promise<unknown>;
}

export interface DesktopRunbookRuntimeAgentLlmAdapter<TLocalAiProvider> {
  setLocalAiProvider(provider: TLocalAiProvider): void;
}

export interface DesktopRunbookRuntimeCreateBindings<
  TDb extends DesktopRunbookRuntimeDatabase,
  TGlobalVariablesService,
  TRunbookStore,
  TExternalSourceRunbookQueryService,
  TRunbookResultStore extends DesktopRunbookRuntimeResultStore,
  TLocalAiProvider extends DesktopRunbookRuntimeLocalAiProvider,
  TAgentLlmAdapter extends DesktopRunbookRuntimeAgentLlmAdapter<TLocalAiProvider>,
  TExecutionService extends DesktopRunbookRuntimeExecutionService,
  TRunbookHandlers extends DesktopRunbookRuntimeHandlers,
> {
  defaultStaleHeartbeatGraceMs: number;
  initializeDatabase(): Promise<TDb>;
  closeDatabase(): Promise<void>;
  setRuntimeUserDataPath(userDataPath: string): void;
  createAgentLlmAdapter(db: TDb): TAgentLlmAdapter;
  createGlobalVariablesService(db: TDb): TGlobalVariablesService;
  createRunbookStore(
    db: TDb,
    globalVariablesService: TGlobalVariablesService,
  ): TRunbookStore;
  createExternalSourceRunbookQueryService(
    db: TDb,
  ): TExternalSourceRunbookQueryService;
  createRunbookResultStore(db: TDb): TRunbookResultStore;
  createLocalAiProvider(db: TDb): TLocalAiProvider;
  createExecutionService(args: {
    runbookStore: TRunbookStore;
    globalVariablesService: TGlobalVariablesService;
    agentLlmAdapter: TAgentLlmAdapter;
    externalSourceRunbookQueryService: TExternalSourceRunbookQueryService;
    runbookResultStore: TRunbookResultStore;
    localAiProvider: TLocalAiProvider;
  }): TExecutionService;
  createRunbookHandlers(
    db: TDb,
    args: {
      executionService: TExecutionService;
      globalVariablesService: TGlobalVariablesService;
    },
  ): TRunbookHandlers;
  approveRunbookExportPath(filePath: string): void;
  approveRunbookImportPaths(filePaths: string[]): void;
}

export interface DesktopEditionRunbookRuntimeBindings<
  TDb extends DesktopRunbookRuntimeDatabase,
  TGlobalVariablesService,
  TRunbookStore,
  TErrorSourcesRepositoryAdapter,
  TExternalSourceRunbookQueryService,
  TRunbookResultStore extends DesktopRunbookRuntimeResultStore,
  TLocalAiProvider extends DesktopRunbookRuntimeLocalAiProvider,
  TAgentLlmAdapter extends DesktopRunbookRuntimeAgentLlmAdapter<TLocalAiProvider>,
  TExecutionService extends DesktopRunbookRuntimeExecutionService,
  TRunbookHandlers extends DesktopRunbookRuntimeHandlers,
> {
  defaultStaleHeartbeatGraceMs: number;
  initializeDatabase(): Promise<TDb>;
  closeDatabase(): Promise<void>;
  setRuntimeUserDataPath(userDataPath: string): void;
  createAgentLlmAdapter(db: TDb): TAgentLlmAdapter;
  GlobalVariablesService: new (db: TDb) => TGlobalVariablesService;
  RunbookStore: new (
    db: TDb,
    globalVariablesService: TGlobalVariablesService,
  ) => TRunbookStore;
  ErrorSourcesRepositoryAdapter: new (
    db: TDb,
  ) => TErrorSourcesRepositoryAdapter;
  ExternalSourceRunbookQueryService: new (
    sourcesRepository: TErrorSourcesRepositoryAdapter,
    options?: { defaultLimit?: number },
    pluginRuntime?: DesktopPluginRuntimeService,
  ) => TExternalSourceRunbookQueryService;
  RunbookResultStore: new (db: TDb) => TRunbookResultStore;
  LocalAiProvider: new (db: TDb) => TLocalAiProvider;
  RunbookExecutionService: new (
    runbookStore: TRunbookStore,
    globalVariablesService: TGlobalVariablesService,
    agentLlmAdapter: TAgentLlmAdapter,
    externalSourceRunbookQueryService: TExternalSourceRunbookQueryService,
    runbookResultStore: TRunbookResultStore,
    windowGetter: () => null,
    options: undefined,
    localAiProvider: TLocalAiProvider,
    pluginRuntime?: DesktopPluginRuntimeService,
  ) => TExecutionService;
  createPluginRuntime?: () => DesktopPluginRuntimeService;
  createRunbookHandlers(
    db: TDb,
    args: {
      executionService: TExecutionService;
      globalVariablesService: TGlobalVariablesService;
    },
  ): TRunbookHandlers;
  approveRunbookExportPath(filePath: string): void;
  approveRunbookImportPaths(filePaths: string[]): void;
}

function toCliExecutionRecord(
  execution: RunbookExecutionRecord | null,
): Record<string, unknown> | null {
  if (execution === null) {
    return null;
  }

  return { ...execution };
}

async function invokeHandler<T>(
  handlers: DesktopRunbookRuntimeHandlers,
  channel: keyof DesktopRunbookRuntimeHandlers,
  payload?: unknown,
): Promise<T> {
  const handler = handlers[channel];
  return (await handler(payload)) as T;
}

function resolveDeadline(timeoutMs: number | undefined): number | null {
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return null;
  }

  return Date.now() + timeoutMs;
}

function hasDeadlineExpired(deadline: number | null): boolean {
  if (deadline === null) {
    return false;
  }

  return Date.now() >= deadline;
}

function findDatabasePath(rows: Array<{ path?: string }>): string {
  const row = rows.find((candidate): boolean => {
    return candidate.path !== undefined && candidate.path !== "";
  });

  return row?.path ?? "";
}

export function createDesktopEditionRunbookRuntimeBindings<
  TDb extends DesktopRunbookRuntimeDatabase,
  TGlobalVariablesService,
  TRunbookStore,
  TErrorSourcesRepositoryAdapter,
  TExternalSourceRunbookQueryService,
  TRunbookResultStore extends DesktopRunbookRuntimeResultStore,
  TLocalAiProvider extends DesktopRunbookRuntimeLocalAiProvider,
  TAgentLlmAdapter extends DesktopRunbookRuntimeAgentLlmAdapter<TLocalAiProvider>,
  TExecutionService extends DesktopRunbookRuntimeExecutionService,
  TRunbookHandlers extends DesktopRunbookRuntimeHandlers,
>(
  bindings: DesktopEditionRunbookRuntimeBindings<
    TDb,
    TGlobalVariablesService,
    TRunbookStore,
    TErrorSourcesRepositoryAdapter,
    TExternalSourceRunbookQueryService,
    TRunbookResultStore,
    TLocalAiProvider,
    TAgentLlmAdapter,
    TExecutionService,
    TRunbookHandlers
  >,
): DesktopRunbookRuntimeCreateBindings<
  TDb,
  TGlobalVariablesService,
  TRunbookStore,
  TExternalSourceRunbookQueryService,
  TRunbookResultStore,
  TLocalAiProvider,
  TAgentLlmAdapter,
  TExecutionService,
  TRunbookHandlers
> {
  let pluginRuntime: DesktopPluginRuntimeService | undefined

  function getPluginRuntime(): DesktopPluginRuntimeService | undefined {
    if (bindings.createPluginRuntime === undefined) {
      return undefined
    }

    pluginRuntime ??= bindings.createPluginRuntime()
    return pluginRuntime
  }

  return {
    defaultStaleHeartbeatGraceMs: bindings.defaultStaleHeartbeatGraceMs,
    initializeDatabase() {
      return bindings.initializeDatabase();
    },
    closeDatabase() {
      return bindings.closeDatabase();
    },
    setRuntimeUserDataPath(userDataPath) {
      bindings.setRuntimeUserDataPath(userDataPath);
    },
    createAgentLlmAdapter(db) {
      return bindings.createAgentLlmAdapter(db);
    },
    createGlobalVariablesService(db) {
      return new bindings.GlobalVariablesService(db);
    },
    createRunbookStore(db, globalVariablesService) {
      return new bindings.RunbookStore(db, globalVariablesService);
    },
    createExternalSourceRunbookQueryService(db) {
      const runtime = getPluginRuntime();
      return new bindings.ExternalSourceRunbookQueryService(
        new bindings.ErrorSourcesRepositoryAdapter(db),
        undefined,
        runtime,
      );
    },
    createRunbookResultStore(db) {
      return new bindings.RunbookResultStore(db);
    },
    createLocalAiProvider(db) {
      return new bindings.LocalAiProvider(db);
    },
    createExecutionService({
      runbookStore,
      globalVariablesService,
      agentLlmAdapter,
      externalSourceRunbookQueryService,
      runbookResultStore,
      localAiProvider,
    }) {
      return new bindings.RunbookExecutionService(
        runbookStore,
        globalVariablesService,
        agentLlmAdapter,
        externalSourceRunbookQueryService,
        runbookResultStore,
        () => null,
        undefined,
        localAiProvider,
        getPluginRuntime(),
      );
    },
    createRunbookHandlers(db, args) {
      return bindings.createRunbookHandlers(db, args);
    },
    approveRunbookExportPath(filePath) {
      bindings.approveRunbookExportPath(filePath);
    },
    approveRunbookImportPaths(filePaths) {
      bindings.approveRunbookImportPaths(filePaths);
    },
  };
}

export async function createDesktopRunbookRuntime<
  TDb extends DesktopRunbookRuntimeDatabase,
  TGlobalVariablesService,
  TRunbookStore,
  TExternalSourceRunbookQueryService,
  TRunbookResultStore extends DesktopRunbookRuntimeResultStore,
  TLocalAiProvider extends DesktopRunbookRuntimeLocalAiProvider,
  TAgentLlmAdapter extends DesktopRunbookRuntimeAgentLlmAdapter<TLocalAiProvider>,
  TExecutionService extends DesktopRunbookRuntimeExecutionService,
  TRunbookHandlers extends DesktopRunbookRuntimeHandlers,
  TRuntime,
>(
  options: DesktopRunbookRuntimeOptions,
  bindings: DesktopRunbookRuntimeCreateBindings<
    TDb,
    TGlobalVariablesService,
    TRunbookStore,
    TExternalSourceRunbookQueryService,
    TRunbookResultStore,
    TLocalAiProvider,
    TAgentLlmAdapter,
    TExecutionService,
    TRunbookHandlers
  >,
  createRuntime: (dependencies: DesktopRunbookRuntimeDependencies) => TRuntime,
): Promise<TRuntime> {
  if (options.userDataPath !== undefined && options.userDataPath !== "") {
    bindings.setRuntimeUserDataPath(options.userDataPath);
  }

  const db = await bindings.initializeDatabase();
  const agentLlmAdapter = bindings.createAgentLlmAdapter(db);
  const globalVariablesService = bindings.createGlobalVariablesService(db);
  const runbookStore = bindings.createRunbookStore(db, globalVariablesService);
  const externalSourceRunbookQueryService =
    bindings.createExternalSourceRunbookQueryService(db);
  const runbookResultStore = bindings.createRunbookResultStore(db);
  await runbookResultStore.markStaleRunningSessionsFailed({
    heartbeatGraceMs:
      options.staleHeartbeatGraceMs ??
      bindings.defaultStaleHeartbeatGraceMs,
  });

  const localAiProvider = bindings.createLocalAiProvider(db);
  await localAiProvider.loadSettings();
  agentLlmAdapter.setLocalAiProvider(localAiProvider);

  const executionService = bindings.createExecutionService({
    runbookStore,
    globalVariablesService,
    agentLlmAdapter,
    externalSourceRunbookQueryService,
    runbookResultStore,
    localAiProvider,
  });

  const runbookHandlers = bindings.createRunbookHandlers(db, {
    executionService,
    globalVariablesService,
  });

  return createRuntime({
    db,
    runbookHandlers,
    executionService,
    closeDatabase() {
      return bindings.closeDatabase();
    },
    approveRunbookExportPath(filePath) {
      bindings.approveRunbookExportPath(filePath);
    },
    approveRunbookImportPaths(filePaths) {
      bindings.approveRunbookImportPaths(filePaths);
    },
  });
}

export interface DesktopEditionRunbookRuntimeFactory<TRuntime> {
  create(
    options?: DesktopRunbookRuntimeOptions,
  ): Promise<TRuntime>;
}

export function createDesktopEditionRunbookRuntimeFactory<
  TDb extends DesktopRunbookRuntimeDatabase,
  TGlobalVariablesService,
  TRunbookStore,
  TExternalSourceRunbookQueryService,
  TRunbookResultStore extends DesktopRunbookRuntimeResultStore,
  TLocalAiProvider extends DesktopRunbookRuntimeLocalAiProvider,
  TAgentLlmAdapter extends DesktopRunbookRuntimeAgentLlmAdapter<TLocalAiProvider>,
  TExecutionService extends DesktopRunbookRuntimeExecutionService,
  TRunbookHandlers extends DesktopRunbookRuntimeHandlers,
>(
  bindings: DesktopRunbookRuntimeCreateBindings<
    TDb,
    TGlobalVariablesService,
    TRunbookStore,
    TExternalSourceRunbookQueryService,
    TRunbookResultStore,
    TLocalAiProvider,
    TAgentLlmAdapter,
    TExecutionService,
    TRunbookHandlers
  >,
): DesktopEditionRunbookRuntimeFactory<DesktopRunbookRuntimeBase> {
  class DesktopEditionRunbookRuntime extends DesktopRunbookRuntimeBase {
    private constructor(dependencies: DesktopRunbookRuntimeDependencies) {
      super(dependencies);
    }

    static async create(
      options: DesktopRunbookRuntimeOptions = {},
    ): Promise<DesktopEditionRunbookRuntime> {
      return createDesktopRunbookRuntime(
        options,
        bindings,
        (dependencies) => new DesktopEditionRunbookRuntime(dependencies),
      );
    }
  }

  return {
    create(options = {}) {
      return DesktopEditionRunbookRuntime.create(options);
    },
  };
}

export class DesktopRunbookRuntimeBase {
  protected constructor(
    private readonly dependencies: DesktopRunbookRuntimeDependencies,
  ) {}

  async destroy(): Promise<void> {
    await this.dependencies.executionService.destroy();
    await this.dependencies.closeDatabase();
  }

  async listRunbooks(): Promise<RunbookRecord[]> {
    return invokeHandler<RunbookRecord[]>(
      this.dependencies.runbookHandlers,
      "runbooks:list",
    );
  }

  async getRunbook(runbookId: string): Promise<RunbookRecord | null> {
    return invokeHandler<RunbookRecord | null>(
      this.dependencies.runbookHandlers,
      "runbooks:get",
      { id: runbookId },
    );
  }

  async deleteRunbook(runbookId: string): Promise<{ ok: true }> {
    return invokeHandler<{ ok: true }>(
      this.dependencies.runbookHandlers,
      "runbooks:delete",
      { id: runbookId },
    );
  }

  async exportRunbooks(
    runbookIds: string[],
    includeGlobals = false,
  ): Promise<RunbookExportArtifactV1> {
    return invokeHandler<RunbookExportArtifactV1>(
      this.dependencies.runbookHandlers,
      "runbooks:export",
      { ids: runbookIds, includeGlobals },
    );
  }

  async exportRunbooksToFile(
    filePath: string,
    runbookIds: string[],
    includeGlobals = false,
  ): Promise<{ ok: true; filePath: string; count: number }> {
    this.dependencies.approveRunbookExportPath(filePath);
    return invokeHandler<{ ok: true; filePath: string; count: number }>(
      this.dependencies.runbookHandlers,
      "runbooks:exportToFile",
      { filePath, ids: runbookIds, includeGlobals },
    );
  }

  async importRunbooksFromFile(
    filePath: string,
    options?: RunbookImportOptions,
  ): Promise<RunbookImportSummary> {
    this.dependencies.approveRunbookImportPaths([filePath]);
    return invokeHandler<RunbookImportSummary>(
      this.dependencies.runbookHandlers,
      "runbooks:importFromFile",
      { filePath, options },
    );
  }

  async executeRunbook(
    input: ExecuteRunbookInput,
  ): Promise<{ executionId: string; resultId: string }> {
    return invokeHandler<{ executionId: string; resultId: string }>(
      this.dependencies.runbookHandlers,
      "runbooks:execute",
      input,
    );
  }

  async getExecution(
    executionId: string,
  ): Promise<Record<string, unknown> | null> {
    const execution = await this.getExecutionRecord(executionId);
    return toCliExecutionRecord(execution);
  }

  async cancelExecution(executionId: string): Promise<void> {
    await invokeHandler<unknown>(
      this.dependencies.runbookHandlers,
      "runbooks:cancelExecution",
      { executionId },
    );
  }

  async waitForExecution(
    executionId: string,
    options: WaitForExecutionOptions = {},
  ): Promise<Record<string, unknown> | null> {
    const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 1_000);
    const deadline = resolveDeadline(options.timeoutMs);

    for (;;) {
      const execution = await this.getExecutionRecord(executionId);
      if (execution === null) {
        return null;
      }

      if (execution.status !== "running") {
        return toCliExecutionRecord(execution);
      }

      if (hasDeadlineExpired(deadline)) {
        return toCliExecutionRecord(execution);
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  async getDatabasePath(): Promise<string> {
    const rows = await this.dependencies.db.$queryRawUnsafe<
      Array<{ path?: string }>
    >("PRAGMA database_list");
    return findDatabasePath(rows);
  }

  private async getExecutionRecord(
    executionId: string,
  ): Promise<RunbookExecutionRecord | null> {
    return invokeHandler<RunbookExecutionRecord | null>(
      this.dependencies.runbookHandlers,
      "runbooks:getExecution",
      { executionId },
    );
  }
}
