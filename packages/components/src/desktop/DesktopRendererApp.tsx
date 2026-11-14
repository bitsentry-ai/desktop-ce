import { lazy, type ComponentType } from 'react'
import { DesktopAppShell } from './DesktopAppShell'
import { captureDesktopPageview } from './DesktopPosthogRenderer'
import { DesktopRouteTracing } from './DesktopSentryRenderer'

const RunbookPage = lazy(() => import('./DesktopRunbookRoute'))

type DesktopRendererAppProps = {
  AppSettingsPage: ComponentType
  includeExtendedTourRoutes?: boolean
}

export function DesktopRendererApp({
  AppSettingsPage,
  includeExtendedTourRoutes = false,
}: DesktopRendererAppProps) {
  return (
    <DesktopAppShell
      AppSettingsPage={AppSettingsPage}
      RunbookPage={RunbookPage}
      DesktopRouteTracing={DesktopRouteTracing}
      captureDesktopPageview={captureDesktopPageview}
      includeExtendedTourRoutes={includeExtendedTourRoutes}
    />
  )
}
