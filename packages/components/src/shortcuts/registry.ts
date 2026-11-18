import type { ComponentType } from "react";
import {
  BookOpen,
  FileText,
  Keyboard,
  Plug,
  Search,
  Settings,
  ShieldAlert,
  SquarePen,
  SunMoon,
} from "lucide-react";
import type { ShortcutKeys } from "./keys";

export type ShortcutIcon = ComponentType<{ className?: string; size?: number | string }>;

/** Built-in groups; any other string is a custom group whose heading is the command's `groupLabel`. */
export type ShortcutGroup = "navigation" | "actions" | (string & {});

export interface ShortcutCommand {
  id: string;
  /** i18n key for the label. Used when `label` is not set. */
  labelKey?: string;
  /** Label already in the user's language, such as an incident title. */
  label?: string;
  /** A chord such as `["mod", "k"]`, or a sequence such as `["g", "i"]`. Commands without keys are palette-only. */
  keys?: ShortcutKeys;
  group: ShortcutGroup;
  icon?: ShortcutIcon;
  /** Extra words the palette search matches, such as "dark mode" for the theme toggle. */
  keywords?: readonly string[];
  /** Hidden from the palette (but still a shortcut and listed in the shortcuts list). */
  hideInPalette?: boolean;
  run: () => void;
}

export const SHORTCUT_GROUP_LABEL_KEYS: Record<string, string> = {
  navigation: "common.shortcuts.groups.navigation",
  actions: "common.shortcuts.groups.actions",
};

export type NavigationRouteName = "incidents" | "runbooks" | "results" | "integrations" | "settings";

export const DEFAULT_NAVIGATION_ROUTES: Record<NavigationRouteName, string> = {
  incidents: "/incidents",
  runbooks: "/runbooks",
  results: "/results",
  integrations: "/integrations",
  settings: "/settings",
};

export interface DefaultCommandExtras {
  /** Per-app paths; the desktop settings page is `/app-settings`. */
  routes?: Partial<Record<NavigationRouteName, string>>;
  /** Omit a route to leave its command out, such as Settings for a user without access. */
  hiddenRoutes?: readonly NavigationRouteName[];
  /** Opens or closes the palette (⌘K). */
  togglePalette?: () => void;
  /** Opens the keyboard shortcuts list (?). */
  showShortcuts?: () => void;
  /** Starts a new incident (c). */
  newIncident?: () => void;
  /** Switches between light and dark (⌘\). */
  toggleTheme?: () => void;
}

interface NavigationEntry {
  route: NavigationRouteName;
  labelKey: string;
  key: string;
  icon: ShortcutIcon;
}

const NAVIGATION_ENTRIES: readonly NavigationEntry[] = [
  { route: "incidents", labelKey: "common.shortcuts.commands.goToIncidents", key: "i", icon: ShieldAlert },
  { route: "runbooks", labelKey: "common.shortcuts.commands.goToRunbooks", key: "r", icon: BookOpen },
  { route: "results", labelKey: "common.shortcuts.commands.goToResults", key: "e", icon: FileText },
  { route: "integrations", labelKey: "common.shortcuts.commands.goToIntegrations", key: "n", icon: Plug },
  { route: "settings", labelKey: "common.shortcuts.commands.goToSettings", key: "s", icon: Settings },
];

function actionCommands(extras: DefaultCommandExtras): ShortcutCommand[] {
  const commands: ShortcutCommand[] = [];
  if (extras.togglePalette !== undefined) {
    commands.push({
      id: "palette.toggle",
      labelKey: "common.shortcuts.commands.openPalette",
      keys: ["mod", "k"],
      group: "actions",
      icon: Search,
      hideInPalette: true,
      run: extras.togglePalette,
    });
  }
  if (extras.newIncident !== undefined) {
    commands.push({
      id: "incident.new",
      labelKey: "common.shortcuts.commands.newIncident",
      keys: ["c"],
      group: "actions",
      icon: SquarePen,
      run: extras.newIncident,
    });
  }
  if (extras.showShortcuts !== undefined) {
    commands.push({
      id: "shortcuts.show",
      labelKey: "common.shortcuts.commands.showShortcuts",
      keys: ["?"],
      group: "actions",
      icon: Keyboard,
      keywords: ["keyboard", "hotkeys", "keybindings"],
      run: extras.showShortcuts,
    });
  }
  if (extras.toggleTheme !== undefined) {
    commands.push({
      id: "theme.toggle",
      labelKey: "common.shortcuts.commands.toggleTheme",
      keys: ["mod", "\\"],
      group: "actions",
      icon: SunMoon,
      keywords: ["dark", "light", "appearance"],
      run: extras.toggleTheme,
    });
  }
  return commands;
}

/**
 * The commands both apps share: `g` sequences to each section, plus the palette, new incident, shortcuts list and
 * theme toggle when the app passes their handlers.
 */
export function defaultNavigationCommands(
  navigate: (to: string) => void,
  extras: DefaultCommandExtras = {},
): ShortcutCommand[] {
  const routes = { ...DEFAULT_NAVIGATION_ROUTES, ...extras.routes };
  const hidden = new Set(extras.hiddenRoutes ?? []);
  const navigation = NAVIGATION_ENTRIES.filter((entry) => !hidden.has(entry.route)).map(
    (entry): ShortcutCommand => ({
      id: `navigate.${entry.route}`,
      labelKey: entry.labelKey,
      keys: ["g", entry.key],
      group: "navigation",
      icon: entry.icon,
      run: () => {
        navigate(routes[entry.route]);
      },
    }),
  );
  return [...navigation, ...actionCommands(extras)];
}
