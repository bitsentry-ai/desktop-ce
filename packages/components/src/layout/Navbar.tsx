import { customerReportDisplayText } from "@bitsentry-ce/core/features/plugins";
import React, { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { cn } from "../lib/utils";
import {
  useAppLogout,
  useAuthSession,
  useRunbooksService,
} from "../services/hooks";
import { useBitsentryServices } from "../services/context";
import {
  getDesktopApi,
  type DesktopBitsentryApi,
  type DesktopUpdaterState,
} from "../services/desktop-api";
import type {
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
  Archive,
  FileText,
  Trash2,
  Download,
  RefreshCw,
  Plug,
  PanelLeftClose,
  PanelLeftOpen,
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
import { useNavbarSubNavigation } from "./navigation-context";
import { PaletteSearchButton } from "../shortcuts/PaletteSearchButton";
import { BitSentryLogo } from "./BitSentryLogo";
import {
  SidebarEmpty,
  SidebarGroupLabel,
  SidebarHoverButton,
  SidebarMoreLink,
  SidebarRow,
  SidebarCount,
  SidebarRunStatus,
  SidebarSection,
  SidebarStatusDot,
  isNotableRunState,
  shortAge,
  type SidebarRunState,
} from "./SidebarRows";
import { useShallow } from "zustand/react/shallow";
import { useIncidentListStore } from "../investigation/incidents/incidentListStore";
import { loadDesktopIncidentList, refreshDesktopIncidentPreviews } from "../investigation/incidents/incidentListPersistence";
import { hasDesktopIncidentsApi, saveDesktopIncidentThread } from "../investigation/incidents/incidentDesktopApi";
import { normalizeIncidents } from "../investigation/incidents/incidentNormalize";
import { useNow } from "../hooks/useNow";
import { loadIncidents } from "../investigation/incidents/incidentStorage";
import type { IncidentThread } from "../investigation/incidents/types";
import {
  loadRunbookNavItems,
  readLocalRunbookNavItems,
  writeLocalRunbookNavItems,
  type RunbookNavItem,
} from "./runbook-nav";
import {
  INCIDENT_ATTENTION_CHANGED_EVENT,
  clearUnseenIncidentOutcome,
  findIncidentsNeedingInput,
  finishedRunOutcome,
  readUnseenIncidentOutcomes,
  recordUnseenIncidentOutcome,
  resolveIncidentNavStatus,
  type IncidentNavStatus,
} from "./incident-nav-status";

// The state each incident was last seen in, so a run that ends while the Navbar
// is remounted between pages still counts as finished.
const observedIncidentStates = new Map<string, string | undefined>();

// Module-level so the accordion state survives Navbar remounts within a window.
const navbarAccordionState: {
  open: Set<string>;
  autoOpenedPath: string | null;
} = { open: new Set(), autoOpenedPath: null };

function toggleNavbarAccordion(key: string): Set<string> {
  const next = new Set(navbarAccordionState.open);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  navbarAccordionState.open = next;
  return next;
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
  "/profile",
];

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
  archived: boolean;
  lastMessagePreview: string | null;
  state: string;
};

// The last nav item per thread, reused while the fields the navbar shows are unchanged.
const incidentNavItemCache = new Map<string, IncidentNavItem>();

function toIncidentNavItem(incident: IncidentThread): IncidentNavItem {
  const cached = incidentNavItemCache.get(incident.id);
  const archived = incident.archived === true;
  const lastMessagePreview = incident.lastMessagePreview ?? null;
  if (
    cached?.title === incident.title &&
    cached.createdAt === incident.createdAt &&
    cached.archived === archived &&
    cached.lastMessagePreview === lastMessagePreview &&
    cached.state === incident.state
  ) {
    return cached;
  }
  const item = {
    id: incident.id,
    title: incident.title,
    createdAt: incident.createdAt,
    archived,
    lastMessagePreview,
    state: incident.state,
  };
  incidentNavItemCache.set(incident.id, item);
  return item;
}

/** Nav items from the shared list; with `useShallow` the navbar renders only when a shown field changes. */
function selectIncidentNavItems(state: { incidents: IncidentThread[] }): IncidentNavItem[] {
  return state.incidents.map(toIncidentNavItem);
}

const SHOWN_INCIDENT_LIMIT = 7;

function shownIncidentNavItems(incidents: IncidentNavItem[]): IncidentNavItem[] {
  return incidents.filter((incident) => incident.archived !== true).slice(0, SHOWN_INCIDENT_LIMIT);
}

const INCIDENT_STATUS_LABEL_KEYS: Record<IncidentNavStatus, string> = {
  working: "navigation.navbar.incidentStatus.working",
  "needs-input": "navigation.navbar.incidentStatus.needsInput",
  failed: "navigation.navbar.incidentStatus.failed",
  completed: "navigation.navbar.incidentStatus.completed",
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function normalizeIncidentPreview(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = customerReportDisplayText(value).replace(/\s+/g, " ").trim();
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

const INCIDENT_RUN_STATE: Record<IncidentNavStatus, SidebarRunState> = {
  working: "running",
  "needs-input": "needs-input",
  failed: "failed",
  completed: "done",
};

function IncidentSubNavigation({
  incidents,
  statuses,
  search,
  formatters,
  t,
  onArchive,
}: {
  incidents: IncidentNavItem[];
  statuses: ReadonlyMap<string, IncidentNavStatus>;
  search: string;
  formatters: ReturnType<typeof useFormatters>;
  t: ReturnType<typeof useTranslation>["t"];
  onArchive: (incidentId: string, shouldNavigate: boolean) => Promise<void>;
}) {
  const now = useNow();
  const currentId = new URLSearchParams(search).get("id");
  const active = incidents.filter((incident) => incident.archived !== true);
  const isLiveIncident = (incident: IncidentNavItem) => {
    const status = statuses.get(incident.id);
    return status === "working" || status === "needs-input";
  };
  const live = active.filter(isLiveIncident);
  const rest = shownIncidentNavItems(active.filter((incident) => !isLiveIncident(incident))).slice(0, Math.max(0, SHOWN_INCIDENT_LIMIT - live.length));
  const overflow = active.length - live.length - rest.length;
  const renderRow = (incident: IncidentNavItem) => {
    const status = statuses.get(incident.id) ?? null;
    const state = status === null ? null : INCIDENT_RUN_STATE[status];
    const preview = normalizeIncidentPreview(incident.lastMessagePreview);
    return <SidebarRow
      key={incident.id}
      to={`/incidents?id=${incident.id}`}
      title={incident.title}
      active={currentId === incident.id}
      live={state !== null}
      trailing={state !== null && status !== null
        ? <SidebarRunStatus state={state} label={t(INCIDENT_STATUS_LABEL_KEYS[status])} />
        : shortAge(incident.createdAt, formatters.locale, now, t("navigation.navbar.justNow"))}
      meta={preview === null ? undefined : translateIncidentPreview(preview, t)}
      hoverAction={<SidebarHoverButton label={t("common.navbar.archiveIncident")} onClick={() => { onArchive(incident.id, currentId === incident.id).catch(console.error); }}><Archive size={12} /></SidebarHoverButton>}
    />;
  };
  return <SidebarSection>
    {live.length > 0 && <>
      <SidebarGroupLabel count={live.length}>{t("navigation.navbar.groupRunning")}</SidebarGroupLabel>
      {live.map(renderRow)}
      {rest.length > 0 && <SidebarGroupLabel>{t("navigation.navbar.groupRecent")}</SidebarGroupLabel>}
    </>}
    {rest.map(renderRow)}
    {overflow > 0 && <SidebarMoreLink to="/incidents?view=history" label={t("navigation.navbar.viewAll", { count: active.length })} />}
    {active.length === 0 && <SidebarEmpty>{t("navigation.navbar.noIncidentsYet")}</SidebarEmpty>}
  </SidebarSection>;
}

function RunbookSubNavigation({ runbooks, search, t, onDelete }: {
  runbooks: RunbookNavItem[];
  search: string;
  t: ReturnType<typeof useTranslation>["t"];
  onDelete: (runbook: Pick<RunbookNavItem, "id" | "title">) => void;
}) {
  const currentId = new URLSearchParams(search).get("id");
  const shown = runbooks.slice(0, SHOWN_INCIDENT_LIMIT);
  const overflow = runbooks.length - shown.length;
  return <SidebarSection>
    {shown.map((runbook) => <SidebarRow
      key={runbook.id}
      to={`/runbooks?id=${runbook.id}`}
      title={runbook.title}
      active={currentId === runbook.id}
      trailing={runbook.actions.length > 0 ? <SidebarCount count={runbook.actions.length} label={t("navigation.navbar.actionCount", { count: runbook.actions.length })} /> : undefined}
      hoverAction={<SidebarHoverButton tone="danger" label={t("common.navbar.deleteRunbook")} onClick={() => { onDelete(runbook); }}><Trash2 size={12} /></SidebarHoverButton>}
    />)}
    {overflow > 0 && <SidebarMoreLink to="/runbooks" label={t("navigation.navbar.viewAll", { count: runbooks.length })} />}
    {runbooks.length === 0 && <SidebarEmpty>{t("navigation.navbar.noRunbooksYet")}</SidebarEmpty>}
  </SidebarSection>;
}

function resultRunState(status: string): SidebarRunState {
  if (status === "running") return "running";
  if (status === "queued" || status === "pending") return "queued";
  if (status === "failed" || status === "claim_expired") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "completed") return "completed";
  return "idle";
}

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

/** Keeps the current list when a reload reads the same rows, so the navbar does not re-render. */
function keepIfSameNavItems<T extends object>(next: T[]): (prev: T[]) => T[] {
  return (prev) => {
    const same = prev.length === next.length && prev.every((item, index) => {
      const a = item as Record<string, unknown>;
      const b = next[index] as Record<string, unknown>;
      const keys = Object.keys(a);
      return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
    });
    return same ? prev : next;
  };
}

type NavbarServices = ReturnType<typeof useBitsentryServices>;

/** Web mode: the incidents page owns the list on its own route; elsewhere the navbar loads it into the store. */
async function loadWebIncidentList(
  services: NavbarServices,
  currentPath: string,
  isCancelled: () => boolean,
): Promise<void> {
  const { loaded, setAll } = useIncidentListStore.getState();
  if (currentPath.startsWith("/incidents")) {
    if (!loaded) setAll(loadIncidents());
    return;
  }
  const incidents = services.incidents;
  if (incidents === undefined) {
    setAll(loadIncidents());
    return;
  }
  try {
    const response = await incidents.listThreads({ limit: 100, includeArchived: true });
    if (!isCancelled()) setAll(normalizeIncidents(response.threads));
  } catch {
    if (!isCancelled()) setAll(loadIncidents());
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

/** Archives the thread in the web mode local-storage list, keeping a first archive time. */
function archiveLocalIncident(incidentId: string, archivedAt: string): void {
  const raw = localStorage.getItem("bitsentry_incidents");
  const parsed: unknown = raw === null ? [] : JSON.parse(raw);
  const all: unknown[] = Array.isArray(parsed) ? parsed : [];
  const updated = all.map((incident) => archiveIncidentRecord(incident, incidentId, archivedAt));
  localStorage.setItem("bitsentry_incidents", JSON.stringify(updated));
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
  { icon: Search, labelKey: "navigation.navbar.diagnosis", href: "/diagnosis" },
  {
    icon: ShieldAlert,
    labelKey: "navigation.navbar.incidents",
    href: "/incidents",
  },
  { icon: BookOpen, labelKey: "navigation.navbar.runbooks", href: "/runbooks" },
  // The Dashboard renders its own navbar; this entry is the Desktop Integrations page.
  {
    icon: Plug,
    labelKey: "navigation.navbar.integrations",
    href: "/integrations",
    desktopOnly: true,
  },
  { icon: FileText, labelKey: "navigation.navbar.results", href: "/results" },
  // Ticket/Resolution are Dashboard-only surfaces. They remain in primaryNav so
  // the web Dashboard renders them, and are listed in desktopHiddenHrefs below so
  // the desktop CE app hides them.
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
  { labelKey: "navigation.navbar.userManagement", hash: "users" },
  { labelKey: "navigation.navbar.externalSources", hash: "external-sources" },
  { labelKey: "navigation.navbar.globalVariables", hash: "global-variables" },
  { labelKey: "navigation.navbar.llmProviders", hash: "llm-providers" },
  { labelKey: "navigation.navbar.dataPolicy", hash: "data-policy" },
  { labelKey: "navigation.navbar.help", hash: "help" },
  { labelKey: "navigation.navbar.about", hash: "about" },
] as const;

const appSettingsSections = [
  { labelKey: "navigation.navbar.appearance", hash: "appearance" },
  { labelKey: "navigation.navbar.plugins", hash: "plugins" },
  { labelKey: "navigation.navbar.globalVariables", hash: "global-variables" },
  { labelKey: "navigation.navbar.codingAgents", hash: "coding-agents" },
  { labelKey: "common.shortcuts.title", hash: "shortcuts" },
  { labelKey: "navigation.navbar.help", hash: "help" },
] as const;

const profileSections = [
  { labelKey: "common.profile.overview", hash: "overview" },
  { labelKey: "common.systemSettings.sessionSecurity", hash: "sessions" },
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
  "/diagnosis",
  "/tickets",
  "/resolution",
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
    // A promise chain, not try/finally, which the React Compiler can't lower.
    const runUpdate = async () => {
      if (isDownloaded) {
        await api.install();
      } else {
        await api.download();
      }
    };
    await runUpdate().finally(() => {
      setBusy(false);
    });
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
        <div className="bs-brand-tint-subtitle truncate text-xs">
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
  const now = useNow();
  const location = useLocation();
  // Narrow windows fold the sidebar into an icon rail (CSS); this opens it over the page.
  // Open for the page it was opened on, so navigating closes it without an extra render.
  const railLocation = `${location.pathname}${location.search}`;
  const [railOpenFor, setRailOpenFor] = useState<string | null>(null);
  const railExpanded = railOpenFor === railLocation;
  const setRailExpanded = (open: boolean | ((current: boolean) => boolean)) => {
    const next = typeof open === "function" ? open(railExpanded) : open;
    setRailOpenFor(next ? railLocation : null);
  };
  useEffect(() => {
    if (!railExpanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRailOpenFor(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [railExpanded]);
  const navigate = useNavigate();
  const currentPath = location.pathname;
  const { user } = useAuthSession();
  const logout = useAppLogout();
  const runbooks = useRunbooksService();
  const services = useBitsentryServices();
  const subNavigation = useNavbarSubNavigation();
  const userRoleId = user?.role?.id;

  // Persist across remounts: pages such as Incidents render a separate
  // DashboardLayout for list and detail views, so a nav click that also
  // changes the view would otherwise remount the navbar and lose the toggle.
  const [openAccordions, setOpenAccordions] = useState<Set<string>>(
    () => new Set(navbarAccordionState.open),
  );

  // ── Delete Runbook Dialog ─────────────────────────────────────────────────
  const [runbookToDelete, setRunbookToDelete] = React.useState<{
    id: string;
    title: string;
  } | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = React.useState("");
  const [isDeletingRunbook, setIsDeletingRunbook] = React.useState(false);
  const [runbookItems, setRunbookItems] = React.useState<RunbookNavItem[]>([]);

  const handleConfirmDeleteRunbook = async () => {
    if (runbookToDelete === null) return;
    if (deleteConfirmText !== runbookToDelete.title) return;

    setIsDeletingRunbook(true);
    try {
      await runbooks.delete(runbookToDelete.id);
      const nextRunbooks = await runbooks.list();

      writeLocalRunbookNavItems(nextRunbooks);
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
    }
    // No finally (the React Compiler can't lower one); the catch above never throws.
    setIsDeletingRunbook(false);
  };

  // ── Incidents ────────────────────────────────────────────────────────────
  const investigationIncidents = useIncidentListStore(useShallow(selectIncidentNavItems));

  const incidentsAccordionOpen = openAccordions.has("/incidents");
  React.useEffect(() => {
    if (isDesktop || !incidentsAccordionOpen) return;
    let cancelled = false;
    loadWebIncidentList(services, currentPath, () => cancelled).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentPath, incidentsAccordionOpen, services]);

  // The navbar is global, so it loads the desktop list until a load from main succeeds. After that, opening the
  // accordion refreshes previews of turns that settled while no incidents page was listening.
  React.useEffect(() => {
    if (!isDesktop || !incidentsAccordionOpen || !hasDesktopIncidentsApi()) return;
    const load = useIncidentListStore.getState().loadedFrom === "desktop" ? refreshDesktopIncidentPreviews() : loadDesktopIncidentList();
    load.catch((error: unknown) => {
      console.error("Failed to load incidents for the navbar:", error);
    });
  }, [incidentsAccordionOpen]);

  // Off the Incidents page nothing applies agent progress to the list, so follow it here to keep the sidebar status
  // live. On the page both patch the same state, which is a no-op the second time.
  React.useEffect(() => {
    const agent = services.agent;
    if (agent === undefined) return;
    return agent.onEvent((payload) => {
      const threadState = payload.kind === "message" ? payload.threadState : payload.snapshot?.threadState;
      if (threadState === undefined) return;
      const store = useIncidentListStore.getState();
      const incident = store.incidents.find((item) => item.sessionId === payload.sessionId);
      if (incident !== undefined) store.patch(incident.id, { state: threadState });
    });
  }, [services.agent]);

  const currentIncidentId = currentPath.startsWith("/incidents")
    ? new URLSearchParams(location.search).get("id")
    : null;
  const [unseenOutcomes, setUnseenOutcomes] = React.useState(readUnseenIncidentOutcomes);

  React.useEffect(() => {
    let changed = false;
    for (const incident of investigationIncidents) {
      const outcome = finishedRunOutcome(observedIncidentStates.get(incident.id), incident.state);
      observedIncidentStates.set(incident.id, incident.state);
      if (outcome !== null && incident.id !== currentIncidentId) {
        recordUnseenIncidentOutcome(incident.id, outcome);
        changed = true;
      }
    }
    if (currentIncidentId !== null && clearUnseenIncidentOutcome(currentIncidentId)) {
      changed = true;
    }
    if (changed) setUnseenOutcomes(readUnseenIncidentOutcomes());
  }, [currentIncidentId, investigationIncidents]);

  const [needsInputIds, setNeedsInputIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [attentionVersion, setAttentionVersion] = React.useState(0);

  React.useEffect(() => {
    const recheck = () => setAttentionVersion((version) => version + 1);
    window.addEventListener(INCIDENT_ATTENTION_CHANGED_EVENT, recheck);
    return () => {
      window.removeEventListener(INCIDENT_ATTENTION_CHANGED_EVENT, recheck);
    };
  }, []);

  // A draft or question arrives when a run ends, so look again whenever a
  // shown incident changes state rather than on every streamed update.
  const shownIncidents = shownIncidentNavItems(investigationIncidents);
  const settledIncidentIds = shownIncidents
    .filter((incident) => incident.state !== "RUNNING")
    .map((incident) => incident.id)
    .join(",");
  const shownIncidentStates = shownIncidents
    .map((incident) => incident.state ?? "")
    .join(",");
  const incidentsOpen = openAccordions.has("/incidents");

  React.useEffect(() => {
    if (!incidentsOpen || settledIncidentIds.length === 0) return;
    let cancelled = false;
    void findIncidentsNeedingInput(settledIncidentIds.split(","), {
      agent: services.agent,
      plugins: services.plugins,
    }).then((ids) => {
      if (!cancelled) setNeedsInputIds(ids);
    });
    return () => {
      cancelled = true;
    };
  }, [
    attentionVersion,
    incidentsOpen,
    services.agent,
    services.plugins,
    settledIncidentIds,
    shownIncidentStates,
  ]);

  const incidentStatuses = new Map<string, IncidentNavStatus>();
  for (const incident of shownIncidents) {
    const status = resolveIncidentNavStatus({
      state: incident.state,
      needsInput: needsInputIds.has(incident.id),
      unseenOutcome:
        incident.id === currentIncidentId ? undefined : unseenOutcomes[incident.id],
    });
    if (status !== null) incidentStatuses.set(incident.id, status);
  }

  const handleArchiveIncidentNavItem = async (incidentId: string) => {
    const archivedAt = new Date().toISOString();

    if (services.incidents) {
      await services.incidents.archiveThread(incidentId);
      archiveLocalIncident(incidentId, archivedAt);
    } else if (isDesktop && hasDesktopIncidentsApi()) {
      // Once main's list is loaded, the store subscription saves the archive. Only the archive time is
      // patched, so a concurrent rename or state change is kept.
      if (useIncidentListStore.getState().loadedFrom !== "desktop") await saveDesktopIncidentThread({ id: incidentId, archivedAt });
    } else if (!isDesktop) {
      archiveLocalIncident(incidentId, archivedAt);
    } else {
      return;
    }
    useIncidentListStore.getState().archive(incidentId, archivedAt);
  };

  React.useEffect(() => {
    if (!openAccordions.has("/runbooks")) return;
    let cancelled = false;

    const load = async () => {
      const items = await loadRunbookNavItems(runbooks);
      if (!cancelled) {
        setRunbookItems(items);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [currentPath, openAccordions, runbooks, user?.email, user?.id]);

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
      setResultItems(keepIfSameNavItems(readLocalResultNavItems()));
    };
    window.addEventListener("bitsentry:results-updated", reload);
    return () => {
      window.removeEventListener("bitsentry:results-updated", reload);
    };
  }, [runbooks]);

  // ── Accordion helpers ─────────────────────────────────────────────────────
  const toggleAccordion = (key: string) => {
    setOpenAccordions(toggleNavbarAccordion(key));
  };

  React.useEffect(() => {
    // Auto-open only when the path actually changes. A remount on the same
    // path (for example closing an incident detail) must keep a user toggle.
    if (navbarAccordionState.autoOpenedPath === currentPath) return;
    navbarAccordionState.autoOpenedPath = currentPath;
    if (
      ACCORDION_PAGES.includes(currentPath) ||
      subNavigation[currentPath] !== undefined
    ) {
      const next = new Set([...navbarAccordionState.open, currentPath]);
      navbarAccordionState.open = next;
      setOpenAccordions(next);
    }
  }, [currentPath, subNavigation]);

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

  let navHeaderClass = "px-4 pt-4 pb-2.5";
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
    <nav
      className="bs-sidebar nav-rail h-screen w-[17rem] shrink-0 flex flex-col"
      data-expanded={railExpanded ? "true" : undefined}
    >
      <div className={navHeaderClass}>
        <Link
          to="/"
          className="bs-sidebar-brand flex items-center gap-2 text-sm font-semibold text-foreground"
        >
          <BitSentryLogo />
          <span className="bs-sidebar-label">{t("navigation.navbar.bitsentry")}</span>
        </Link>
      </div>

      <div className="bs-sidebar-railbar hidden flex-col items-center gap-1.5 pb-2">
        <BitSentryLogo />
        <button
          type="button"
          onClick={() => {
            setRailExpanded((open) => !open);
          }}
          aria-expanded={railExpanded}
          aria-label={t(railExpanded ? "navigation.navbar.collapseSidebar" : "navigation.navbar.expandSidebar")}
          title={t(railExpanded ? "navigation.navbar.collapseSidebar" : "navigation.navbar.expandSidebar")}
          className="bs-sidebar-railtoggle flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {railExpanded ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          {/* In the rail the toggle reads "Recent": it opens the full sidebar with recent incidents, runbooks and results. */}
          {!railExpanded && (
            <span aria-hidden="true" className="bs-sidebar-railtoggle-label hidden">
              {t("navigation.navbar.railRecent")}
            </span>
          )}
        </button>
      </div>

      <div className="px-3 pt-1">
        <PaletteSearchButton />
      </div>

      <div className="flex flex-col gap-1 px-3 pt-3 flex-grow overflow-y-auto">
        {visiblePrimary.map((item) => {
          const isDiagnosis = item.href === "/diagnosis";
          const isIncidents = item.href === "/incidents";
          const isRunbooks = item.href === "/runbooks";
          const isResultsNav = item.href === "/results";
          const itemSubNavigation = subNavigation[item.href];
          const hasSubNav =
            (!isDesktop && isDiagnosis) ||
            isIncidents ||
            isRunbooks ||
            isResultsNav ||
            (!isDesktop && itemSubNavigation !== undefined);
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
                title={t(item.labelKey)}
                className={cn(
                  "nav-item",
                  currentPath === item.href && "active",
                )}
              >
                <ItemIcon size={16} />
                <span className="bs-sidebar-label flex-1">{t(item.labelKey)}</span>
                {PrimaryChevron !== null && (
                  <PrimaryChevron size={14} className="bs-sidebar-label text-muted-foreground" />
                )}
              </Link>

              {/* Diagnosis Sub-Navigation */}
              {canShowSubNav &&
                isDiagnosis &&
                (() => {
                  const currentTab =
                    new URLSearchParams(location.search).get("tab") ??
                    "records";
                  const subItems = [
                    {
                      tab: "records",
                      label: t("dashboard.index.records"),
                    },
                    {
                      tab: "activity",
                      label: t("dashboard.index.activity"),
                    },
                  ];
                  return (
                    <SidebarSection>
                      {subItems.map((sub) => (
                        <SidebarRow
                          key={`diagnosis-sub-${sub.tab}`}
                          to={`/diagnosis?tab=${sub.tab}`}
                          title={sub.label}
                          active={currentPath === "/diagnosis" && currentTab === sub.tab}
                        />
                      ))}
                    </SidebarSection>
                  );
                })()}

              {/* Incidents Sub-Navigation */}
              {canShowSubNav &&
                isIncidents &&
                <IncidentSubNavigation incidents={investigationIncidents} statuses={incidentStatuses} search={location.search} formatters={formatters} t={t} onArchive={async (incidentId, shouldNavigate) => { await handleArchiveIncidentNavItem(incidentId); if (shouldNavigate) navigate("/incidents"); }} />}

              {/* Runbooks Sub-Navigation */}
              {canShowSubNav &&
                isRunbooks &&
                <RunbookSubNavigation runbooks={runbookItems} search={location.search} t={t} onDelete={setRunbookToDelete} />}

              {/* Results Sub-Navigation */}
              {canShowSubNav &&
                isResultsNav &&
                (() => {
                  const currentId = new URLSearchParams(location.search).get(
                    "id",
                  );
                  const shown = resultItems.slice(0, SHOWN_INCIDENT_LIMIT);
                  const overflow = resultItems.length - shown.length;
                  const resultStateLabel = (state: SidebarRunState) => {
                    if (state === "running") return t("navigation.navbar.statusRunning");
                    if (state === "queued") return t("navigation.navbar.statusQueued");
                    if (state === "completed") return t("navigation.navbar.statusCompleted");
                    if (state === "cancelled") return t("navigation.navbar.statusCancelled");
                    if (state === "idle") return t("navigation.navbar.statusIdle");
                    return t("navigation.navbar.statusFailed");
                  };

                  return (
                    <SidebarSection>
                      {shown.map((result) => {
                        const state = resultRunState(result.status);
                        return (
                          <SidebarRow
                            key={result.id}
                            to={`/results?id=${result.id}`}
                            title={result.runbookTitle}
                            active={currentId === result.id}
                            leading={<SidebarStatusDot state={state} label={resultStateLabel(state)} />}
                            live={isNotableRunState(state)}
                            trailing={isNotableRunState(state)
                              ? <SidebarRunStatus state={state} label={resultStateLabel(state)} />
                              : shortAge(result.startedAt, formatters.locale, now, t("navigation.navbar.justNow"))}
                          />
                        );
                      })}
                      {overflow > 0 && <SidebarMoreLink to="/results?view=history" label={t("navigation.navbar.viewAll", { count: resultItems.length })} />}
                      {shown.length === 0 && <SidebarEmpty>{t("navigation.navbar.noResultsYet")}</SidebarEmpty>}
                    </SidebarSection>
                  );
                })()}

              {canShowSubNav && itemSubNavigation}

            </React.Fragment>
          );
        })}
      </div>

      <div className="border-t border-border px-3 py-2 flex flex-col gap-1">
        {visibleBottom.map((item) => {
          const isAdminSettingsItem = item.href === "/settings";
          const isAppSettingsItem = item.href === "/app-settings";
          const isProfileItem = item.href === "/profile";
          // App settings lists its sections inside the page, so the sidebar item is a plain link.
          const isSettingsItem = isAdminSettingsItem || isProfileItem;
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
          } else if (isProfileItem) {
            settingsSections = profileSections;
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
                title={t(item.labelKey)}
                className={cn("nav-item", isActive && "active")}
              >
                <item.icon size={16} />
                <span className="bs-sidebar-label flex-1">{t(item.labelKey)}</span>
                {SettingsChevron !== null && (
                  <SettingsChevron
                    size={14}
                    className="bs-sidebar-label text-muted-foreground"
                  />
                )}
              </Link>

              {isSettingsItem && isOpen && (
                <SidebarSection>
                  {settingsSections.map(({ labelKey, hash }, index) => (
                    <SidebarRow
                      key={hash}
                      to={`${item.href}#${hash}`}
                      title={t(labelKey)}
                      active={
                        currentPath === item.href &&
                        (location.hash === `#${hash}` ||
                          (!location.hash && index === 0))
                      }
                    />
                  ))}
                </SidebarSection>
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
