import { useMemo } from "react";
import { useBitsentryServices } from "../services/context";
import { IntegrationConnectionsSection } from "./IntegrationConnectionsSection";
import DataSourcesManager from "../integrations/DataSourcesManager";

interface PluginsSettingsSectionProps {
  id?: string;
  className?: string;
}

export function PluginsSettingsSection({
  id = "plugins",
  className,
}: PluginsSettingsSectionProps) {
  const { plugins } = useBitsentryServices();
  const connections = useMemo(() => plugins?.listConnections && plugins.saveConnection && plugins.removeConnection ? {
    list: plugins.listConnections.bind(plugins), save: plugins.saveConnection.bind(plugins), remove: plugins.removeConnection.bind(plugins),
  } : null, [plugins]);
  return (
    <section
      id={id}
      data-tour="settings-external-sources"
      className={className}
    >
      {connections !== null && <IntegrationConnectionsSection service={connections} />}
      <DataSourcesManager showHeader={true} />
    </section>
  );
}
