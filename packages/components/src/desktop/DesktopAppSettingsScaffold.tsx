import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "@bitsentry-ce/i18n";
import DashboardLayout from "../layout/DashboardLayout";
import { AppearanceSettingsSection } from "../settings/AppearanceSettingsSection";
import {
  CodingAgentProvidersSection,
  type ProviderId as CodingAgentId,
} from "../settings/CodingAgentProvidersSection";
import { ExternalSourcesSettingsSection } from "../settings/ExternalSourcesSettingsSection";
import { GlobalVariablesSettingsSection } from "../settings/GlobalVariablesSettingsSection";
import { TelemetrySection } from "../settings/TelemetrySection";
import { UpdateSettingsSection } from "../settings/UpdateSettingsSection";
import { HelpSection } from "../tutorial";
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

  useEffect(() => {
    if (location.hash.length === 0) return;
    const targetId = decodeURIComponent(location.hash.slice(1));
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
  }, [location.hash]);

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

  return (
    <DashboardLayout appSettingsExtraSections={appSettingsExtraSections}>
      <div className="mb-8">
        <h1 className="text-lg font-semibold text-foreground">
          {t("settings.appSettings.settings")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("settings.appSettings.configureAppSettings")}
        </p>
      </div>

      <div className="space-y-12">
        <section id="appearance" className="scroll-mt-24">
          <div className="mb-4">
            <h2 className="text-sm font-semibold text-foreground">
              {t("navigation.navbar.appearance")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("settings.appSettings.themeLanguageAndConnectionStatus")}
            </p>
          </div>
          <AppearanceSettingsSection
            extraRows={<UpdateSettingsSection mode="row" />}
          />
        </section>

        <div className="border-t border-border" />

        <ExternalSourcesSettingsSection id="plugins" />

        <div className="border-t border-border" />

        <GlobalVariablesSettingsSection id="global-variables" />

        <div className="border-t border-border" />

        <CodingAgentProvidersSection
          primaryAgent={primaryAgent}
          isPrimarySelectionPending={isPrimarySelectionPending}
          onSetPrimaryAgent={onSetPrimaryAgent}
          captureDesktopAnalyticsEvent={captureDesktopAnalyticsEvent}
          captureRendererException={captureRendererException}
        />

        {additionalSections !== undefined && additionalSections !== null && (
          <>
            <div className="border-t border-border" />
            {additionalSections}
          </>
        )}

        <div className="border-t border-border" />

        <section
          id="help"
          data-tour={helpSectionTourMarker}
          className="scroll-mt-24"
        >
          <div className="mb-4">
            <h2 className="text-sm font-semibold text-foreground">
              {t("settings.appSettings.help")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("settings.appSettings.guidedToursAndOnboardingWalkthroughs")}
            </p>
          </div>
          <HelpSection
            navigate={(path) => {
              void navigate(path);
            }}
            excludedTourIds={["dashboard"]}
          />
        </section>

        <div className="border-t border-border" />

        <TelemetrySection />

        <div className="border-t border-border" />

        <section id="danger-zone">
          <div className="mb-4">
            <h2 className="text-sm font-semibold text-foreground">
              {t("settings.appSettings.dangerZone")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("settings.appSettings.irreversibleLocalResetActions")}
            </p>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="space-y-1.5">
                <h3 className="text-sm font-semibold text-foreground">
                  {t("settings.appSettings.resetLocalDatabase")}
                </h3>
                <p className="text-xs text-muted-foreground">
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
