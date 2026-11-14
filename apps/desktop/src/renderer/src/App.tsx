import { lazy } from "react";
import { DesktopRendererApp } from "@bitsentry-ce/components/desktop/DesktopRendererApp";
import "@bitsentry-ce/components/desktop/desktop-app.css";

const AppSettings = lazy(() => import("./pages/app-settings/AppSettings"));

export default function App() {
  return <DesktopRendererApp AppSettingsPage={AppSettings} />;
}
