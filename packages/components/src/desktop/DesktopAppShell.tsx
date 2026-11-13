import { useEffect, type ComponentType } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Toaster } from '../ui/toaster'
import { Toaster as Sonner } from '../ui/sonner'
import { TooltipProvider } from '../ui/tooltip'
import IncidentsPage from '../investigation/Incidents'
import RunbookResultsPage from '../runbook/Results'
import DesktopIntegrationsPage from './DesktopIntegrationsPage'
import { getDesktopConnectionStatus } from '../services/desktop-local-services'
import {
  TourDataSourcesPreview,
  TourIncidentsPreview,
  TourRunbookCreationPreview,
  TourRunbooksPreview,
  TourResultsPreview,
  TourSettingsPreview,
  useTour,
} from '../tutorial'
import { DesktopBetaFeedbackPrompts } from './DesktopBetaFeedbackPrompts'
import { captureDesktopAnalyticsEvent } from './DesktopPosthogRenderer'
import OfflineIndicator from './OfflineIndicator'
import UpdateBanner from './UpdateBanner'

type DesktopAppShellProps = {
  AppSettingsPage: ComponentType
  RunbookPage: ComponentType
  DesktopRouteTracing: ComponentType
  captureDesktopPageview: (pathname: string) => void
  includeExtendedTourRoutes?: boolean
}

function DesktopPageTracker({
  captureDesktopPageview,
}: {
  captureDesktopPageview: (pathname: string) => void
}) {
  const location = useLocation()

  useEffect(() => {
    captureDesktopPageview(location.pathname)
  }, [captureDesktopPageview, location.pathname])

  return null
}

export function DesktopAppShell({
  AppSettingsPage,
  RunbookPage,
  DesktopRouteTracing,
  captureDesktopPageview,
  includeExtendedTourRoutes = false,
}: DesktopAppShellProps) {
  const { start: startTour } = useTour('main')

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void startTour()
    }, 500)

    return () => {
      window.clearTimeout(timer)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <TooltipProvider>
      <DesktopRouteTracing />
      <DesktopPageTracker captureDesktopPageview={captureDesktopPageview} />
      <DesktopBetaFeedbackPrompts
        captureDesktopAnalyticsEvent={captureDesktopAnalyticsEvent}
      />
      <OfflineIndicator getDesktopConnectionStatus={getDesktopConnectionStatus} />
      <UpdateBanner />
      <Toaster />
      <Sonner />
      <Routes>
        <Route path="/app-settings" element={<AppSettingsPage />} />
        <Route path="/incidents" element={<IncidentsPage />} />
        <Route path="/runbooks" element={<RunbookPage />} />
        <Route path="/results" element={<RunbookResultsPage />} />
        <Route path="/integrations" element={<DesktopIntegrationsPage />} />

        <Route path="/tour/incidents" element={<TourIncidentsPreview />} />
        <Route path="/tour/runbooks" element={<TourRunbooksPreview />} />
        <Route path="/tour/results" element={<TourResultsPreview />} />

        {includeExtendedTourRoutes && (
          <>
            <Route path="/tour/settings" element={<TourSettingsPreview />} />
            <Route
              path="/tour/runbook-creation"
              element={<TourRunbookCreationPreview />}
            />
            <Route
              path="/tour/data-sources"
              element={<TourDataSourcesPreview />}
            />
          </>
        )}

        <Route path="*" element={<Navigate to="/incidents" replace />} />
      </Routes>
    </TooltipProvider>
  )
}
