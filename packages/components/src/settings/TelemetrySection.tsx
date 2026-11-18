import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { Button } from '@bitsentry-ce/components/ui/button'
import { useToast } from '@bitsentry-ce/components/hooks/use-toast'
import { useTranslation } from '@bitsentry-ce/i18n'
import { getDesktopApi, type DesktopTelemetryStatus } from '../services/desktop-api'
import { settingsDescriptionClass, settingsLabelClass, settingsPageTitleClass } from './SettingsRow'

type Translate = ReturnType<typeof useTranslation>['t']

interface TelemetrySectionProps {
  embedded?: boolean
}

function getToggleTitle(enabled: boolean, t: Translate): string {
  if (enabled) {
    return t('settings.telemetrySection.telemetryEnabled')
  }

  return t('settings.telemetrySection.telemetryDisabled')
}

function getButtonClass(enabled: boolean): string {
  if (enabled) {
    return 'text-xs h-8 min-w-[80px] text-destructive hover:bg-destructive/10 hover:text-destructive border-destructive/30'
  }

  return 'text-xs h-8 min-w-[80px]'
}

function getButtonLabel(saving: boolean, enabled: boolean, t: Translate): string {
  if (saving) {
    return t('settings.telemetrySection.saving')
  }

  if (enabled) {
    return t('settings.telemetrySection.disable')
  }

  return t('settings.telemetrySection.enable')
}

function isToggleDisabled(
  saving: boolean,
  loadError: boolean,
  enabled: boolean,
  canDisable: boolean,
): boolean {
  if (saving) return true
  if (loadError) return true

  return enabled && !canDisable
}

function renderHeader(t: Translate): ReactNode {
  return (
    <div className="mb-6">
      <h2 className={settingsPageTitleClass}>
        {t('settings.telemetrySection.telemetry')}
      </h2>
      <p className={`mt-1 ${settingsDescriptionClass}`}>
        {t('settings.telemetrySection.usageCrashReportingAndDiagnosticsPreferences')}
      </p>
    </div>
  )
}

function renderForcedTelemetryNotice(
  enabled: boolean,
  canDisable: boolean,
  t: Translate,
): ReactNode {
  if (canDisable) return null
  if (!enabled) return null

  return (
    <p className={`mt-1 ${settingsDescriptionClass}`}>
      {t('settings.telemetrySection.previewAndBetaBuildsAlwaysKeepTelemetryEnabled')}
    </p>
  )
}

function renderLoadError(loadError: boolean, t: Translate): ReactNode {
  if (!loadError) return null

  return (
    <p className="mt-1 text-[13px] leading-5 text-destructive">
      {t('settings.telemetrySection.couldNotLoadTelemetryStatus')}
    </p>
  )
}

export function TelemetrySection({ embedded = false }: TelemetrySectionProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [enabled, setEnabled] = useState(false)
  const [canDisable, setCanDisable] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    const telemetry = getDesktopApi()?.telemetry
    if (telemetry === undefined) {
      setLoadError(true)
      setLoaded(true)
      return
    }

    telemetry.getStatus().then((status: DesktopTelemetryStatus) => {
      setEnabled(status.enabled)
      setCanDisable(status.canDisable)
      setLoadError(false)
      setLoaded(true)
    }).catch(() => {
      setLoadError(true)
      setLoaded(true)
    })
  }, [])

  const handleToggle = useCallback(async () => {
    const next = !enabled
    setSaving(true)
    try {
      const telemetry = getDesktopApi()?.telemetry
      if (telemetry === undefined) {
        throw new Error('Desktop telemetry API is unavailable.')
      }
      await telemetry.setEnabled(next)
      setEnabled(next)
      toast({
        title: getToggleTitle(next, t),
        description: t('settings.telemetrySection.changesTakeEffectAfterRestarting'),
      })
    } catch {
      toast({
        title: t('settings.telemetrySection.error'),
        description: t('settings.telemetrySection.failedToUpdateTelemetrySetting'),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }, [enabled, t, toast])

  const handleToggleClick = useCallback(() => {
    void handleToggle()
  }, [handleToggle])

  if (!loaded) return null

  const body = (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0 sm:flex-1">
          <h3 className={settingsLabelClass}>
            {t('settings.telemetrySection.analyticsAmpDiagnostics')}
          </h3>
          <p className={settingsDescriptionClass}>
            {t('settings.telemetrySection.anonymousUsageAndCrashReports')}
          </p>
          {renderForcedTelemetryNotice(enabled, canDisable, t)}
          {renderLoadError(loadError, t)}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleToggleClick}
          disabled={isToggleDisabled(saving, loadError, enabled, canDisable)}
          className={getButtonClass(enabled)}
        >
          {getButtonLabel(saving, enabled, t)}
        </Button>
      </div>
    </div>
  )

  if (embedded) {
    return <div id="telemetry">{body}</div>
  }

  return (
    <section id="telemetry">
      {renderHeader(t)}
      {body}
    </section>
  )
}
