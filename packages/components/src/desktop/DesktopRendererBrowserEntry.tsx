import type { ComponentType } from 'react'
import App from '@bitsentry-desktop/renderer-app'
import { runDesktopRendererMain } from './DesktopRendererMain'
import './desktop-index.css'

const RendererApp = App as ComponentType

void runDesktopRendererMain({
  App: RendererApp,
  posthogKey: import.meta.env.VITE_POSTHOG_KEY ?? '',
  posthogHost: import.meta.env.VITE_POSTHOG_HOST ?? '',
})
