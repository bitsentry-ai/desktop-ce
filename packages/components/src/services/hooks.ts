import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import type {
  ActivityTimelineQuery,
  AuditLogQuery,
  CreateErrorSourceInput,
  DiagnosisResultsResponse,
  UpdateErrorSourceInput,
  DiagnosisQuery,
  LogLevelThreshold,
  RunbooksServicePort,
  UsersQuery,
} from './contracts';
import { useBitsentryServices } from './context';

function requirePort<T>(
  port: T | undefined,
  name: string,
): T {
  if (port === undefined) {
    throw new Error(
      `Missing ${name} service in BitsentryServicesProvider. Configure this port in the app adapter.`,
    );
  }

  return port;
}

const queryKeys = {
  diagnosisRoot: ['bitsentry', 'diagnosis'] as const,
  diagnosisResults: (params: DiagnosisQuery = {}) =>
    [...queryKeys.diagnosisRoot, 'results', params] as const,
  analyticsRoot: ['bitsentry', 'analytics'] as const,
  activityTimeline: (params: ActivityTimelineQuery = {}) =>
    [...queryKeys.analyticsRoot, 'activity-timeline', params] as const,
  securityDomains: () => [...queryKeys.analyticsRoot, 'security-domains'] as const,
  threatIntelligence: () =>
    [...queryKeys.analyticsRoot, 'threat-intelligence'] as const,
  recentThreats: (hours = 1) =>
    [...queryKeys.analyticsRoot, 'recent-threats', hours] as const,

  vulnerabilitiesRoot: ['bitsentry', 'vulnerabilities'] as const,
  vulnerabilityTimeline: (id: string) =>
    [...queryKeys.vulnerabilitiesRoot, 'timeline', id] as const,

  settingsRoot: ['bitsentry', 'settings'] as const,
  systemSettings: () => [...queryKeys.settingsRoot, 'system'] as const,
  securitySettings: () => [...queryKeys.settingsRoot, 'security'] as const,
  integrationSettings: () => [...queryKeys.settingsRoot, 'integration'] as const,
  globalVariablesRoot: ['bitsentry', 'global-variables'] as const,
  globalVariables: () => [...queryKeys.globalVariablesRoot, 'list'] as const,

  usersRoot: ['bitsentry', 'users'] as const,
  users: (params: UsersQuery = {}) => [...queryKeys.usersRoot, 'list', params] as const,

  auditLogsRoot: ['bitsentry', 'audit-logs'] as const,
  auditLogs: (params: AuditLogQuery = {}) =>
    [...queryKeys.auditLogsRoot, 'list', params] as const,
  auditLogsExport: (params: AuditLogQuery = {}) =>
    [...queryKeys.auditLogsRoot, 'export', params] as const,

  authRoot: ['bitsentry', 'auth'] as const,
  currentUser: () => [...queryKeys.authRoot, 'current-user'] as const,
  totpStatus: () => [...queryKeys.authRoot, 'totp-status'] as const,
  passkeys: () => [...queryKeys.authRoot, 'passkeys'] as const,

  pluginsRoot: ['bitsentry', 'plugins'] as const,
  pluginsList: () => [...queryKeys.pluginsRoot, 'list'] as const,
  pluginsAvailable: () => [...queryKeys.pluginsRoot, 'available'] as const,
  pluginDetail: (pluginId: string) => [...queryKeys.pluginsRoot, 'detail', pluginId] as const,
  pluginStoredAuth: (pluginId: string) =>
    [...queryKeys.pluginsRoot, 'stored-auth', pluginId] as const,

  errorSourcesRoot: ['bitsentry', 'error-sources'] as const,
  errorSourcesList: () => [...queryKeys.errorSourcesRoot, 'list'] as const,
};

export function useDiagnosisResults(params: DiagnosisQuery = {}) {
  const { diagnosis } = useBitsentryServices();

  return useQuery({
    queryKey: queryKeys.diagnosisResults(params),
    queryFn: () =>
      diagnosis?.getDiagnosisResults(params) ??
      Promise.resolve<DiagnosisResultsResponse>({
        records: [],
        total_count: 0,
      }),
    enabled: Boolean(diagnosis),
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 5,
    retry: 3,
    refetchOnWindowFocus: false,
  });
}

export function useSystemSettings() {
  const { settings } = useBitsentryServices();
  const port = requirePort(settings, 'settings');

  return useQuery({
    queryKey: queryKeys.systemSettings(),
    queryFn: () => port.getSystemSettings(),
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 60,
  });
}

export function useUpdateSystemSettings() {
  const { settings } = useBitsentryServices();
  const port = requirePort(settings, 'settings');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { data: Parameters<typeof port.updateSystemSettings>[0] }) =>
      port.updateSystemSettings(input.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settingsRoot });
    },
  });
}

export function useGlobalVariables() {
  const { globalVariables } = useBitsentryServices();
  const port = requirePort(globalVariables, 'globalVariables');

  return useQuery({
    queryKey: queryKeys.globalVariables(),
    queryFn: () => port.list(),
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
  });
}

export function useCreateGlobalVariable() {
  const { globalVariables } = useBitsentryServices();
  const port = requirePort(globalVariables, 'globalVariables');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Parameters<typeof port.create>[0]) => port.create(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.globalVariablesRoot });
    },
  });
}

export function useUpdateGlobalVariable() {
  const { globalVariables } = useBitsentryServices();
  const port = requirePort(globalVariables, 'globalVariables');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; patch: Parameters<typeof port.update>[1] }) =>
      port.update(input.id, input.patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.globalVariablesRoot });
    },
  });
}

export function useDeleteGlobalVariable() {
  const { globalVariables } = useBitsentryServices();
  const port = requirePort(globalVariables, 'globalVariables');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => port.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.globalVariablesRoot });
    },
  });
}

export function useAuthSession() {
  const { runtime } = useBitsentryServices();

  if (runtime === undefined) {
    return {
      user: null,
      isAuthenticated: false,
      isLoading: false,
    };
  }

  return runtime.getAuthSession();
}

export function useConnectionStatus() {
  const { runtime } = useBitsentryServices();
  const [connected, setConnected] = useState<boolean>(() => {
    if (runtime !== undefined) {
      return runtime.getConnectionStatus();
    }

    return navigator.onLine;
  });

  useEffect(() => {
    const update = () => {
      if (runtime !== undefined) {
        setConnected(runtime.getConnectionStatus());
        return;
      }

      setConnected(navigator.onLine);
    };

    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    window.addEventListener("bitsentry:connection-status", update);
    const timer = window.setInterval(update, 10000);

    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      window.removeEventListener("bitsentry:connection-status", update);
      window.clearInterval(timer);
    };
  }, [runtime]);

  return connected;
}

export function useAppLogout() {
  const { runtime } = useBitsentryServices();

  return () => {
    if (runtime !== undefined) {
      void runtime.logout();
    }
  };
}

export function usePlugins() {
  const { plugins } = useBitsentryServices();
  const port = requirePort(plugins, 'plugins');

  return useQuery({
    queryKey: queryKeys.pluginsList(),
    queryFn: () => port.list(),
    staleTime: 1000 * 30,
    gcTime: 1000 * 60 * 5,
  });
}

export function useAvailablePlugins(enabled = true) {
  const { plugins } = useBitsentryServices();
  const port = requirePort(plugins, 'plugins');

  return useQuery({
    queryKey: queryKeys.pluginsAvailable(),
    queryFn: () => port.listAvailable(),
    enabled,
    staleTime: 1000 * 30,
    gcTime: 1000 * 60 * 5,
  });
}

function useInvalidatePluginsAfterInstall() {
  const queryClient = useQueryClient();

  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.pluginsList() });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.pluginsAvailable(),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.errorSourcesList(),
    });
  };
}

export function useInstallPluginFromIndex() {
  const { plugins } = useBitsentryServices();
  const port = requirePort(plugins, 'plugins');
  const invalidate = useInvalidatePluginsAfterInstall();

  return useMutation({
    mutationFn: (input: { name: string; indexUrl?: string }) =>
      port.installFromIndex(input.name, input.indexUrl),
    onSuccess: invalidate,
  });
}

export function useInstallPluginFromArtifact() {
  const { plugins } = useBitsentryServices();
  const port = requirePort(plugins, 'plugins');
  const invalidate = useInvalidatePluginsAfterInstall();

  return useMutation({
    mutationFn: (artifactBase64: string) =>
      port.installFromArtifact(artifactBase64),
    onSuccess: invalidate,
  });
}

export function useErrorSources() {
  const { errorSources } = useBitsentryServices();
  const port = requirePort(errorSources, 'errorSources');

  return useQuery({
    queryKey: queryKeys.errorSourcesList(),
    queryFn: () => port.getAll(),
    staleTime: 1000 * 30,
    gcTime: 1000 * 60 * 5,
  });
}

export function useCreateErrorSource() {
  const { errorSources } = useBitsentryServices();
  const port = requirePort(errorSources, 'errorSources');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateErrorSourceInput) => port.create(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.errorSourcesRoot });
    },
  });
}

export function useDeleteErrorSource() {
  const { errorSources } = useBitsentryServices();
  const port = requirePort(errorSources, 'errorSources');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => port.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.errorSourcesRoot });
    },
  });
}

export function useUpdateErrorSource() {
  const { errorSources } = useBitsentryServices();
  const port = requirePort(errorSources, 'errorSources');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateErrorSourceInput) => port.update(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.errorSourcesRoot });
    },
  });
}

export function useSyncErrorSource() {
  const { errorSources } = useBitsentryServices();
  const port = requirePort(errorSources, 'errorSources');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, logLevelThreshold, syncEnabled }: { id: string; logLevelThreshold: LogLevelThreshold; syncEnabled: boolean }) =>
      port.sync(id, { logLevelThreshold, syncEnabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.errorSourcesRoot });
      void queryClient.invalidateQueries({ queryKey: queryKeys.diagnosisRoot });
    },
  });
}

export function useRunbooksService(): RunbooksServicePort {
  const { runbooks } = useBitsentryServices();
  return requirePort(runbooks, 'runbooks');
}

export function useAgentService() {
  const { agent } = useBitsentryServices();
  return requirePort(agent, 'agent');
}
