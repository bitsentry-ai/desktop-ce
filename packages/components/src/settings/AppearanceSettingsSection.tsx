import { type ReactNode } from "react";
import { Sun, Moon } from "lucide-react";
import { cn } from "../lib/utils";
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
        <ThemeSelector theme={theme} onToggle={toggleTheme} />
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

const THEME_OPTIONS = [
  { value: "light", icon: Sun, labelKey: "settings.appearanceSettingsSection.themeLight" },
  { value: "dark", icon: Moon, labelKey: "settings.appearanceSettingsSection.themeDark" },
] as const;

/**
 * Light and Dark as one segmented control: each option shows its own icon, and the current one carries the shared
 * selection tint, so the control states what is selected rather than what a click would switch to.
 */
function ThemeSelector({ theme, onToggle }: { theme: string; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="radiogroup"
      aria-label={t("settings.appearanceSettingsSection.theme")}
      className="inline-flex rounded-md border border-border bg-background p-0.5"
    >
      {THEME_OPTIONS.map(({ value, icon: Icon, labelKey }) => {
        const selected = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => {
              if (!selected) onToggle();
            }}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-[5px] px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 max-sm:h-10",
              selected
                ? "bg-[hsl(var(--selection))] text-foreground shadow-[inset_0_0_0_1px_hsl(var(--brand-emphasis-border))]"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon size={14} aria-hidden="true" />
            {t(labelKey)}
          </button>
        );
      })}
    </div>
  );
}

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
