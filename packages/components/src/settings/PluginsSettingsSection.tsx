import DataSourcesManager from "../integrations/DataSourcesManager";

interface PluginsSettingsSectionProps {
  id?: string;
  className?: string;
}

export function PluginsSettingsSection({
  id = "plugins",
  className,
}: PluginsSettingsSectionProps) {
  return (
    <section
      id={id}
      data-tour="settings-external-sources"
      className={className}
    >
      <DataSourcesManager showHeader={true} />
    </section>
  );
}
