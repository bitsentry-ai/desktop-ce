import { useMemo } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  useDeleteErrorSource,
  useErrorSources,
  useSyncErrorSource,
} from "../services/hooks";
import { useTranslation } from "@bitsentry-ce/i18n";
import { RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface ExternalSourcesSettingsSectionProps {
  id?: string;
  className?: string;
}

function formatDate(value: string | null, t: (key: string) => string): string {
  if (value === null || value.length === 0) {
    return t("common.dataSourcesManager.never");
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function formatSyncStatus(
  value: string | null,
  t: (key: string) => string,
): string {
  switch (value) {
    case "in_progress":
      return t("common.dataSourcesManager.syncInProgress");
    case "success":
      return t("common.dataSourcesManager.lastSyncSucceeded");
    case "failed":
      return t("common.dataSourcesManager.lastSyncFailed");
    default:
      if (value !== null && value.length > 0) {
        return value.replace(/_/g, " ");
      }

      return "";
  }
}

export function ExternalSourcesSettingsSection({
  id = "external-sources",
  className,
}: ExternalSourcesSettingsSectionProps) {
  const { t } = useTranslation();
  const { data: sources = [], isLoading } = useErrorSources();
  const deleteMutation = useDeleteErrorSource();
  const syncMutation = useSyncErrorSource();

  const sortedSources = useMemo(
    () =>
      [...sources].sort((left, right) => left.name.localeCompare(right.name)),
    [sources],
  );

  return (
    <section id={id} data-tour="settings-external-sources" className={className}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              {t("common.dataSourcesManager.externalSources")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("common.dataSourcesManager.connectExternalServicesToFeed")}
            </p>
          </div>
          <Button size="sm" variant="outline" disabled>
            {t("common.dataSourcesManager.installPlugin")}
          </Button>
        </div>

        {isLoading && (
          <p className="text-sm text-muted-foreground">
            {t("common.dataSourcesManager.loadingExternalSources")}
          </p>
        )}

        {!isLoading && sortedSources.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <p className="text-sm text-muted-foreground">
              {t("common.dataSourcesManager.noExternalSourcesConnected")}
            </p>
          </div>
        )}

        {!isLoading && sortedSources.length > 0 && (
          <div className="rounded-lg border border-border divide-y divide-border">
            {sortedSources.map((source) => {
              const syncing = source.lastSyncStatus === "in_progress";
              let refreshClassName: string | undefined;
              if (syncing) {
                refreshClassName = "animate-spin";
              }
              const syncSummary = [
                t("common.dataSourcesManager.lastSyncAt", {
                  value: formatDate(source.lastSyncAt, t),
                }),
                formatSyncStatus(source.lastSyncStatus, t),
              ]
                .filter((part) => part.length > 0)
                .join(" - ");

              return (
                <div
                  key={source.id}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {source.name}
                      </span>
                      <Badge variant="secondary">{source.sourceType}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {syncSummary}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      <span className="block">
                        {t("common.dataSourcesManager.autoDiagnosis")}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        {t("common.dataSourcesManager.autoDiagnosisHelp")}
                      </span>
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        syncMutation.mutate(
                          {
                            id: source.id,
                            logLevelThreshold: source.logLevelThreshold,
                            syncEnabled: source.syncEnabled,
                          },
                          {
                            onSuccess: () => {
                              toast.success(
                                t("common.dataSourcesManager.syncCompleteForSource", {
                                  source: source.name,
                                }),
                              );
                            },
                            onError: (error) => {
                              let message = t(
                                "common.dataSourcesManager.syncFailedForSource",
                                { source: source.name },
                              );
                              if (error instanceof Error) {
                                message = error.message;
                              }
                              toast.error(message);
                            },
                          },
                        );
                      }}
                      disabled={syncMutation.isPending || syncing}
                      aria-label={t("common.dataSourcesManager.syncNow")}
                      title={t("common.dataSourcesManager.syncNow")}
                      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                    >
                      <RefreshCw
                        size={16}
                        aria-hidden="true"
                        className={refreshClassName}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        deleteMutation.mutate(source.id, {
                          onSuccess: () => {
                            toast.success(
                              t("common.dataSourcesManager.removedSource", {
                                name: source.name,
                              }),
                            );
                          },
                          onError: (error) => {
                            let message = t(
                              "common.dataSourcesManager.removeSource",
                            );
                            if (error instanceof Error) {
                              message = error.message;
                            }
                            toast.error(message);
                          },
                        });
                      }}
                      disabled={deleteMutation.isPending}
                      aria-label={t("common.dataSourcesManager.removeSource")}
                      title={t("common.dataSourcesManager.removeSource")}
                      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-red-600 disabled:opacity-50"
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
