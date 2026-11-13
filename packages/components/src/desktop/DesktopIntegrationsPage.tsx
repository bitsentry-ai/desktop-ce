import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "@bitsentry-ce/i18n";
import DashboardLayout from "../layout/DashboardLayout";
import { IntegrationConnectionsPanel, type IntegrationConnectionsPort } from "../integrations/IntegrationConnectionsPanel";
import { useBitsentryServices } from "../services/context";
import { Button } from "../ui/button";

/** Desktop Integrations page: the shared connections panel over the local plugin services, with credentials kept on this machine. */
export default function DesktopIntegrationsPage() {
  const { t } = useTranslation();
  const { plugins } = useBitsentryServices();
  const service = useMemo<IntegrationConnectionsPort | null>(() => plugins?.listConnections && plugins.saveConnection && plugins.removeConnection ? {
    list: plugins.listConnections.bind(plugins), listPlugins: plugins.list.bind(plugins), save: plugins.saveConnection.bind(plugins), remove: plugins.removeConnection.bind(plugins),
  } : null, [plugins]);
  return (
    <DashboardLayout>
      <div className="mb-8">
        <h1 className="text-lg font-semibold text-foreground">{t("navigation.navbar.integrations")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.integrationConnections.pageDescription")}</p>
      </div>
      <div className="max-w-2xl rounded-md border border-border p-6">
        {service === null
          ? <p className="text-sm text-muted-foreground">{t("settings.integrationConnections.unavailable")}</p>
          : <IntegrationConnectionsPanel
            service={service}
            emptyAction={<Button asChild size="sm" variant="outline"><Link to="/app-settings#plugins">{t("settings.integrationConnections.openPlugins")}</Link></Button>}
          />}
      </div>
    </DashboardLayout>
  );
}
