export type DesktopUpdaterStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export type DesktopUpdaterState = {
  status: DesktopUpdaterStatus;
  appVersion?: string;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent?: number | null;
  checkedAt?: string | null;
  message?: string | null;
  disabledReasonCode?: string | null;
  disabledReason?: string | null;
};

export type DesktopTelemetryStatus = {
  enabled: boolean;
  canDisable: boolean;
};

export type DesktopCliProbeResult = {
  installed: boolean;
  version: string | null;
  auth: { status: "authenticated" | "unauthenticated" | "unknown" };
  status: "ready" | "error" | "warning";
  errorKind?: string;
  message?: string;
};

export type DesktopNativeDialogFilter = {
  name: string;
  extensions: string[];
};

export type DesktopLocalLlmSettings = {
  claudeCode: { enabled: boolean; binaryPath: string; lastProbe?: unknown };
  codex: {
    enabled: boolean;
    binaryPath: string;
    codexArgs?: string[];
    lastProbe?: unknown;
  };
  opencode: {
    enabled: boolean;
    binaryPath: string;
    opencodeArgs?: string[];
    lastProbe?: unknown;
  };
  cursor: { enabled: boolean; binaryPath: string; lastProbe?: unknown };
};

export type DesktopSavedLlmProviderConfig = {
  hasApiKey: boolean;
  baseUrl: string;
  model: string;
  availableModels: string[];
  isSelectable: boolean;
  isPrimary: boolean;
};

export type DesktopBitsentryApi = {
  platform?: {
    os?: string;
  };
  database?: {
    reset: () => Promise<{ ok: boolean }>;
  };
  incidents?: {
    list: () => Promise<unknown[]>;
    getThreadMessages: (threadId: string) => Promise<unknown[]>;
    /** Writes only the fields present; `archivedAt: null` unarchives. */
    saveThread: (thread: { id: string } & Record<string, unknown>) => Promise<{ ok: true }>;
    appendThreadMessages: (threadId: string, messages: unknown[]) => Promise<{ ok: true }>;
  };
  llm?: {
    getProviders: () => Promise<Record<string, DesktopSavedLlmProviderConfig>>;
    saveProvider?: (
      providerKey: string,
      config: {
        model?: string;
        availableModels?: string[];
        isSelectable?: boolean;
        isPrimary?: boolean;
        apiKey?: string;
        baseUrl?: string;
      },
    ) => Promise<{ ok: boolean }>;
    local?: {
      getSettings: () => Promise<DesktopLocalLlmSettings>;
      saveSettings: (patch: Record<string, unknown>) => Promise<unknown>;
      detectBinary: (
        provider: string,
        preferredBinaryPath?: string,
      ) => Promise<string | null>;
      probe: (provider: string) => Promise<DesktopCliProbeResult>;
      listModels: (provider: string) => Promise<string[]>;
    };
    ping?: (
      providerKey: string,
      config: {
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        requestId?: string;
      },
    ) => Promise<{
      ok: boolean;
      message: string;
      latencyMs: number;
      responseText: string;
      requestId: string;
    }>;
    clearAllCredentials?: () => Promise<{ ok: boolean }>;
    listModels?: (
      providerKey: string,
      config: { apiKey?: string; baseUrl?: string },
    ) => Promise<{
      providerKey: string;
      models: string[];
      count: number;
      fetchedAt: string;
    }>;
  };
  dialog?: {
    showSaveDialog: (input?: {
      defaultPath?: string;
      defaultFileName?: string;
      filters?: DesktopNativeDialogFilter[];
      trustScope?: "runbooks-export";
    }) => Promise<{ filePath: string | null; canceled: boolean }>;
    showOpenDialog: (input?: {
      defaultPath?: string;
      filters?: DesktopNativeDialogFilter[];
      properties?: string[];
      trustScope?: "runbooks-import";
    }) => Promise<{ filePaths: string[]; canceled: boolean }>;
  };
  telemetry?: {
    getStatus: () => Promise<DesktopTelemetryStatus>;
    setEnabled: (enabled: boolean) => Promise<{ ok: boolean }>;
  };
  updater?: {
    getState: () => Promise<DesktopUpdaterState>;
    check?: () => Promise<DesktopUpdaterState>;
    download: () => Promise<{ accepted: boolean }>;
    install: () => Promise<{ accepted: boolean }>;
    onState: (callback: (state: DesktopUpdaterState) => void) => () => void;
  };
};

function isDesktopBitsentryApi(value: unknown): value is DesktopBitsentryApi {
  if (value === undefined || value === null || typeof value !== "object") {
    return false;
  }

  const maybeApi = value as DesktopBitsentryApi;
  if (
    maybeApi.updater !== undefined &&
    (typeof maybeApi.updater.getState !== "function" ||
      typeof maybeApi.updater.download !== "function" ||
      typeof maybeApi.updater.install !== "function" ||
      typeof maybeApi.updater.onState !== "function")
  ) {
    return false;
  }

  if (
    maybeApi.incidents !== undefined &&
    (typeof maybeApi.incidents.list !== "function" ||
      typeof maybeApi.incidents.saveThread !== "function")
  ) {
    return false;
  }

  if (
    maybeApi.llm !== undefined &&
    typeof maybeApi.llm.getProviders !== "function"
  ) {
    return false;
  }

  if (
    maybeApi.dialog !== undefined &&
    (typeof maybeApi.dialog.showSaveDialog !== "function" ||
      typeof maybeApi.dialog.showOpenDialog !== "function")
  ) {
    return false;
  }

  if (
    maybeApi.telemetry !== undefined &&
    (typeof maybeApi.telemetry.getStatus !== "function" ||
      typeof maybeApi.telemetry.setEnabled !== "function")
  ) {
    return false;
  }

  if (
    maybeApi.database !== undefined &&
    typeof maybeApi.database.reset !== "function"
  ) {
    return false;
  }

  return true;
}

export function getDesktopApi(): DesktopBitsentryApi | undefined {
  if (typeof window === "undefined") return undefined;
  const bitsentry = (window as { bitsentry?: unknown }).bitsentry;
  if (!isDesktopBitsentryApi(bitsentry)) return undefined;
  return bitsentry;
}
