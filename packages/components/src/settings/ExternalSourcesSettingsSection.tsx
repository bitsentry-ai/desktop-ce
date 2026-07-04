import ErrorSourcesManager from "../integrations/ErrorSourcesManager";

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
      <ErrorSourcesManager showHeader={true} />
    </section>
  );
}
