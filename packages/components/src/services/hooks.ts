import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import type {
  ActivityTimelineQuery,
  AuditLogQuery,
  CreateErrorSourceInput,
  CreateTicketFromDiagnosisInput,
  DiagnosisResultsResponse,
  DiagnosisTicket,
  PaginatedResolvedTickets,
  ResolvedTicketDetails,
  ResolvedTicketsSummary,
  UpdateErrorSourceInput,
  DiagnosisQuery,
  EmailOtpRequest,
  EmailOtpVerifyRequest,
  LogLevelThreshold,
  MagicLinkRequest,
  MagicLinkVerifyRequest,
  PluginActionExecutionResult,
  PluginManifest,
  ResolvedTicketsQuery,
  RunbooksServicePort,
  SyncResolutionStatusesInput,
  UpdateResolutionMetadataInput,
  UpdateUserInput,
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
  diagnosisTickets: (diagnosisIds?: number[]) =>
    [...queryKeys.diagnosisRoot, 'tickets', diagnosisIds ?? []] as const,

  ticketsRoot: ['bitsentry', 'tickets'] as const,
  resolvedTicket: (id: string) =>
    [...queryKeys.ticketsRoot, 'resolved-ticket', id] as const,
  resolvedTickets: (filters: ResolvedTicketsQuery = {}) =>
    [...queryKeys.ticketsRoot, 'resolved', filters] as const,
  resolvedSummary: () => [...queryKeys.ticketsRoot, 'resolved-summary'] as const,

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

export function useDiagnosisTickets(diagnosisIds?: number[]) {
  const { diagnosis } = useBitsentryServices();

  return useQuery({
    queryKey: queryKeys.diagnosisTickets(diagnosisIds),
    queryFn: () =>
      diagnosis?.getDiagnosisTickets(diagnosisIds) ??
      Promise.resolve<DiagnosisTicket[]>([]),
    enabled: Boolean(diagnosis),
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 5,
  });
}

export function useCreateDiagnosisTicket() {
  const { diagnosis } = useBitsentryServices();
  const port = requirePort(diagnosis, 'diagnosis');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateTicketFromDiagnosisInput) =>
      port.createDiagnosisTicket(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.diagnosisRoot });
      void queryClient.invalidateQueries({ queryKey: queryKeys.ticketsRoot });
    },
  });
}

export function useResolvedTickets(filters: ResolvedTicketsQuery = {}) {
  const { tickets } = useBitsentryServices();

  return useQuery({
    queryKey: queryKeys.resolvedTickets(filters),
    queryFn: () =>
      tickets?.getResolvedTickets(filters) ??
      Promise.resolve<PaginatedResolvedTickets>({
        data: [],
        meta: {
          page: filters.page ?? 1,
          limit: filters.limit ?? 20,
          total: 0,
          totalPages: 1,
        },
      }),
    enabled: Boolean(tickets),
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 10,
  });
}

export function useResolvedTicket(id?: string, enabled = true) {
  const { tickets } = useBitsentryServices();

  return useQuery({
    queryKey: queryKeys.resolvedTicket(id ?? ''),
    queryFn: () => {
      if (tickets === undefined || id === undefined || id.length === 0) {
        return Promise.resolve<ResolvedTicketDetails | null>(null);
      }

      return tickets.getResolvedTicket(id);
    },
    enabled: Boolean(tickets) && enabled && typeof id === 'string' && id.length > 0,
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 10,
  });
}

export function useResolvedSummary() {
  const { tickets } = useBitsentryServices();

  return useQuery({
    queryKey: queryKeys.resolvedSummary(),
    queryFn: () =>
      tickets?.getResolvedSummary() ??
      Promise.resolve<ResolvedTicketsSummary>({
        total: 0,
        byResolutionType: {},
        avgResolutionTimeHours: 0,
        withLessonsLearned: 0,
      }),
    enabled: Boolean(tickets),
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 15,
  });
}

export function useUpdateResolutionMetadata() {
  const { tickets } = useBitsentryServices();
  const port = requirePort(tickets, 'tickets');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateResolutionMetadataInput) =>
      port.updateResolutionMetadata(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.ticketsRoot });
      void queryClient.invalidateQueries({ queryKey: queryKeys.diagnosisRoot });
    },
  });
}

export function useSyncResolutionStatuses() {
  const { tickets } = useBitsentryServices();
  const port = requirePort(tickets, 'tickets');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input?: SyncResolutionStatusesInput) =>
      port.syncResolutionStatuses(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.ticketsRoot });
      void queryClient.invalidateQueries({ queryKey: queryKeys.diagnosisRoot });
    },
  });
}

export function useSyncTicketStatus() {
  const { tickets } = useBitsentryServices();
  const port = requirePort(tickets, 'tickets');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => port.syncTicketStatus(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.ticketsRoot });
      void queryClient.invalidateQueries({ queryKey: queryKeys.diagnosisRoot });
    },
  });
}

export function useActivityTimeline(params: ActivityTimelineQuery = {}) {
  const { analytics } = useBitsentryServices();
  const port = requirePort(analytics, 'analytics');

  return useQuery({
    queryKey: queryKeys.activityTimeline(params),
    queryFn: () => port.getActivityTimeline(params),
    staleTime: 1000 * 30,
    gcTime: 1000 * 60 * 5,
  });
}

export function useSecurityDomains() {
  const { analytics } = useBitsentryServices();
  const port = requirePort(analytics, 'analytics');

  return useQuery({
    queryKey: queryKeys.securityDomains(),
    queryFn: () => port.getSecurityDomains(),
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 30,
  });
}

export function useThreatIntelligence() {
  const { analytics } = useBitsentryServices();
  const port = requirePort(analytics, 'analytics');

  return useQuery({
    queryKey: queryKeys.threatIntelligence(),
    queryFn: () => port.getThreatIntelligence(),
    staleTime: 1000 * 60 * 15,
    gcTime: 1000 * 60 * 30,
  });
}

export function useRecentThreats(hours = 1) {
  const { analytics } = useBitsentryServices();
  const port = requirePort(analytics, 'analytics');

  return useQuery({
    queryKey: queryKeys.recentThreats(hours),
    queryFn: () => port.getRecentThreats(hours),
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 10,
  });
}

export function useVulnerabilityTimeline(id: string) {
  const { vulnerabilities } = useBitsentryServices();
  const port = requirePort(vulnerabilities, 'vulnerabilities');

  return useQuery({
    queryKey: queryKeys.vulnerabilityTimeline(id),
    queryFn: () => port.getVulnerabilityTimeline(id),
    enabled: id.length > 0,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
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

export function useSecuritySettings() {
  const { settings } = useBitsentryServices();
  const port = requirePort(settings, 'settings');

  return useQuery({
    queryKey: queryKeys.securitySettings(),
    queryFn: () => port.getSecuritySettings(),
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 60,
  });
}

export function useIntegrationSettings() {
  const { settings } = useBitsentryServices();
  const port = requirePort(settings, 'settings');

  return useQuery({
    queryKey: queryKeys.integrationSettings(),
    queryFn: () => port.getIntegrationSettings(),
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
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

export function useUpdateSecuritySettings() {
  const { settings } = useBitsentryServices();
  const port = requirePort(settings, 'settings');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { data: Parameters<typeof port.updateSecuritySettings>[0] }) =>
      port.updateSecuritySettings(input.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settingsRoot });
    },
  });
}

export function useUpdateNotificationSettings() {
  const { settings } = useBitsentryServices();
  const port = requirePort(settings, 'settings');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { data: Parameters<typeof port.updateNotificationSettings>[0] }) =>
      port.updateNotificationSettings(input.data),
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

export function useUsers(params: UsersQuery = {}) {
  const { users } = useBitsentryServices();
  const port = requirePort(users, 'users');

  return useQuery({
    queryKey: queryKeys.users(params),
    queryFn: () => port.getUsers(params),
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 10,
  });
}

export function useUpdateUser() {
  const { users } = useBitsentryServices();
  const port = requirePort(users, 'users');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateUserInput) => port.updateUser(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.usersRoot });
      void queryClient.invalidateQueries({ queryKey: queryKeys.authRoot });
    },
  });
}

export function useAuditLogs(params: AuditLogQuery = {}) {
  const { auditLogs } = useBitsentryServices();
  const port = requirePort(auditLogs, 'audit logs');

  return useQuery({
    queryKey: queryKeys.auditLogs(params),
    queryFn: () => port.getAuditLogs(params),
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    refetchOnWindowFocus: false,
  });
}

export function useAuditLogExport(params: AuditLogQuery = {}, enabled = false) {
  const { auditLogs } = useBitsentryServices();
  const port = requirePort(auditLogs, 'audit logs');

  return useQuery({
    queryKey: queryKeys.auditLogsExport(params),
    queryFn: () => port.exportAuditLogs(params),
    enabled,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
}

export function useCurrentUser() {
  const { auth } = useBitsentryServices();
  const port = requirePort(auth, 'auth');

  return useQuery({
    queryKey: queryKeys.currentUser(),
    queryFn: () => port.getCurrentUser(),
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
    retry: false,
    refetchOnWindowFocus: true,
  });
}

export function useSendEmailOtp() {
  const { auth } = useBitsentryServices();
  const port = requirePort(auth, 'auth');

  return useMutation({
    mutationFn: (input: EmailOtpRequest) => port.sendEmailOtp(input),
  });
}

export function useVerifyEmailOtp() {
  const { auth } = useBitsentryServices();
  const port = requirePort(auth, 'auth');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: EmailOtpVerifyRequest) => port.verifyEmailOtp(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.authRoot });
    },
  });
}

export function useSendMagicLink() {
  const { auth } = useBitsentryServices();
  const port = requirePort(auth, 'auth');

  return useMutation({
    mutationFn: (input: MagicLinkRequest) => port.sendMagicLink(input),
  });
}

export function useVerifyMagicLink() {
  const { auth } = useBitsentryServices();
  const port = requirePort(auth, 'auth');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: MagicLinkVerifyRequest) => port.verifyMagicLink(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.authRoot });
    },
  });
}

export function useVerifyTotpFor2FA() {
  const { auth } = useBitsentryServices();
  const port = requirePort(auth, 'auth');

  return useMutation({
    mutationFn: (input: { token: string; tempToken: string }) =>
      port.verifyTotpFor2FA(input),
  });
}

export function useSetupTotp() {
  const { auth } = useBitsentryServices();
  const port = requirePort(auth, 'auth');

  return useMutation({
    mutationFn: (input: { password: string }) => port.setupTotp(input),
  });
}

export function useEnableTotp() {
  const { auth } = useBitsentryServices();
  const port = requirePort(auth, 'auth');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { token: string; secret: string }) =>
      port.enableTotp(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.authRoot });
    },
  });
}

export function useTotpStatus() {
  const { auth } = useBitsentryServices();
  const port = requirePort(auth, 'auth');

  return useQuery({
    queryKey: queryKeys.totpStatus(),
    queryFn: () => port.getTotpStatus(),
    staleTime: 1000 * 60 * 2,
    refetchOnWindowFocus: true,
  });
}

export function useGeneratePasskeyRegistrationOptions() {
  const { auth } = useBitsentryServices();
  const port = requirePort(auth, 'auth');

  return useMutation({
    mutationFn: (input: { deviceName: string }) =>
      port.generatePasskeyRegistrationOptions(input),
  });
}

export function useVerifyPasskeyRegistration() {
  const { auth } = useBitsentryServices();
  const port = requirePort(auth, 'auth');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      challengeId: string;
      response: unknown;
      deviceName: string;
    }) => port.verifyPasskeyRegistration(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.authRoot });
      void queryClient.invalidateQueries({ queryKey: queryKeys.passkeys() });
    },
  });
}

export function useGeneratePasskeyAuthenticationOptions() {
  const { auth } = useBitsentryServices();
  const port = requirePort(auth, 'auth');

  return useMutation({
    mutationFn: (input: { email?: string }) =>
      port.generatePasskeyAuthenticationOptions(input),
  });
}

export function useVerifyPasskeyAuthentication() {
  const { auth } = useBitsentryServices();
  const port = requirePort(auth, 'auth');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      challengeId: string;
      response: unknown;
    }) => port.verifyPasskeyAuthentication(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.authRoot });
    },
  });
}

export function usePasskeys(options?: { enabled?: boolean }) {
  const { auth } = useBitsentryServices();
  const port = requirePort(auth, 'auth');

  return useQuery({
    queryKey: queryKeys.passkeys(),
    queryFn: () => port.getPasskeys(),
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 10,
    enabled: options?.enabled,
  });
}

export function useDeletePasskey() {
  const { auth } = useBitsentryServices();
  const port = requirePort(auth, 'auth');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string }) => port.deletePasskey(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.passkeys() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.authRoot });
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

export function useAppNavigate() {
  const { runtime } = useBitsentryServices();

  return (path: string) => {
    if (runtime !== undefined) {
      runtime.navigate(path);
      return;
    }

    window.location.assign(path);
  };
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

export function usePlugin(pluginId?: string) {
  const { plugins } = useBitsentryServices();
  const port = requirePort(plugins, 'plugins');

  return useQuery({
    queryKey: queryKeys.pluginDetail(pluginId ?? ''),
    queryFn: () => {
      if (pluginId === undefined || pluginId.trim().length === 0) {
        return Promise.resolve<PluginManifest | null>(null);
      }

      return port.get(pluginId);
    },
    enabled: typeof pluginId === 'string' && pluginId.trim().length > 0,
    staleTime: 1000 * 30,
    gcTime: 1000 * 60 * 5,
  });
}

export function usePluginStoredAuth(pluginId?: string) {
  const { plugins } = useBitsentryServices();
  const port = requirePort(plugins, 'plugins');

  return useQuery({
    queryKey: queryKeys.pluginStoredAuth(pluginId ?? ''),
    queryFn: () => {
      if (pluginId === undefined || pluginId.trim().length === 0) {
        return Promise.resolve<Record<string, unknown>>({});
      }

      return port.getStoredAuth(pluginId);
    },
    enabled: typeof pluginId === 'string' && pluginId.trim().length > 0,
    staleTime: 1000 * 30,
    gcTime: 1000 * 60 * 5,
  });
}

export function useUpdatePluginStoredAuth() {
  const { plugins } = useBitsentryServices();
  const port = requirePort(plugins, 'plugins');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { pluginId: string; auth: Record<string, unknown> }) =>
      port.updateStoredAuth(input.pluginId, input.auth),
    onSuccess: (result, variables) => {
      queryClient.setQueryData(queryKeys.pluginStoredAuth(variables.pluginId), result);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.pluginStoredAuth(variables.pluginId),
      });
    },
  });
}

export function useClearPluginStoredAuth() {
  const { plugins } = useBitsentryServices();
  const port = requirePort(plugins, 'plugins');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (pluginId: string) => port.clearStoredAuth(pluginId),
    onSuccess: (_result, pluginId) => {
      queryClient.setQueryData(queryKeys.pluginStoredAuth(pluginId), {});
      void queryClient.invalidateQueries({
        queryKey: queryKeys.pluginStoredAuth(pluginId),
      });
    },
  });
}

export function useExecutePluginAction() {
  const { plugins } = useBitsentryServices();
  const port = requirePort(plugins, 'plugins');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      pluginId: string;
      actionId: string;
      auth?: Record<string, unknown>;
      input?: Record<string, unknown>;
    }) => port.execute(input),
    onSuccess: (result: PluginActionExecutionResult) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.pluginDetail(result.pluginId),
      });
    },
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

export const bitsentryQueryKeys = queryKeys;
