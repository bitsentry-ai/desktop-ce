import { lazy, type ComponentType } from 'react'
import { loadNamespaces } from '@bitsentry-ce/i18n'
import { DesktopAppShell } from './DesktopAppShell'
import { captureDesktopPageview } from './DesktopPosthogRenderer'
import { DesktopRouteTracing } from './DesktopSentryRenderer'

const RunbookPage = lazy(() =>
  Promise.all([import('./DesktopRunbookRoute'), loadNamespaces(['runbooks'])]).then(([page]) => page),
)

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
