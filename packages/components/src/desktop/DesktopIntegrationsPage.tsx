import { Link } from "react-router-dom";
import { Plug } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import DashboardLayout from "../layout/DashboardLayout";
import { IntegrationConnectionsPanel, type IntegrationConnectionsPort } from "../integrations/IntegrationConnectionsPanel";
import { useBitsentryServices } from "../services/context";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";

/**
 * Desktop Integrations page: the shared connections panel over the local plugin services, with credentials kept on
 * this machine. The panel lays out its own cards (saved connections, then the form that adds one), so the page only
 * caps their width.
 */
export default function DesktopIntegrationsPage() {
  const { t } = useTranslation();
  const { plugins } = useBitsentryServices();
  const service: IntegrationConnectionsPort | null = plugins?.listConnections && plugins.saveConnection && plugins.removeConnection ? {
    list: plugins.listConnections.bind(plugins), listPlugins: plugins.list.bind(plugins), save: plugins.saveConnection.bind(plugins), remove: plugins.removeConnection.bind(plugins),
  } : null;
  return (
    // The same frame as the Dashboard's Integrations page: a header bar with the 18px title, then content in a 16px
    // gutter (24px from 640px), so titles line up with the first column of content.
    <DashboardLayout mainClassName="flex flex-col overflow-hidden p-0">
      <div className="bs-page-header flex min-h-[3.25rem] shrink-0 items-center gap-2 border-b border-border px-4 py-2 sm:px-6">
        <h1 className="flex-1 truncate text-lg font-semibold tracking-[-0.015em] text-foreground">{t("navigation.navbar.integrations")}</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <p className="mb-6 text-sm text-muted-foreground">{t("settings.integrationConnections.pageDescription")}</p>
        <div className="max-w-[880px]">
          {service === null
            ? <div className="rounded-lg border border-border bg-card"><EmptyState icon={Plug} title={t("settings.integrationConnections.unavailable")} className="py-10" /></div>
            : <IntegrationConnectionsPanel
              service={service}
              emptyAction={<Button asChild><Link to="/app-settings#plugins">{t("settings.integrationConnections.openPlugins")}</Link></Button>}
            />}
        </div>
      </div>
    </DashboardLayout>
  );
}
