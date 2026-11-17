import { type ReactNode } from "react";
import { Sun, Moon } from "lucide-react";
import { Button } from "../ui/button";
import { useTheme } from "../theme";
import { useConnectionStatus } from "../services/hooks";
import { getDesktopApi } from "../services/desktop-api";
import { useTranslation } from "@bitsentry-ce/i18n";
import { LanguageSwitcher } from "../ui/language-switcher";
import { SettingsRow } from "./SettingsRow";

const isDesktop = getDesktopApi() !== undefined;

interface AppearanceSettingsSectionProps {
  extraRows?: ReactNode;
}

export const AppearanceSettingsSection = ({
  extraRows,
}: AppearanceSettingsSectionProps) => {
  const { t } = useTranslation();
  const { theme, toggleTheme } = useTheme();
  let themeLabel = t("settings.appearanceSettingsSection.themeDark");
  let ThemeIcon = Sun;
  if (theme === "light") {
    themeLabel = t("settings.appearanceSettingsSection.themeLight");
    ThemeIcon = Moon;
  }

  let networkRow: ReactNode = <NetworkRow />;
  if (isDesktop) {
    networkRow = null;
  }

  return (
    <div className="rounded-lg border border-border divide-y divide-border">
      <SettingsRow
        label={t("settings.appearanceSettingsSection.theme")}
        description={t("settings.appearanceSettingsSection.switchBetweenLightAndDark")}
        controlLayout="compact"
      >
        <Button
          variant="outline"
          size="sm"
          onClick={toggleTheme}
          className="gap-2"
        >
          <ThemeIcon size={14} />
          <span>{themeLabel}</span>
        </Button>
      </SettingsRow>

      <SettingsRow
        label={t("settings.appearanceSettingsSection.language")}
        description={t("settings.appearanceSettingsSection.displayLanguageForTheInterface")}
      >
        <LanguageSwitcher
          className="w-full"
          triggerClassName="h-8 w-full text-xs whitespace-nowrap"
        />
      </SettingsRow>

      {extraRows}

      {networkRow}
    </div>
  );
};

// Web-only. BitSentry Desktop is local-first; there is no backend to be "connected" to,
// so we drop this row in the desktop renderer and show a simple browser online flag on web.
const NetworkRow = () => {
  const isConnected = useConnectionStatus();
  const { t } = useTranslation();
  let dotClassName = "bg-muted-foreground";
  let label = t("navigation.topBar.offline");
  if (isConnected) {
    dotClassName = "bg-emerald-500 dark:bg-emerald-400";
    label = t("navigation.topBar.connected");
  }

  return (
    <SettingsRow
      label={t("settings.appearanceSettingsSection.network")}
      description={t("settings.appearanceSettingsSection.whetherTheBrowserReportsAn")}
      controlLayout="compact"
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          className={`w-1.5 h-1.5 rounded-full ${dotClassName}`}
        />
        <span>{label}</span>
      </div>
    </SettingsRow>
  );
};

export default AppearanceSettingsSection;
