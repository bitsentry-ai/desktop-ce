/**
 * Static preview of the Dashboard view for the guided tour.
 * Renders hardcoded demo data — no IPC, no network, no live source state.
 */
import { AlertTriangle, ArrowDownUp, ChevronDown, Filter } from "lucide-react";
import Navbar from "../../layout/Navbar";
import TopBar from "../../layout/TopBar";
import { cn } from "../../lib/utils";
import { useTranslation } from "@bitsentry-ce/i18n";

const DEMO_SOURCES = [
  { id: "github-issues", name: "GitHub Issues", type: "github" },
  { id: "alert-index", name: "Alert Index", type: "alert_index" },
];

const DEMO_DIAGNOSES = [
  {
    id: 1428,
    severity: "critical",
    description: "Outbound HTTPS spike on db-prod-03",
    environment: "production",
    state: "in_progress",
  },
  {
    id: 1427,
    severity: "high",
    description: "Worker queue depth above SLO",
    environment: "production",
    state: "open",
  },
  {
    id: 1426,
    severity: "medium",
    description: "Login flake on auth-service",
    environment: "staging",
    state: "resolved",
  },
];

const SEVERITY_BADGE: Record<string, string> = {
  critical: "bg-destructive/15 text-destructive",
  high: "bg-orange-500/15 text-orange-500",
  medium: "bg-amber-500/15 text-amber-500",
  low: "bg-emerald-500/15 text-emerald-500",
};

const STATE_BADGE: Record<string, string> = {
  in_progress: "bg-blue-500/15 text-blue-500",
  open: "bg-muted text-muted-foreground",
  resolved: "bg-emerald-500/15 text-emerald-500",
};

export default function TourDashboardPreview() {
  const { t } = useTranslation();
  return (
      <div className="flex h-screen overflow-hidden">
        <Navbar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <TopBar />
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-6xl px-6 py-6">
              <div className="mb-6">
                <h1 className="text-2xl font-bold tracking-tight">
                  {t("dashboard.tourDashboardPreview.diagnosisManagement")}
                                </h1>
                <p className="text-muted-foreground">
                  {t("dashboard.tourDashboardPreview.trackAndManageDiagnosesAcross")}
                                </p>
              </div>

              <div className="grid grid-cols-12 gap-6">
                <div className="col-span-12">
                  <div className="mb-3 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
                    <AlertTriangle
                      size={15}
                      className="shrink-0 text-amber-500"
                    />
                    <span>
                      {t("dashboard.tourDashboardPreview.connectMoreSourcesFromSettings")}
                                        </span>
                  </div>

                  <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-lg font-medium">{t("dashboard.tourDashboardPreview.diagnoses")}</h2>
                    <span className="text-sm text-muted-foreground">
                      {DEMO_DIAGNOSES.length} results
                    </span>
                  </div>

                  <div className="mb-4 rounded-lg border bg-card p-3">
                    <div className="flex flex-wrap items-center gap-4">
                      <div className="min-w-48">
                        <label className="mb-1 block text-xs font-medium text-muted-foreground">
                          {t("dashboard.tourDashboardPreview.externalSource")}
                                                </label>
                        <div
                          data-tour="dashboard-source-picker"
                          className="relative flex h-9 w-full items-center rounded-md border bg-background px-3 text-sm"
                        >
                          <span>{t("dashboard.tourDashboardPreview.productionGitHubIssues")}</span>
                          <ChevronDown
                            size={14}
                            className="absolute right-2 text-muted-foreground"
                          />
                        </div>
                      </div>
                      <button
                        data-tour="dashboard-sync-now"
                        type="button"
                        className="sm:ml-auto rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted"
                      >
                        {t("dashboard.tourDashboardPreview.syncNow")}
                                            </button>
                    </div>
                  </div>

                  <div className="mb-3 flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
                    <Filter size={12} />
                    <span>{t("dashboard.tourDashboardPreview.severityAny")}</span>
                    <span>{t("dashboard.tourDashboardPreview.environmentAny")}</span>
                    <span>{t("dashboard.tourDashboardPreview.stateAny")}</span>
                  </div>

                  <div
                    data-tour="dashboard-diagnoses"
                    className="rounded-md border border-border overflow-hidden"
                  >
                    <table className="w-full table-fixed">
                      <thead className="bg-secondary">
                        <tr className="text-xs font-medium uppercase text-muted-foreground">
                          <th className="py-3 px-4 text-left w-[8%]">
                            <span className="inline-flex items-center gap-1">
                              ID <ArrowDownUp size={11} />
                            </span>
                          </th>
                          <th className="py-3 px-4 text-left w-[42%]">
                            {t("dashboard.tourDashboardPreview.description")}
                                                    </th>
                          <th className="py-3 px-4 text-left">{t("dashboard.tourDashboardPreview.severity")}</th>
                          <th className="py-3 px-4 text-left">{t("dashboard.tourDashboardPreview.environment")}</th>
                          <th className="py-3 px-4 text-left">{t("dashboard.tourDashboardPreview.status")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {DEMO_DIAGNOSES.map((row) => (
                          <tr
                            key={row.id}
                            className="border-t border-border text-sm"
                          >
                            <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                              #{row.id}
                            </td>
                            <td className="px-4 py-3">{row.description}</td>
                            <td className="px-4 py-3">
                              <span
                                className={cn(
                                  "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase",
                                  SEVERITY_BADGE[row.severity],
                                )}
                              >
                                {row.severity}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-xs text-muted-foreground">
                              {row.environment}
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className={cn(
                                  "rounded-full px-2 py-0.5 text-[10px] font-medium",
                                  STATE_BADGE[row.state],
                                )}
                              >
                                {row.state.replace("_", " ")}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{t("dashboard.tourDashboardPreview.sourcesConnected")}</span>
                    {DEMO_SOURCES.map((source) => (
                      <span
                        key={source.id}
                        className="rounded-full border border-border px-2 py-0.5"
                      >
                        {source.name} ({source.type})
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
}
