import {
  createDesktopOauthManagerBindings,
  type OAuthProviderConfig,
} from '@bitsentry-ce/core/features/error-sources/desktop-oauth-manager'
const oauthManagerBindings = createDesktopOauthManagerBindings(
  'bitsentry-desktop-ce://oauth/callback',
)

export const OauthManagerService = oauthManagerBindings.OauthManagerService

export type { OAuthProviderConfig }
