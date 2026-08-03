// Constants for 2FA and JWT token types

export const JWT_TOKEN_TYPES = {
  REGULAR: 'regular',
  REFRESH: 'refresh',
  TEMP_2FA: '2fa_temp',
} as const;

export const TWO_FA_METHODS = {
  TOTP: 'totp',
  EMAIL_OTP: 'email_otp',
  PASSKEY: 'passkey',
} as const;

export const TWO_FA_TOKEN_EXPIRY = {
  TEMP_TOKEN_MINUTES: 10,
} as const;

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

// TOTP configuration defaults
export const TOTP_CONFIG = {
  SECRET_LENGTH: 32,
  TOKEN_WINDOW: 2, // Allow 2-step time window (±1 step)
  BACKUP_CODES_COUNT: 10,
  BACKUP_CODE_LENGTH: 8,
} as const;

// WebAuthn configuration defaults
export const WEBAUTHN_CONFIG = {
  CHALLENGE_TTL_MS: 5 * 60 * 1000, // 5 minutes
  TIMEOUT_MS: 60000, // 60 seconds for cross-device
  ATTESTATION_TYPE: 'none' as const,
  RESIDENT_KEY: 'preferred' as const,
  USER_VERIFICATION: 'preferred' as const,
} as const;
