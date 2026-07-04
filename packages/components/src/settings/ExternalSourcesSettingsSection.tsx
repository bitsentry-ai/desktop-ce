import DataSourcesManager from "../integrations/DataSourcesManager";

interface ExternalSourcesSettingsSectionProps {
  id?: string;
  className?: string;
}

export function ExternalSourcesSettingsSection({
  id = "plugins",
  className,
}: ExternalSourcesSettingsSectionProps) {
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
