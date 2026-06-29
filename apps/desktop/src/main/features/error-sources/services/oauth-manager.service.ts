import {
  createDesktopOauthManagerBindings,
  type OAuthProviderConfig,
} from '@bitsentry-ce/core/features/error-sources/desktop-oauth-manager'
const oauthManagerBindings = createDesktopOauthManagerBindings()

export const OauthManagerService = oauthManagerBindings.OauthManagerService

export type { OAuthProviderConfig }
