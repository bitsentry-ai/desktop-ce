import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { cn } from "../lib/utils";
import {
  useAppLogout,
  useAuthSession,
  useDiagnosisResults,
  useDiagnosisTickets,
  useResolvedTickets,
  useRunbooksService,
} from "../services/hooks";
import { useBitsentryServices } from "../services/context";
import {
  getDesktopApi,
  type DesktopBitsentryApi,
  type DesktopUpdaterState,
} from "../services/desktop-api";
import type {
  DiagnosisRecord,
  DiagnosisTicket,
  ResolvedTicketDetails,
} from "../services";
import {
  Settings,
  Search,
  User,
  LogOut,
  ChevronDown,
  ChevronRight,
  ShieldAlert,
  BookOpen,
  Ticket,
  CheckCircle2,
  AlertTriangle,
  Archive,
  FileText,
  Trash2,
  Download,
  RefreshCw,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { useFormatters, useTranslation } from "@bitsentry-ce/i18n";

function getLatestDiagnosisState(record: DiagnosisRecord): string {
  if (record.state_history.length === 0) return "pending";
  return record.state_history[record.state_history.length - 1].toState;
}

function formatResolutionType(
  value: ResolvedTicketDetails["resolutionType"],
): string {
  if (value === undefined || value === null || value.length === 0) {
    return "Resolved";
  }

  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getDiagnosisDotClass(latestState: string): string {
  if (latestState === "verification_pending") return "bg-amber-400";
  if (latestState === "completed" || latestState === "verified") {
    return "bg-emerald-400";
  }
  if (latestState === "failed") return "bg-red-400";
  return "bg-muted-foreground/30";
}

function getResultDotClass(status: string): string {
  if (status === "running") return "bg-amber-400";
  if (status === "completed") return "bg-emerald-400";
  return "bg-muted-foreground/30";
}

const ACCORDION_PAGES = [
  "/app-settings",
  "/settings",
  "/diagnosis",
  "/incidents",
  "/runbooks",
  "/results",
  "/tickets",
  "/resolution",
];

function highlightElement(targetId: string) {
  const element = document.getElementById(targetId);
  if (element === null) return;

  element.scrollIntoView({ behavior: "smooth", block: "center" });
  element.classList.add("ring-2", "ring-primary");
  window.setTimeout(() => {
    element.classList.remove("ring-2", "ring-primary");
  }, 2000);
}

interface QuickAnchorLinkProps {
  anchorId: string;
  children: React.ReactNode;
  currentHash: string;
  currentPath: string;
  targetPath: string;
  title?: string;
}

const QuickAnchorLink = ({
  anchorId,
  children,
  currentHash,
  currentPath,
  targetPath,
  title,
}: QuickAnchorLinkProps) => (
  <Link
    to={`${targetPath}#${anchorId}`}
    title={title}
    onClick={() => {
      if (currentPath === targetPath) {
        window.setTimeout(() => {
          highlightElement(anchorId);
        }, 0);
      }
    }}
    className={cn(
      "block w-full rounded-md px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-neutral-100/50 hover:text-foreground dark:hover:bg-white/10",
      currentPath === targetPath &&
        currentHash === `#${anchorId}` &&
        "bg-neutral-100/50 text-foreground font-medium dark:bg-white/10",
    )}
  >
    {children}
  </Link>
);

type NavItem = {
  icon: React.ElementType;
  labelKey: string;
  href: string;
  restrictedTo?: number[];
  desktopOnly?: boolean;
};

type IncidentNavItem = {
  id: string;
  title: string;
  createdAt: string;
  archived?: boolean;
  lastMessagePreview?: string | null;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function normalizeIncidentPreview(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return null;
  return normalized;
}

const NO_LLM_PROVIDER_CONFIGURED_MESSAGE =
  "No LLM provider configured. Please configure a provider in Settings.";

function translateIncidentPreview(
  preview: string,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const normalized = preview.replace(/^Error:\s*/i, "").trim();
  if (normalized === NO_LLM_PROVIDER_CONFIGURED_MESSAGE) {
    return t("common.incidents.noLlmProviderConfigured");
  }

  return preview;
}

type ResultNavItem = {
  id: string;
  runbookTitle: string;
  status: string;
  startedAt: string;
  completedAt?: string;
};

type RunbookNavItem = {
  id: string;
  title: string;
  actions: unknown[];
};

const UPDATE_ISLAND_DEBUG_STORAGE_KEY = "bitsentry_debug_update_island";

function readDebugUpdateIslandState(): "available" | "downloaded" | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage
      .getItem(UPDATE_ISLAND_DEBUG_STORAGE_KEY)
      ?.trim()
      .toLowerCase();

    if (raw === "available" || raw === "downloaded") {
      return raw;
    }
  } catch {
    // Ignore localStorage access errors and fall back to real updater state.
  }

  return null;
}

function normalizeIncidentNavItems(items: unknown[]): IncidentNavItem[] {
  return items
    .map((item): IncidentNavItem | null => {
      if (!isRecord(item)) return null;
      const record = item;
      if (typeof record.id !== "string" || record.id.length === 0) return null;

      let title = "New Incident";
      if (typeof record.title === "string" && record.title.trim().length > 0) {
        title = record.title.trim();
      }

      let createdAt = new Date().toISOString();
      if (typeof record.createdAt === "string" && record.createdAt.length > 0) {
        createdAt = record.createdAt;
      }

      let archived: boolean | undefined;
      if (
        record.archived === true ||
        (typeof record.archivedAt === "string" && record.archivedAt.length > 0)
      ) {
        archived = true;
      }

      let lastMessagePreview: string | null = null;
      if (typeof record.lastMessagePreview === "string") {
        lastMessagePreview = normalizeIncidentPreview(
          record.lastMessagePreview,
        );
      }

      return {
        id: record.id,
        title,
        createdAt,
        lastMessagePreview,
        archived,
      };
    })
    .filter((item): item is IncidentNavItem => item !== null);
}

function readLocalIncidentNavItems(): IncidentNavItem[] {
  try {
    const raw = localStorage.getItem("bitsentry_incidents");
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeIncidentNavItems(parsed);
  } catch {
    return [];
  }
}

function normalizeResultNavItems(items: unknown[]): ResultNavItem[] {
  return items
    .map((item): ResultNavItem | null => {
      if (!isRecord(item)) return null;
      const record = item;

      let id: string | null = null;
      if (typeof record.id === "string" && record.id.length > 0) {
        id = record.id;
      } else if (
        typeof record.executionId === "string" &&
        record.executionId.length > 0
      ) {
        id = record.executionId;
      }

      if (id === null) return null;

      let runbookTitle = "Runbook Result";
      if (
        typeof record.runbookTitle === "string" &&
        record.runbookTitle.trim().length > 0
      ) {
        runbookTitle = record.runbookTitle.trim();
      }

      let status = "failed";
      if (typeof record.status === "string" && record.status.length > 0) {
        status = record.status;
      }

      let startedAt = new Date().toISOString();
      if (typeof record.startedAt === "string" && record.startedAt.length > 0) {
        startedAt = record.startedAt;
      }

      let completedAt: string | undefined;
      if (
        typeof record.completedAt === "string" &&
        record.completedAt.length > 0
      ) {
        completedAt = record.completedAt;
      }

      return {
        id,
        runbookTitle,
        status,
        startedAt,
        completedAt,
      };
    })
    .filter((item): item is ResultNavItem => item !== null);
}

function normalizeRunbookNavItems(items: unknown[]): RunbookNavItem[] {
  return items
    .map((item): RunbookNavItem | null => {
      if (!isRecord(item)) return null;
      if (typeof item.id !== "string" || item.id.length === 0) return null;

      let title = "Untitled Runbook";
      if (typeof item.title === "string" && item.title.trim().length > 0) {
        title = item.title.trim();
      }

      let actions: unknown[] = [];
      if (Array.isArray(item.actions)) {
        actions = item.actions;
      }

      return { id: item.id, title, actions };
    })
    .filter((item): item is RunbookNavItem => item !== null);
}

function readLocalRunbookNavItems(): RunbookNavItem[] {
  try {
    const raw = localStorage.getItem("bitsentry_runbooks");
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeRunbookNavItems(parsed);
  } catch {
    return [];
  }
}

function archiveIncidentRecord(
  value: unknown,
  incidentId: string,
  archivedAt: string,
): unknown {
  if (!isRecord(value)) return value;
  if (value.id !== incidentId) return value;

  let nextArchivedAt = archivedAt;
  if (typeof value.archivedAt === "string" && value.archivedAt.length > 0) {
    nextArchivedAt = value.archivedAt;
  }

  return {
    ...value,
    archived: true,
    archivedAt: nextArchivedAt,
  };
}

function readLocalResultNavItems(): ResultNavItem[] {
  try {
    const raw =
      localStorage.getItem("bitsentry_results") ??
      localStorage.getItem("bitsentry_investigations");
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeResultNavItems(parsed);
  } catch {
    return [];
  }
}

// Detect if running in Desktop
let desktopApi: DesktopBitsentryApi | undefined;
if (typeof window !== "undefined") {
  desktopApi = getDesktopApi();
}
const isDesktop = desktopApi !== undefined;
const desktopPlatform = desktopApi?.platform?.os;
const isDesktopMac = isDesktop && desktopPlatform === "darwin";

const primaryNav: NavItem[] = [
  {
    icon: ShieldAlert,
    labelKey: "navigation.navbar.incidents",
    href: "/incidents",
  },
  { icon: BookOpen, labelKey: "navigation.navbar.runbooks", href: "/runbooks" },
  { icon: FileText, labelKey: "navigation.navbar.results", href: "/results" },
  { icon: Search, labelKey: "navigation.navbar.diagnosis", href: "/diagnosis" },
  {
    icon: Ticket,
    labelKey: "navigation.navbar.ticketManagement",
    href: "/tickets",
  },
  {
    icon: CheckCircle2,
    labelKey: "navigation.navbar.resolutionManagement",
    href: "/resolution",
  },
];

const bottomNav: NavItem[] = [
  { icon: User, labelKey: "navigation.navbar.profile", href: "/profile" },
  {
    icon: Settings,
    labelKey: "navigation.navbar.adminSettings",
    href: "/settings",
    restrictedTo: [1],
  },
  {
    icon: Settings,
    labelKey: "navigation.navbar.settings",
    href: "/app-settings",
  },
];

const adminSettingsSections = [
  { labelKey: "navigation.navbar.systemSettings", hash: "system" },
  { labelKey: "navigation.navbar.passwordSecurity", hash: "password-security" },
  { labelKey: "navigation.navbar.sessionSecurity", hash: "session-security" },
  { labelKey: "navigation.navbar.userManagement", hash: "users" },
  { labelKey: "navigation.navbar.externalSources", hash: "external-sources" },
  { labelKey: "navigation.navbar.globalVariables", hash: "global-variables" },
  { labelKey: "navigation.navbar.llmProviders", hash: "llm-providers" },
  { labelKey: "navigation.navbar.help", hash: "help" },
  { labelKey: "navigation.navbar.about", hash: "about" },
] as const;

const appSettingsSections = [
  { labelKey: "navigation.navbar.appearance", hash: "appearance" },
  { labelKey: "navigation.navbar.plugins", hash: "plugins" },
  { labelKey: "navigation.navbar.globalVariables", hash: "global-variables" },
  { labelKey: "navigation.navbar.codingAgents", hash: "coding-agents" },
  { labelKey: "navigation.navbar.help", hash: "help" },
] as const;

export type SettingsSectionLink = {
  labelKey: string;
  hash: string;
};

const filterByRole = (items: NavItem[], roleId?: number) =>
  items.filter((item) => {
    if (item.desktopOnly === true && !isDesktop) return false;
    if (item.restrictedTo === undefined) return true;
    if (roleId === undefined) return false;
    return item.restrictedTo.includes(roleId);
  });
const webHiddenHrefs = new Set(["/app-settings"]);
const desktopHiddenHrefs = new Set([
  "/profile",
  "/settings",
  "/tickets",
  "/resolution",
  "/diagnosis",
]);

function UpdateIslandButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [state, setState] = useState<DesktopUpdaterState | null>(null);
  const [busy, setBusy] = useState(false);
  const [debugState, setDebugState] = useState<
    "available" | "downloaded" | null
  >(() => readDebugUpdateIslandState());

  useEffect(() => {
    const api = getDesktopApi()?.updater;
    if (api === undefined) return;

    let cancelled = false;

    void api.getState().then((next: DesktopUpdaterState) => {
      if (!cancelled) setState(next);
    });

    const unsubscribe = api.onState((next: DesktopUpdaterState) => {
      if (!cancelled) setState(next);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === UPDATE_ISLAND_DEBUG_STORAGE_KEY) {
        setDebugState(readDebugUpdateIslandState());
      }
    };

    const refreshDebugState = () => {
      setDebugState(readDebugUpdateIslandState());
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener("focus", refreshDebugState);
    document.addEventListener("visibilitychange", refreshDebugState);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("focus", refreshDebugState);
      document.removeEventListener("visibilitychange", refreshDebugState);
    };
  }, []);

  let previewState: DesktopUpdaterState | null = null;
  if (
    debugState !== null &&
    (state === null ||
      (state.status !== "available" && state.status !== "downloaded"))
  ) {
    previewState = {
      status: debugState,
      availableVersion: t("common.navbar.preview"),
      downloadedVersion: t("common.navbar.preview"),
    };
  }

  const effectiveState = previewState ?? state;
  if (effectiveState === null) return null;
  const isPreview = previewState !== null;
  const isAvailable = effectiveState.status === "available";
  const isDownloaded = effectiveState.status === "downloaded";
  if (!isAvailable && !isDownloaded) return null;

  let label = t("common.navbar.updateAvailable");
  let detail =
    effectiveState.availableVersion ?? t("common.navbar.downloadNow");
  let Icon = Download;
  if (isDownloaded) {
    label = t("common.navbar.restartToUpdate");
    detail =
      effectiveState.downloadedVersion ?? t("common.navbar.readyToInstall");
    Icon = RefreshCw;
  }

  const handleClick = async () => {
    const api = getDesktopApi()?.updater;
    if (busy) return;

    if (isPreview) {
      void navigate("/app-settings#appearance");
      return;
    }

    if (api === undefined) return;

    setBusy(true);
    try {
      if (isDownloaded) {
        await api.install();
      } else {
        await api.download();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={busy}
      className={cn(
        "mb-2 flex w-full items-center gap-2 rounded-2xl border px-3 py-2.5 text-left shadow-sm transition-colors",
        "bs-brand-tint",
        "disabled:cursor-default disabled:opacity-70",
      )}
    >
      <div className="bs-brand-tint-icon flex h-7 w-7 items-center justify-center rounded-full">
        <Icon size={12} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="bs-brand-tint-title truncate text-xs font-medium">
          {label}
        </div>
        <div className="bs-brand-tint-subtitle truncate text-[11px]">
          {detail}
        </div>
      </div>
    </button>
  );
}

interface NavbarProps {
  adminSettingsExtraSections?: readonly SettingsSectionLink[];
  appSettingsExtraSections?: readonly SettingsSectionLink[];
}

const Navbar = ({
  adminSettingsExtraSections = [],
  appSettingsExtraSections = [],
}: NavbarProps) => {
  const { t } = useTranslation();
  const formatters = useFormatters();
  const location = useLocation();
  const navigate = useNavigate();
  const currentPath = location.pathname;
  const currentHash = location.hash;
  const { user } = useAuthSession();
  const logout = useAppLogout();
  const runbooks = useRunbooksService();
  const services = useBitsentryServices();
  const userRoleId = user?.role?.id;

  const [openAccordions, setOpenAccordions] = useState<Set<string>>(new Set());

  // ── Delete Runbook Dialog ─────────────────────────────────────────────────
  const [runbookToDelete, setRunbookToDelete] = React.useState<{
    id: string;
    title: string;
  } | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = React.useState("");
  const [isDeletingRunbook, setIsDeletingRunbook] = React.useState(false);

  const handleConfirmDeleteRunbook = React.useCallback(async () => {
    if (runbookToDelete === null) return;
    if (deleteConfirmText !== runbookToDelete.title) return;

    setIsDeletingRunbook(true);
    try {
      await runbooks.delete(runbookToDelete.id);
      const nextRunbooks = await runbooks.list();

      localStorage.setItem("bitsentry_runbooks", JSON.stringify(nextRunbooks));
      setRunbookItems(nextRunbooks);

      const currentId = new URLSearchParams(location.search).get("id");
      if (currentId === runbookToDelete.id) {
        void navigate("/runbooks");
      }

      window.dispatchEvent(new CustomEvent("bitsentry:runbooks-updated"));
      setRunbookToDelete(null);
      setDeleteConfirmText("");
    } catch (error) {
      console.error("Failed to delete runbook from navbar:", error);
    } finally {
      setIsDeletingRunbook(false);
    }
  }, [deleteConfirmText, location.search, navigate, runbookToDelete, runbooks]);

  // ── Incidents ────────────────────────────────────────────────────────────
  const [investigationIncidents, setInvestigationIncidents] = React.useState<
    IncidentNavItem[]
  >([]);

  React.useEffect(() => {
    if (!openAccordions.has("/incidents")) return;
    let cancelled = false;
    const load = async () => {
      if (!isDesktop) {
        if (currentPath.startsWith("/incidents") || !services.incidents) {
          setInvestigationIncidents(readLocalIncidentNavItems());
          return;
        }

        try {
          const response = await services.incidents.listThreads({
            limit: 100,
            includeArchived: true,
          });
          if (cancelled) return;
          setInvestigationIncidents(
            normalizeIncidentNavItems(response.threads),
          );
        } catch {
          if (!cancelled) {
            setInvestigationIncidents(readLocalIncidentNavItems());
          }
        }
        return;
      }
      try {
        const incidentsApi = getDesktopApi()?.incidents;
        if (incidentsApi === undefined) {
          setInvestigationIncidents(readLocalIncidentNavItems());
          return;
        }

        const snapshot = await incidentsApi.getState();
        if (cancelled) return;
        let nextItems = normalizeIncidentNavItems(snapshot.incidents);
        if (nextItems.length === 0) {
          nextItems = readLocalIncidentNavItems();
        }
        setInvestigationIncidents(nextItems);
      } catch {
        if (!cancelled) {
          setInvestigationIncidents(readLocalIncidentNavItems());
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [currentPath, openAccordions, services.incidents]);

  React.useEffect(() => {
    const reload = () => {
      setInvestigationIncidents(readLocalIncidentNavItems());
    };
    window.addEventListener("bitsentry:incidents-updated", reload);
    return () => {
      window.removeEventListener("bitsentry:incidents-updated", reload);
    };
  }, []);

  const handleArchiveIncidentNavItem = React.useCallback(
    async (incidentId: string) => {
      const archivedAt = new Date().toISOString();

      if (services.incidents) {
        await services.incidents.archiveThread(incidentId);
        setInvestigationIncidents((prev) =>
          prev.map((incident) => {
            if (incident.id !== incidentId) return incident;
            return { ...incident, archived: true };
          }),
        );
        window.dispatchEvent(
          new CustomEvent("bitsentry:incidents-updated", {
            detail: { action: "archive", incidentId, archivedAt },
          }),
        );
        return;
      }

      if (isDesktop) {
        const incidentsApi = getDesktopApi()?.incidents;
        if (incidentsApi === undefined) return;

        const snapshot = await incidentsApi.getState();
        const updated = snapshot.incidents.map((incident) =>
          archiveIncidentRecord(incident, incidentId, archivedAt),
        );
        await incidentsApi.replaceState({
          incidents: updated,
          incidentMessages: snapshot.incidentMessages,
        });
        setInvestigationIncidents(normalizeIncidentNavItems(updated));
      } else {
        const raw = localStorage.getItem("bitsentry_incidents");
        let all: unknown[] = [];
        if (raw !== null) {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            all = parsed;
          }
        }
        const updated = all.map((incident) =>
          archiveIncidentRecord(incident, incidentId, archivedAt),
        );
        localStorage.setItem("bitsentry_incidents", JSON.stringify(updated));
        setInvestigationIncidents(normalizeIncidentNavItems(updated));
      }

      window.dispatchEvent(
        new CustomEvent("bitsentry:incidents-updated", {
          detail: { action: "archive", incidentId, archivedAt },
        }),
      );
    },
    [services.incidents],
  );

  // ── Runbooks ─────────────────────────────────────────────────────────────
  const [runbookItems, setRunbookItems] = React.useState<RunbookNavItem[]>([]);

  React.useEffect(() => {
    if (!openAccordions.has("/runbooks")) return;
    setRunbookItems(readLocalRunbookNavItems());
  }, [openAccordions, currentPath]);

  React.useEffect(() => {
    const reload = () => {
      setRunbookItems(readLocalRunbookNavItems());
    };
    window.addEventListener("bitsentry:runbooks-updated", reload);
    return () => {
      window.removeEventListener("bitsentry:runbooks-updated", reload);
    };
  }, []);

  // ── Results ───────────────────────────────────────────────────────────────
  const [resultItems, setResultItems] = React.useState<ResultNavItem[]>([]);

  const { data: diagnosisData } = useDiagnosisResults({ limit: 100 });
  const { data: ticketsData } = useDiagnosisTickets();
  const { data: resolvedData } = useResolvedTickets({
    limit: 8,
    sortBy: "ticketResolvedAt",
    sortOrder: "desc",
  });

  React.useEffect(() => {
    if (!openAccordions.has("/results")) return;
    let cancelled = false;

    const load = async () => {
      if (isDesktop) {
        setResultItems(readLocalResultNavItems());
        return;
      }

      if (currentPath.startsWith("/results")) {
        setResultItems(readLocalResultNavItems());
        return;
      }

      try {
        const response = await runbooks.listExecutions({ limit: 100 });
        if (cancelled) return;

        const nextItems = normalizeResultNavItems(
          response.executions.map((execution) => ({
            id: execution.executionId,
            runbookTitle: execution.runbookTitle,
            status: execution.status,
            startedAt: execution.startedAt,
            completedAt: execution.completedAt,
          })),
        );

        setResultItems(nextItems);
      } catch {
        if (!cancelled) {
          setResultItems(readLocalResultNavItems());
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [openAccordions, currentPath, runbooks]);

  React.useEffect(() => {
    const reload = () => {
      if (isDesktop) {
        setResultItems(readLocalResultNavItems());
        return;
      }

      setResultItems(readLocalResultNavItems());
    };
    window.addEventListener("bitsentry:results-updated", reload);
    return () => {
      window.removeEventListener("bitsentry:results-updated", reload);
    };
  }, [runbooks]);

  // ── Accordion helpers ─────────────────────────────────────────────────────
  const toggleAccordion = (key: string) => {
    setOpenAccordions((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  React.useEffect(() => {
    if (ACCORDION_PAGES.includes(currentPath)) {
      setOpenAccordions((prev) => new Set([...prev, currentPath]));
    }
  }, [currentPath]);

  const diagnosisQuickItems = useMemo(() => {
    return (diagnosisData?.records ?? []).slice(0, 7);
  }, [diagnosisData]);

  const ticketQuickItems = useMemo(() => {
    const eligibleStates = [
      "llm_assessed",
      "verification_pending",
      "verified",
      "completed",
    ];
    const diagnosesWithoutTickets: DiagnosisRecord[] = [];
    const diagnosesWithTickets: DiagnosisTicket[] = [];

    if (!diagnosisData?.records || !ticketsData) {
      return {
        diagnosesWithoutTickets,
        diagnosesWithTickets,
      };
    }

    const ticketMap = new Map<number, DiagnosisTicket>();
    ticketsData.forEach((ticket) => {
      ticketMap.set(ticket.diagnosisId, ticket);
    });

    diagnosisData.records.forEach((diagnosis) => {
      const ticket = ticketMap.get(diagnosis.id);

      if (ticket) {
        diagnosesWithTickets.push(ticket);
        return;
      }

      const latestState = getLatestDiagnosisState(diagnosis);
      if (eligibleStates.includes(latestState)) {
        diagnosesWithoutTickets.push(diagnosis);
      }
    });

    return {
      diagnosesWithoutTickets,
      diagnosesWithTickets,
    };
  }, [diagnosisData, ticketsData]);

  let hiddenHrefs = webHiddenHrefs;
  if (isDesktop) {
    hiddenHrefs = desktopHiddenHrefs;
  }
  const visiblePrimary = filterByRole(primaryNav, userRoleId).filter(
    (item) => !hiddenHrefs.has(item.href),
  );
  const visibleBottom = filterByRole(bottomNav, userRoleId).filter(
    (item) => !hiddenHrefs.has(item.href),
  );

  let navHeaderClass = "px-4 py-5";
  if (isDesktop) {
    let desktopPaddingClass = "pl-4";
    if (isDesktopMac) {
      desktopPaddingClass = "pl-[100px]";
    }
    navHeaderClass = cn(
      "drag-region h-12 flex items-center pr-4",
      desktopPaddingClass,
    );
  }

  return (
    <nav className="nav-rail h-screen w-60 flex flex-col">
      <div className={navHeaderClass}>
        <Link to="/" className="text-sm font-semibold text-foreground">
          {t("navigation.navbar.bitsentry")}
        </Link>
      </div>

      <div className="flex flex-col gap-1 px-3 pt-3 flex-grow overflow-y-auto">
        {visiblePrimary.map((item) => {
          const isDiagnosis = item.href === "/diagnosis";
          const isIncidents = item.href === "/incidents";
          const isRunbooks = item.href === "/runbooks";
          const isResultsNav = item.href === "/results";
          const isTicketManagement = item.href === "/tickets";
          const isResolutionManagement = item.href === "/resolution";
          const hasSubNav =
            (!isDesktop && isDiagnosis) ||
            isIncidents ||
            isRunbooks ||
            isResultsNav ||
            (!isDesktop && (isTicketManagement || isResolutionManagement));
          const accordionKey = item.href;
          const isOpen = openAccordions.has(accordionKey);
          const canShowSubNav = hasSubNav && isOpen;
          const ItemIcon = item.icon;

          const tourKey =
            item.href.replace(/^\//, "").replace(/\//g, "-") || "home";

          let PrimaryChevron: React.ElementType | null = null;
          if (hasSubNav) {
            PrimaryChevron = ChevronRight;
            if (isOpen) {
              PrimaryChevron = ChevronDown;
            }
          }

          return (
            <React.Fragment key={item.href}>
              <Link
                to={item.href}
                data-tour={`nav-${tourKey}`}
                onClick={() => {
                  if (hasSubNav) {
                    toggleAccordion(accordionKey);
                  }
                }}
                className={cn(
                  "nav-item",
                  currentPath === item.href && "active",
                )}
              >
                <ItemIcon size={16} />
                <span className="flex-1">{t(item.labelKey)}</span>
                {PrimaryChevron !== null && (
                  <PrimaryChevron size={14} className="text-muted-foreground" />
                )}
              </Link>

              {/* Diagnosis Sub-Navigation */}
              {canShowSubNav && isDiagnosis && (
                <div className="ml-4 mt-1 space-y-0.5">
                  {diagnosisQuickItems.map((diagnosis) => {
                    const currentId = new URLSearchParams(location.search).get(
                      "id",
                    );
                    const latestState = getLatestDiagnosisState(diagnosis);
                    const isActive =
                      currentPath === "/diagnosis" &&
                      currentId === String(diagnosis.id);
                    const dotCls = getDiagnosisDotClass(latestState);
                    const diagnosisId = String(diagnosis.id);

                    return (
                      <Link
                        key={`diagnosis-nav-${diagnosisId}`}
                        to={`/diagnosis?id=${diagnosisId}`}
                        title={
                          diagnosis.rule_description ||
                          diagnosis.description ||
                          t("navigation.navbar.diagnosisNumber", {
                            id: diagnosis.id,
                          })
                        }
                        onClick={() => {
                          if (currentPath === "/diagnosis") {
                            window.setTimeout(() => {
                              highlightElement(`diagnosis-${diagnosisId}`);
                            }, 0);
                          }
                        }}
                        className={cn(
                          "flex items-start gap-2 rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-neutral-100/50 hover:text-foreground dark:hover:bg-white/10",
                          isActive &&
                            "bg-neutral-100/50 text-foreground font-medium dark:bg-white/10",
                        )}
                      >
                        <span
                          className={cn(
                            "mt-1 size-1.5 shrink-0 rounded-full",
                            dotCls,
                          )}
                        />
                        <div className="min-w-0">
                          <div className="truncate">
                            {diagnosis.rule_description ||
                              diagnosis.description ||
                              t("navigation.navbar.diagnosisNumber", {
                                id: diagnosis.id,
                              })}
                          </div>
                          <div className="text-[10px] text-muted-foreground/60">
                            {formatters.relativeTime(diagnosis.created_at)}
                          </div>
                        </div>
                      </Link>
                    );
                  })}
                  {(diagnosisData?.records.length ?? 0) >
                    diagnosisQuickItems.length && (
                    <Link
                      to="/diagnosis"
                      className="block px-3 py-1 text-xs text-primary/80 transition-colors hover:text-primary"
                    >
                      {(diagnosisData?.records.length ?? 0) -
                        diagnosisQuickItems.length}{" "}
                      {t("navigation.navbar.more")}
                    </Link>
                  )}
                  {diagnosisQuickItems.length === 0 && (
                    <p className="px-3 py-1 text-xs text-muted-foreground/60">
                      {t("navigation.navbar.noDiagnosesYet")}
                    </p>
                  )}
                </div>
              )}

              {/* Incidents Sub-Navigation */}
              {canShowSubNav &&
                isIncidents &&
                (() => {
                  const currentId = new URLSearchParams(location.search).get(
                    "id",
                  );
                  const active = investigationIncidents.filter(
                    (incident) => incident.archived !== true,
                  );
                  const shown = active.slice(0, 7);
                  const overflow = active.length - 7;
                  return (
                    <div className="ml-4 mt-1 space-y-0.5">
                      {shown.map((inc) => {
                        const preview = normalizeIncidentPreview(
                          inc.lastMessagePreview,
                        );
                        return (
                          <div key={inc.id} className="group relative">
                            <Link
                              to={`/incidents?id=${inc.id}`}
                              className={cn(
                                "block px-3 py-1.5 pr-8 text-xs text-muted-foreground hover:text-foreground hover:bg-neutral-100/50 dark:hover:bg-white/10 rounded-md transition-colors",
                                currentId === inc.id &&
                                  "text-foreground font-medium bg-neutral-100/50 dark:bg-white/10",
                              )}
                            >
                              <div className="truncate">{inc.title}</div>
                              {preview !== null && (
                                <div className="truncate text-[10px] text-muted-foreground/60">
                                  {translateIncidentPreview(preview, t)}
                                </div>
                              )}
                              <div className="text-[10px] text-muted-foreground/50">
                                {formatters.relativeTime(inc.createdAt)}
                              </div>
                            </Link>
                            <button
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                void handleArchiveIncidentNavItem(inc.id);
                                if (currentId === inc.id) {
                                  void navigate("/incidents");
                                }
                              }}
                              className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                              title={t("common.navbar.archiveIncident")}
                            >
                              <Archive size={11} />
                            </button>
                          </div>
                        );
                      })}
                      {overflow > 0 && (
                        <Link
                          to="/incidents?view=history"
                          className="block px-3 py-1 text-xs text-primary/80 hover:text-primary transition-colors"
                        >
                          {overflow} {t("navigation.navbar.more")}
                        </Link>
                      )}
                      {active.length === 0 && (
                        <p className="px-3 py-1 text-xs text-muted-foreground/60">
                          {t("navigation.navbar.noIncidentsYet")}
                        </p>
                      )}
                    </div>
                  );
                })()}

              {/* Runbooks Sub-Navigation */}
              {canShowSubNav &&
                isRunbooks &&
                (() => {
                  const currentId = new URLSearchParams(location.search).get(
                    "id",
                  );
                  const shown = runbookItems.slice(0, 7);
                  const overflow = runbookItems.length - 7;
                  return (
                    <div className="ml-4 mt-1 space-y-0.5">
                      {shown.map((rb) => (
                        <div key={rb.id} className="group relative">
                          <Link
                            to={`/runbooks?id=${rb.id}`}
                            className={cn(
                              "block px-3 py-1.5 pr-8 text-xs text-muted-foreground hover:text-foreground hover:bg-neutral-100/50 dark:hover:bg-white/10 rounded-md transition-colors",
                              currentId === rb.id &&
                                "text-foreground font-medium bg-neutral-100/50 dark:bg-white/10",
                            )}
                          >
                            <div className="truncate">{rb.title}</div>
                            {rb.actions.length > 0 && (
                              <div className="text-[10px] text-muted-foreground/60">
                                {t("navigation.navbar.actionCount", {
                                  count: rb.actions.length,
                                })}
                              </div>
                            )}
                          </Link>
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setRunbookToDelete({
                                id: rb.id,
                                title: rb.title,
                              });
                            }}
                            className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex size-5 items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                            title={t("common.navbar.deleteRunbook")}
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      ))}
                      {overflow > 0 && (
                        <Link
                          to="/runbooks"
                          className="block px-3 py-1 text-xs text-primary/80 hover:text-primary transition-colors"
                        >
                          {overflow} {t("navigation.navbar.more")}
                        </Link>
                      )}
                      {runbookItems.length === 0 && (
                        <p className="px-3 py-1 text-xs text-muted-foreground/60">
                          {t("navigation.navbar.noRunbooksYet")}
                        </p>
                      )}
                    </div>
                  );
                })()}

              {/* Results Sub-Navigation */}
              {canShowSubNav &&
                isResultsNav &&
                (() => {
                  const currentId = new URLSearchParams(location.search).get(
                    "id",
                  );
                  const shown = resultItems.slice(0, 7);
                  const overflow = resultItems.length - shown.length;

                  return (
                    <div className="ml-4 mt-1 space-y-0.5">
                      {shown.map((result) => {
                        const dotCls = getResultDotClass(result.status);

                        return (
                          <Link
                            key={result.id}
                            to={`/results?id=${result.id}`}
                            className={cn(
                              "flex items-start gap-2 rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-neutral-100/50 hover:text-foreground dark:hover:bg-white/10",
                              currentId === result.id &&
                                "bg-neutral-100/50 text-foreground font-medium dark:bg-white/10",
                            )}
                          >
                            <span
                              className={cn(
                                "mt-1 size-1.5 shrink-0 rounded-full",
                                dotCls,
                              )}
                            />
                            <div className="min-w-0">
                              <div className="truncate">
                                {result.runbookTitle}
                              </div>
                              <div className="text-[10px] text-muted-foreground/60">
                                {formatters.relativeTime(result.startedAt)}
                              </div>
                            </div>
                          </Link>
                        );
                      })}
                      {overflow > 0 && (
                        <Link
                          to="/results?view=history"
                          className="block px-3 py-1 text-xs text-primary/80 transition-colors hover:text-primary"
                        >
                          {overflow} {t("navigation.navbar.more")}
                        </Link>
                      )}
                      {shown.length === 0 && (
                        <p className="px-3 py-1 text-xs text-muted-foreground/60">
                          {t("navigation.navbar.noResultsYet")}
                        </p>
                      )}
                    </div>
                  );
                })()}

              {/* Ticket Management Sub-Navigation */}
              {canShowSubNav && isTicketManagement && (
                <div className="ml-4 mt-1 space-y-2">
                  <div>
                    <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
                      <AlertTriangle size={10} />
                      {t("navigation.navbar.pendingCount")}
                      {ticketQuickItems.diagnosesWithoutTickets.length})
                    </div>
                    {ticketQuickItems.diagnosesWithoutTickets
                      .slice(0, 4)
                      .map((diagnosis) => {
                        const diagnosisId = String(diagnosis.id);
                        const currentPending = new URLSearchParams(
                          location.search,
                        ).get("pending");
                        const isActive =
                          currentPath === "/tickets" &&
                          currentPending === diagnosisId;
                        return (
                          <Link
                            key={`pending-${diagnosisId}`}
                            to={`/tickets?pending=${diagnosisId}`}
                            title={
                              diagnosis.rule_description ||
                              t("navigation.navbar.diagnosisNumber", {
                                id: diagnosis.id,
                              })
                            }
                            className={cn(
                              "block w-full rounded-md px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-neutral-100/50 hover:text-foreground dark:hover:bg-white/10",
                              isActive &&
                                "bg-neutral-100/50 text-foreground font-medium dark:bg-white/10",
                            )}
                          >
                            <div className="truncate">
                              {diagnosis.rule_description ||
                                t("navigation.navbar.diagnosisNumber", {
                                  id: diagnosis.id,
                                })}
                            </div>
                          </Link>
                        );
                      })}
                    {ticketQuickItems.diagnosesWithoutTickets.length === 0 && (
                      <p className="px-3 py-1 text-xs text-muted-foreground/60">
                        {t("navigation.navbar.noPendingTickets")}
                      </p>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
                      <Ticket size={10} />
                      {t("navigation.navbar.createdCount")}
                      {ticketQuickItems.diagnosesWithTickets.length})
                    </div>
                    {ticketQuickItems.diagnosesWithTickets
                      .slice(0, 4)
                      .map((ticket) => {
                        const currentTicket = new URLSearchParams(
                          location.search,
                        ).get("ticket");
                        const isActive =
                          currentPath === "/tickets" &&
                          currentTicket === ticket.id;
                        let ticketLabel = ticket.externalTicketNumber;
                        if (
                          typeof ticket.ruleDescription === "string" &&
                          ticket.ruleDescription.length > 0
                        ) {
                          ticketLabel = `${ticketLabel} • ${ticket.ruleDescription}`;
                        }
                        return (
                          <Link
                            key={`ticket-${ticket.id}`}
                            to={`/tickets?ticket=${ticket.id}`}
                            title={
                              ticket.ruleDescription ||
                              ticket.externalTicketNumber
                            }
                            className={cn(
                              "block w-full rounded-md px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-neutral-100/50 hover:text-foreground dark:hover:bg-white/10",
                              isActive &&
                                "bg-neutral-100/50 text-foreground font-medium dark:bg-white/10",
                            )}
                          >
                            <div className="truncate">{ticketLabel}</div>
                          </Link>
                        );
                      })}
                    {ticketQuickItems.diagnosesWithTickets.length === 0 && (
                      <p className="px-3 py-1 text-xs text-muted-foreground/60">
                        {t("navigation.navbar.noCreatedTickets")}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Resolution Management Sub-Navigation */}
              {canShowSubNav && isResolutionManagement && (
                <div className="ml-4 mt-1 space-y-0.5">
                  {(resolvedData?.data ?? []).slice(0, 6).map((ticket) => {
                    const currentResolved = new URLSearchParams(
                      location.search,
                    ).get("resolved");
                    const isActive =
                      currentPath === "/resolution" &&
                      currentResolved === ticket.id;
                    return (
                      <Link
                        key={`resolved-${ticket.id}`}
                        to={`/resolution?resolved=${ticket.id}`}
                        title={
                          ticket.ruleDescription || ticket.externalTicketNumber
                        }
                        className={cn(
                          "block w-full rounded-md px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-neutral-100/50 hover:text-foreground dark:hover:bg-white/10",
                          isActive &&
                            "bg-neutral-100/50 text-foreground font-medium dark:bg-white/10",
                        )}
                      >
                        <div className="truncate">
                          {formatResolutionType(ticket.resolutionType)} •{" "}
                          {ticket.ruleDescription ||
                            ticket.externalTicketNumber}
                        </div>
                      </Link>
                    );
                  })}
                  {(resolvedData?.data ?? []).length === 0 && (
                    <p className="px-3 py-1 text-xs text-muted-foreground/60">
                      {t("navigation.navbar.noResolutionsYet")}
                    </p>
                  )}
                  {(resolvedData?.meta.total ?? 0) > 6 && (
                    <Link
                      to="/resolution"
                      className="block px-3 py-1 text-xs text-primary/80 transition-colors hover:text-primary"
                    >
                      {(resolvedData?.meta.total ?? 0) - 6}{" "}
                      {t("navigation.navbar.more")}
                    </Link>
                  )}
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>

      <div className="border-t border-border px-3 py-2 flex flex-col gap-1">
        {visibleBottom.map((item) => {
          const isAdminSettingsItem = item.href === "/settings";
          const isAppSettingsItem = item.href === "/app-settings";
          const isSettingsItem = isAdminSettingsItem || isAppSettingsItem;
          const isActive = currentPath === item.href;
          const accordionKey = item.href;
          const isOpen = openAccordions.has(accordionKey);
          let settingsSections: readonly SettingsSectionLink[] = [];
          if (isAdminSettingsItem) {
            settingsSections = [
              ...adminSettingsSections,
              ...adminSettingsExtraSections,
            ];
          } else if (isAppSettingsItem) {
            settingsSections = [
              ...appSettingsSections,
              ...appSettingsExtraSections,
            ];
          }
          let SettingsChevron: React.ElementType | null = null;
          if (isSettingsItem) {
            SettingsChevron = ChevronRight;
            if (isOpen) {
              SettingsChevron = ChevronDown;
            }
          }

          const bottomTourKey =
            item.href.replace(/^\//, "").replace(/\//g, "-") || "home";

          return (
            <React.Fragment key={item.href}>
              {isDesktop && isAppSettingsItem && <UpdateIslandButton />}
              <Link
                to={item.href}
                data-tour={`nav-${bottomTourKey}`}
                onClick={() => {
                  if (isSettingsItem) {
                    toggleAccordion(accordionKey);
                  }
                }}
                className={cn("nav-item", isActive && "active")}
              >
                <item.icon size={16} />
                <span className="flex-1">{t(item.labelKey)}</span>
                {SettingsChevron !== null && (
                  <SettingsChevron
                    size={14}
                    className="text-muted-foreground"
                  />
                )}
              </Link>

              {isSettingsItem && isOpen && (
                <div className="ml-4 mt-1 space-y-1">
                  {settingsSections.map(({ labelKey, hash }, index) => (
                    <Link
                      key={hash}
                      to={`${item.href}#${hash}`}
                      className={cn(
                        "block px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-neutral-100/50 dark:hover:bg-white/10 rounded-md transition-colors",
                        currentPath === item.href &&
                          (location.hash === `#${hash}` ||
                            (!location.hash && index === 0)) &&
                          "text-foreground font-medium",
                      )}
                    >
                      {t(labelKey)}
                    </Link>
                  ))}
                </div>
              )}
            </React.Fragment>
          );
        })}

        {!isDesktop && (
          <button
            onClick={() => {
              logout();
            }}
            className="nav-item"
          >
            <LogOut size={16} />
            <span>{t("navigation.navbar.logOut")}</span>
          </button>
        )}
      </div>

      {/* Delete Runbook Confirmation Dialog */}
      <AlertDialog
        open={runbookToDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRunbookToDelete(null);
            setDeleteConfirmText("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("common.navbar.deleteRunbook_2")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("navigation.navbar.thisActionCannotBeUndone")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {runbookToDelete !== null && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {t("navigation.navbar.toDeleteThisRunbookType")}{" "}
                <span className="font-medium text-foreground">
                  {runbookToDelete.title}
                </span>{" "}
                {t("navigation.navbar.inTheBoxBelow")}
              </p>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(event) => {
                  setDeleteConfirmText(event.target.value);
                }}
                placeholder={runbookToDelete.title}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--destructive)/0.5)] transition-colors"
                autoFocus
                disabled={isDeletingRunbook}
              />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingRunbook}>
              {t("common.actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void handleConfirmDeleteRunbook();
              }}
              disabled={
                isDeletingRunbook ||
                runbookToDelete === null ||
                deleteConfirmText !== runbookToDelete.title
              }
              className="border border-destructive/30 bg-background text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              {isDeletingRunbook && t("navigation.navbar.deleting")}
              {!isDeletingRunbook && t("common.navbar.deleteRunbook_3")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </nav>
  );
};

export default Navbar;
