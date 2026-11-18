import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { BookOpen, ShieldAlert } from 'lucide-react'
import { useFormatters, useTranslation } from '@bitsentry-ce/i18n'
import { useIncidentListStore } from '../investigation/incidents/incidentListStore'
import { loadDesktopIncidentList } from '../investigation/incidents/incidentListPersistence'
import { hasDesktopIncidentsApi } from '../investigation/incidents/incidentDesktopApi'
import type { IncidentThread } from '../investigation/incidents/types'
import { loadRunbookNavItems, readLocalRunbookNavItems, type RunbookNavItem } from '../layout/runbook-nav'
import { useRunbooksService } from '../services/hooks'
import { useOptionalTheme } from '../theme'
import {
  CommandPaletteHost,
  CommandPaletteProvider,
  defaultNavigationCommands,
  useCommandPalette,
  type CommandPaletteGroup,
} from '../shortcuts'

const RECENT_INCIDENT_LIMIT = 20
// Matches the title the incidents page gives a new thread, which auto-titling replaces on the first message.
const NEW_INCIDENT_TITLE = 'New Incident'

/**
 * Adds an empty incident thread and opens it, as the incidents page's New button does. When the desktop list has
 * not loaded yet it loads first, so the load does not replace the new row.
 */
async function startNewDesktopIncident(navigate: (to: string) => void): Promise<void> {
  if (hasDesktopIncidentsApi()) {
    await loadDesktopIncidentList().catch(() => undefined)
  }
  const id = crypto.randomUUID()
  useIncidentListStore
    .getState()
    .upsert({ id, title: NEW_INCIDENT_TITLE, createdAt: new Date().toISOString(), prompt: '', state: 'IDLE' })
  navigate(`/incidents?id=${id}`)
}

function selectRecentIncidents(state: { incidents: IncidentThread[] }): IncidentThread[] {
  return state.incidents
}

/** Runbooks from the navbar's local cache, refreshed from the runbooks service while the palette is open. */
function usePaletteRunbooks(open: boolean): RunbookNavItem[] {
  const runbooks = useRunbooksService()
  const [fetched, setFetched] = useState<RunbookNavItem[] | null>(null)
  const cached = useMemo(() => (open ? readLocalRunbookNavItems() : []), [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void loadRunbookNavItems(runbooks).then((items) => {
      if (!cancelled) setFetched(items)
    })
    return () => {
      cancelled = true
    }
  }, [open, runbooks])

  return fetched ?? cached
}

function DesktopCommandPaletteHost() {
  const { t } = useTranslation()
  const formatters = useFormatters()
  const navigate = useNavigate()
  const palette = useCommandPalette()
  const theme = useOptionalTheme()
  const incidents = useIncidentListStore(selectRecentIncidents)
  const runbooks = usePaletteRunbooks(palette.open)

  // The incident list is shared with the navbar; load it on open if nothing has yet. No request before that.
  useEffect(() => {
    if (!palette.open || !hasDesktopIncidentsApi()) return
    loadDesktopIncidentList().catch(() => {})
  }, [palette.open])

  const go = (to: string) => {
    void navigate(to)
  }

  const commands = defaultNavigationCommands(go, {
    routes: { settings: '/app-settings' },
    togglePalette: palette.togglePalette,
    showShortcuts: palette.openShortcuts,
    newIncident: () => {
      void startNewDesktopIncident(go)
    },
    toggleTheme: theme?.toggleTheme,
  })

  const groups: CommandPaletteGroup[] = palette.open
    ? [
        {
          id: 'recent-incidents',
          heading: t('common.shortcuts.groups.recentIncidents'),
          items: incidents
            .filter((incident) => incident.archived !== true)
            .slice(0, RECENT_INCIDENT_LIMIT)
            .map((incident) => ({
              id: incident.id,
              label: incident.title,
              hint: formatters.relativeTime(incident.createdAt),
              icon: ShieldAlert,
              run: () => {
                go(`/incidents?id=${incident.id}`)
              },
            })),
        },
        {
          id: 'runbooks',
          heading: t('common.shortcuts.groups.runbooks'),
          items: runbooks.map((runbook) => ({
            id: runbook.id,
            label: runbook.title,
            keywords: [runbook.description ?? '', ...(runbook.stepTitles ?? [])],
            icon: BookOpen,
            run: () => {
              go(`/runbooks?id=${runbook.id}`)
            },
          })),
        },
      ]
    : []

  return <CommandPaletteHost commands={commands} groups={groups} />
}

/** The desktop command palette (⌘K) and keyboard shortcuts. Wrap the shell so a navbar can open the palette. */
export function DesktopCommandPalette({ children }: { children?: ReactNode }) {
  return (
    <CommandPaletteProvider>
      {children}
      <DesktopCommandPaletteHost />
    </CommandPaletteProvider>
  )
}
