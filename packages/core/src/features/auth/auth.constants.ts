// Error codes for auth operations
export const AUTH_ERROR_CODES = {
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  INVALID_TEMP_TOKEN: 'INVALID_TEMP_TOKEN',
  INVALID_TOKEN_TYPE: 'INVALID_TOKEN_TYPE',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  MISSING_USER_ID: 'MISSING_USER_ID',
  INVALID_TOTP: 'INVALID_TOTP',
  TOTP_NOT_ENABLED: 'TOTP_NOT_ENABLED',
  INVALID_EMAIL_OTP: 'INVALID_EMAIL_OTP',
  INVALID_2FA_METHOD: 'INVALID_2FA_METHOD',
  WRONG_PROVIDER: 'WRONG_PROVIDER',
  NO_PASSWORD_SET: 'NO_PASSWORD_SET', // eslint-disable-line sonarjs/no-hardcoded-passwords -- Public error-code identifier, not a credential.
  INVALID_PASSWORD: 'INVALID_PASSWORD', // eslint-disable-line sonarjs/no-hardcoded-passwords -- Public error-code identifier, not a credential.
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  EMAIL_NOT_CONFIRMED: 'EMAIL_NOT_CONFIRMED',
} as const;

// Field validation errors for API responses
export const AUTH_FIELD_ERRORS = {
  INCORRECT_PASSWORD: 'incorrectPassword', // eslint-disable-line sonarjs/no-hardcoded-passwords -- Public field-error identifier, not a credential.
  EMAIL_NOT_CONFIRMED: 'emailNotConfirmed',
  ACCOUNT_INACTIVE: 'accountInactive',
  USER_NOT_FOUND: 'userNotFound',
  NOT_FOUND: 'notFound',
  NO_PASSWORD_SET: 'noPasswordSet', // eslint-disable-line sonarjs/no-hardcoded-passwords -- Public field-error identifier, not a credential.
  INVALID_TOTP_TOKEN: 'invalidTotpToken',
  TOTP_NOT_ENABLED: 'totpNotEnabled',
} as const;
