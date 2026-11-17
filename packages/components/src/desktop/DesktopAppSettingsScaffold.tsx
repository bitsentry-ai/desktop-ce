import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  Braces,
  Cpu,
  Keyboard,
  LifeBuoy,
  Palette,
  Puzzle,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import DashboardLayout from "../layout/DashboardLayout";
import { AppearanceSettingsSection } from "../settings/AppearanceSettingsSection";
import {
  CodingAgentProvidersSection,
  type ProviderId as CodingAgentId,
} from "../settings/CodingAgentProvidersSection";
import { PluginsSettingsSection } from "../settings/PluginsSettingsSection";
import { GlobalVariablesSettingsSection } from "../settings/GlobalVariablesSettingsSection";
import { TelemetrySection } from "../settings/TelemetrySection";
import { UpdateSettingsSection } from "../settings/UpdateSettingsSection";
import {
  settingsDescriptionClass,
  settingsLabelClass,
  settingsSectionTitleClass,
} from "../settings/SettingsRow";
import {
  SettingsSectionNav,
  type SettingsSectionNavItem,
} from "../settings/SettingsSectionNav";
import { HelpSection } from "../tutorial/HelpSection";
import { useToast } from "../hooks/use-toast";
import { Button } from "../ui/button";
import type { SettingsSectionLink } from "../layout/Navbar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { getDesktopApi } from "../services/desktop-api";
import { KeyboardShortcutsList, defaultNavigationCommands } from "../shortcuts";

const noop = () => undefined;
/** Every desktop shortcut, read-only; the palette host owns the handlers. */
const SHORTCUT_REFERENCE = defaultNavigationCommands(noop, {
  routes: { settings: "/app-settings" },
  togglePalette: noop,
  showShortcuts: noop,
  newIncident: noop,
  toggleTheme: noop,
});

type SettingsSectionMeta = {
  id: string;
  labelKey: string;
  icon: LucideIcon;
};

/** Sections the desktop sidebar also lists as `/app-settings#hash` sub-links, in the same order. */
const LEADING_SECTIONS: readonly SettingsSectionMeta[] = [
  { id: "appearance", labelKey: "navigation.navbar.appearance", icon: Palette },
  { id: "plugins", labelKey: "navigation.navbar.plugins", icon: Puzzle },
  {
    id: "global-variables",
    labelKey: "navigation.navbar.globalVariables",
    icon: Braces,
  },
  {
    id: "coding-agents",
    labelKey: "navigation.navbar.codingAgents",
    icon: SquareTerminal,
  },
  { id: "shortcuts", labelKey: "common.shortcuts.title", icon: Keyboard },
  { id: "help", labelKey: "navigation.navbar.help", icon: LifeBuoy },
];

/** Page-only sections, after any extra sections the host adds. */
const TRAILING_SECTIONS: readonly SettingsSectionMeta[] = [
  {
    id: "telemetry",
    labelKey: "settings.telemetrySection.telemetry",
    icon: Activity,
  },
  {
    id: "danger-zone",
    labelKey: "settings.appSettings.dangerZone",
    icon: TriangleAlert,
  },
];

const EXTRA_SECTION_ICONS: Record<string, LucideIcon> = {
  "llm-providers": Cpu,
  "data-policy": ShieldCheck,
};

/** Hashes that used to point inside a section on the long page. */
const NESTED_HASH_SECTIONS: Record<string, string> = {
  updates: "appearance",
};

function hashId(hash: string): string {
  if (hash.length === 0) return "";
  return decodeURIComponent(hash.slice(1));
}

function resolveActiveSectionId(
  targetId: string,
  sectionIds: readonly string[],
): string {
  if (sectionIds.includes(targetId)) return targetId;
  return NESTED_HASH_SECTIONS[targetId] ?? sectionIds[0] ?? "appearance";
}

function SectionHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-4">
      <h2 className={settingsSectionTitleClass}>{title}</h2>
      <p className={settingsDescriptionClass}>{description}</p>
    </div>
  );
}

type CaptureDesktopAnalyticsEvent = (
  event: string,
  properties?: Record<string, unknown>,
) => void;

type CaptureRendererException = (
  error: unknown,
  context?: Record<string, unknown>,
) => void;

export type DesktopAppSettingsScaffoldProps = {
  primaryAgent: CodingAgentId | null;
  isPrimarySelectionPending: boolean;
  onSetPrimaryAgent: (id: CodingAgentId) => void;
  captureDesktopAnalyticsEvent?: CaptureDesktopAnalyticsEvent;
  captureRendererException?: CaptureRendererException;
  additionalSections?: ReactNode;
  additionalDialogs?: ReactNode;
  helpSectionTourMarker?: string;
  appSettingsExtraSections?: readonly SettingsSectionLink[];
};

function formatErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return fallback;
}

export function DesktopAppSettingsScaffold({
  primaryAgent,
  isPrimarySelectionPending,
  onSetPrimaryAgent,
  captureDesktopAnalyticsEvent = () => {},
  captureRendererException,
  additionalSections,
  additionalDialogs,
  helpSectionTourMarker,
  appSettingsExtraSections,
}: DesktopAppSettingsScaffoldProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const viewedSettingsSectionRef = useRef<string | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
  const [resetConfirmationText, setResetConfirmationText] = useState("");
  const [isResettingDatabase, setIsResettingDatabase] = useState(false);

  useEffect(() => {
    let section = "overview";
    if (location.hash.length > 0) {
      section = decodeURIComponent(location.hash.slice(1));
    }
    if (viewedSettingsSectionRef.current === section) return;
    viewedSettingsSectionRef.current = section;
    captureDesktopAnalyticsEvent("desktop_settings_section_viewed", {
      section,
    });
  }, [captureDesktopAnalyticsEvent, location.hash]);

  const extraSectionIds = (appSettingsExtraSections ?? []).map(
    (section) => section.hash,
  );
  const sections: SettingsSectionMeta[] = [
    ...LEADING_SECTIONS,
    ...(appSettingsExtraSections ?? []).map((section) => ({
      id: section.hash,
      labelKey: section.labelKey,
      icon: EXTRA_SECTION_ICONS[section.hash] ?? SlidersHorizontal,
    })),
    ...TRAILING_SECTIONS,
  ];
  const targetId = hashId(location.hash);
  const activeId = resolveActiveSectionId(
    targetId,
    sections.map((section) => section.id),
  );
  // Host sections share one panel, so their hashes still scroll to the matching part of it.
  const scrollsToTarget =
    targetId !== activeId || extraSectionIds.includes(targetId);

  useEffect(() => {
    if (targetId.length === 0) return;
    if (!scrollsToTarget) {
      // A section switch shows the new section from its top.
      headerRef.current?.scrollIntoView({ block: "nearest" });
      return;
    }
    let frameId: number | null = null;
    let attempts = 0;

    const scrollToHash = () => {
      const element = document.getElementById(targetId);
      if (element !== null) {
        element.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }

      if (attempts >= 10) return;
      attempts += 1;
      frameId = window.requestAnimationFrame(scrollToHash);
    };

    frameId = window.requestAnimationFrame(scrollToHash);
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [scrollsToTarget, targetId]);

  const handleResetDatabaseDialogChange = useCallback(
    (open: boolean) => {
      if (open) {
        captureDesktopAnalyticsEvent("desktop_database_reset_requested");
      } else if (isResetDialogOpen && !isResettingDatabase) {
        captureDesktopAnalyticsEvent("desktop_database_reset_cancelled");
      }

      setIsResetDialogOpen(open);
      if (!open && !isResettingDatabase) {
        setResetConfirmationText("");
      }
    },
    [captureDesktopAnalyticsEvent, isResetDialogOpen, isResettingDatabase],
  );

  const handleResetDatabase = useCallback(async () => {
    setIsResettingDatabase(true);

    try {
      const desktopApi = getDesktopApi();
      if (typeof desktopApi?.database?.reset !== "function") {
        throw new Error("Desktop database API is unavailable.");
      }

      await desktopApi.database.reset();
      captureDesktopAnalyticsEvent("desktop_database_reset_confirmed");
      toast({
        title: t("settings.appSettings.databaseReset"),
        description: t("settings.appSettings.localSqliteDataWasReset"),
      });
      setIsResetDialogOpen(false);
      setResetConfirmationText("");
      window.localStorage.clear();
      window.sessionStorage.clear();
      window.setTimeout(() => {
        window.location.assign("/");
      }, 150);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("settings.appSettings.resetFailed"),
        description: formatErrorMessage(
          error,
          t("settings.appSettings.failedToResetLocalSqliteDatabase"),
        ),
      });
    } finally {
      setIsResettingDatabase(false);
    }
  }, [captureDesktopAnalyticsEvent, t, toast]);

  const databaseResetConfirmationText = t(
    "settings.appSettings.databaseResetConfirmationText",
  );
  const isResetConfirmationValid =
    resetConfirmationText.trim() === databaseResetConfirmationText;
  let confirmResetDatabaseLabel = t(
    "settings.appSettings.deleteAndRecreateDatabase",
  );
  if (isResettingDatabase) {
    confirmResetDatabaseLabel = t("settings.appSettings.resetting");
  }

  let codingAgentsExtra: ReactNode = null;
  if (extraSectionIds.length === 0) {
    // Without sidebar entries of their own, host sections stay under Coding Agents.
    codingAgentsExtra = additionalSections;
  }

  const sectionContent: Record<string, ReactNode> = {
    appearance: (
      <section id="appearance" className="scroll-mt-24">
        <SectionHeader
          title={t("navigation.navbar.appearance")}
          description={t(
            "settings.appSettings.themeLanguageAndConnectionStatus",
          )}
        />
        <AppearanceSettingsSection
          extraRows={<UpdateSettingsSection mode="row" />}
        />
      </section>
    ),
    plugins: <PluginsSettingsSection id="plugins" />,
    "global-variables": (
      <GlobalVariablesSettingsSection id="global-variables" />
    ),
    "coding-agents": (
      <div className="space-y-8">
        <CodingAgentProvidersSection
          primaryAgent={primaryAgent}
          isPrimarySelectionPending={isPrimarySelectionPending}
          onSetPrimaryAgent={onSetPrimaryAgent}
          captureDesktopAnalyticsEvent={captureDesktopAnalyticsEvent}
          captureRendererException={captureRendererException}
        />
        {codingAgentsExtra}
      </div>
    ),
    shortcuts: (
      <section id="shortcuts" className="scroll-mt-24">
        <SectionHeader
          title={t("common.shortcuts.title")}
          description={t("common.shortcuts.description")}
        />
        <KeyboardShortcutsList commands={SHORTCUT_REFERENCE} />
      </section>
    ),
    help: (
      <section
        id="help"
        data-tour={helpSectionTourMarker}
        className="scroll-mt-24"
      >
        <SectionHeader
          title={t("settings.appSettings.help")}
          description={t(
            "settings.appSettings.guidedToursAndOnboardingWalkthroughs",
          )}
        />
        <HelpSection
          navigate={(path) => {
            void navigate(path);
          }}
          excludedTourIds={["dashboard"]}
        />
      </section>
    ),
    telemetry: <TelemetrySection />,
    "danger-zone": (
      <section id="danger-zone" className="scroll-mt-24">
        <SectionHeader
          title={t("settings.appSettings.dangerZone")}
          description={t("settings.appSettings.irreversibleLocalResetActions")}
        />

        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <h3 className={settingsLabelClass}>
                {t("settings.appSettings.resetLocalDatabase")}
              </h3>
              <p className={settingsDescriptionClass}>
                {t("settings.appSettings.deleteTheAppAposS")}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              className="shrink-0 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive md:min-w-[160px]"
              onClick={() => {
                handleResetDatabaseDialogChange(true);
              }}
            >
              {t("settings.appSettings.resetDatabase")}
            </Button>
          </div>
        </div>
      </section>
    ),
  };
  for (const id of extraSectionIds) {
    sectionContent[id] = <div className="space-y-8">{additionalSections}</div>;
  }

  const navItems: SettingsSectionNavItem[] = sections.map((section) => ({
    id: section.id,
    label: t(section.labelKey),
    icon: section.icon,
  }));

  return (
    <DashboardLayout appSettingsExtraSections={appSettingsExtraSections}>
      <div ref={headerRef} className="mb-6 scroll-mt-3">
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-foreground">
          {t("settings.appSettings.settings")}
        </h1>
        <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
          {t("settings.appSettings.configureAppSettings")}
        </p>
      </div>

      {/*
        One section at a time, like the Dashboard settings. The hash picks the
        section, so the sidebar's `/app-settings#hash` links and this list stay
        in sync. The body is capped at 880px.
      */}
      <div className="flex flex-col gap-6 md:flex-row md:gap-10">
        <SettingsSectionNav
          items={navItems}
          activeId={activeId}
          pathname={location.pathname}
          label={t("settings.appSettings.settings")}
          selectLabel={t("settings.sectionNav.label")}
        />
        <div key={activeId} className="min-w-0 max-w-[880px] flex-1">
          {sectionContent[activeId]}
        </div>
      </div>

      {additionalDialogs}

      <Dialog
        open={isResetDialogOpen}
        onOpenChange={handleResetDatabaseDialogChange}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("settings.appSettings.resetLocalSqliteDatabase")}
            </DialogTitle>
            <DialogDescription>
              {t("settings.appSettings.thisActionIsIrreversibleTo")}{" "}
              <span className="font-medium text-foreground">
                {databaseResetConfirmationText}
              </span>{" "}
              {t("settings.appSettings.below")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("settings.appSettings.thisResetsOnlyTheLocal")}
            </p>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">
                {t("settings.appSettings.confirmationPhrase")}
              </label>
              <input
                type="text"
                value={resetConfirmationText}
                onChange={(event) => {
                  setResetConfirmationText(event.target.value);
                }}
                placeholder={databaseResetConfirmationText}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:ring-1 focus:ring-[hsl(var(--destructive)/0.5)]"
                autoFocus
                disabled={isResettingDatabase}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                handleResetDatabaseDialogChange(false);
              }}
              disabled={isResettingDatabase}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => {
                void handleResetDatabase();
              }}
              disabled={!isResetConfirmationValid || isResettingDatabase}
            >
              {confirmResetDatabaseLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
