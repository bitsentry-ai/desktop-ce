import { lazy } from "react";
import { loadNamespaces } from "@bitsentry-ce/i18n";
import { DesktopRendererApp } from "@bitsentry-ce/components/desktop/DesktopRendererApp";
import "@bitsentry-ce/components/desktop/desktop-app.css";

const AppSettings = lazy(() =>
  Promise.all([import("./pages/app-settings/AppSettings"), loadNamespaces(["settings"])]).then(
    ([page]) => page,
  ),
);

export default function App() {
  return <DesktopRendererApp AppSettingsPage={AppSettings} />;
}
