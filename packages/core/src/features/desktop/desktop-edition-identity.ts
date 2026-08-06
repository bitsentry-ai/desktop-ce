export type DesktopEdition = 'ce' | 'pro'

export interface DesktopEditionIdentity {
  appDataName: string
  oauthProtocolClientId: string
  productName: string
}

const DESKTOP_EDITION_IDENTITY: Record<DesktopEdition, DesktopEditionIdentity> = {
  ce: {
    appDataName: 'BitSentry Desktop',
    oauthProtocolClientId: 'bitsentry-desktop-ce',
    productName: 'BitSentry Desktop',
  },
  pro: {
    appDataName: 'BitSentry Desktop Pro',
    oauthProtocolClientId: 'bitsentry-desktop',
    productName: 'BitSentry Desktop Pro',
  },
}

export function getDesktopEditionIdentity(
  edition: DesktopEdition,
): DesktopEditionIdentity {
  return DESKTOP_EDITION_IDENTITY[edition]
}
