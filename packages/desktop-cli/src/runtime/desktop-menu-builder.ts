import {
  app,
  Menu,
  shell,
  type BrowserWindow,
} from 'electron'
import {
  buildDesktopMenuTemplate,
  type DesktopMenuItem,
} from '@bitsentry-ce/core/features/app-shell/desktop-menu'
import {
  getDesktopEditionIdentity,
  type DesktopEdition,
} from '@bitsentry-ce/core/features/desktop/desktop-edition-identity'

function isDevelopmentEnvironment(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true'
}

function openExternal(url: string): void {
  void shell.openExternal(url)
}

export class DesktopMenuBuilder {
  constructor(
    protected readonly mainWindow: BrowserWindow,
    private readonly edition: DesktopEdition,
  ) {}

  buildMenu(): Menu {
    if (isDevelopmentEnvironment()) {
      this.setupDevelopmentEnvironment()
    }

    const { productName } = getDesktopEditionIdentity(this.edition)
    const template = buildDesktopMenuTemplate({
      platform: process.platform,
      isDevelopment: isDevelopmentEnvironment(),
      productName,
      actions: {
        quit: () => {
          app.quit()
        },
        reload: () => {
          this.mainWindow.webContents.reload()
        },
        toggleFullScreen: () => {
          this.mainWindow.setFullScreen(!this.mainWindow.isFullScreen())
        },
        toggleDeveloperTools: () => {
          this.mainWindow.webContents.toggleDevTools()
        },
        closeWindow: () => {
          this.mainWindow.close()
        },
        openExternal,
      },
    })

    const menu = Menu.buildFromTemplate(
      template,
    )
    Menu.setApplicationMenu(menu)

    return menu
  }

  setupDevelopmentEnvironment(): void {
    this.mainWindow.webContents.on('context-menu', (_, props) => {
      const { x, y } = props

      const template: DesktopMenuItem[] = [
        {
          label: 'Inspect element',
          click: () => {
            this.mainWindow.webContents.inspectElement(x, y)
          },
        },
      ]

      Menu.buildFromTemplate(
        template,
      ).popup({ window: this.mainWindow })
    })
  }
}
