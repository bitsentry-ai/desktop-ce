import { DesktopAppSettingsPage } from "@bitsentry-ce/components/desktop/DesktopAppSettingsPage";
import { useDesktopPrimaryAgentSelection } from "@bitsentry-ce/components/desktop/useDesktopCodingAgentPrimary";
import { captureDesktopAnalyticsEvent } from "@bitsentry-ce/components/desktop/DesktopPosthogRenderer";

export default function AppSettings() {
  const state = useDesktopPrimaryAgentSelection({
    captureDesktopAnalyticsEvent,
  });

  return (
    <DesktopAppSettingsPage
      primaryAgent={state.primaryAgent}
      isPrimarySelectionPending={state.isPrimarySelectionPending}
      onSetPrimaryAgent={state.handleSetPrimaryAgent}
    />
  );
}
