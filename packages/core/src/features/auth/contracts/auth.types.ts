/**
 * Auth provider types for user authentication
 */
export enum AuthProvider {
  Email = 'email',
  Facebook = 'facebook',
  Google = 'google',
  Apple = 'apple',
}

/**
 * User status for auth operations
 */
export interface AuthUserStatus {
  readonly id: number | string;
  readonly name?: string;
}

/**
 * User role for auth operations
 */
export interface AuthUserRole {
  readonly id: number | string;
  readonly name?: string;
}

/**
 * Minimal user representation for auth operations
 */
export interface AuthUser {
  readonly id: number | string;
  readonly email: string | null;
  readonly password: string | null;
  readonly provider: string;
  readonly status: AuthUserStatus | null;
  readonly role: AuthUserRole | null;
  // TOTP fields
  readonly totpEnabled: boolean;
  readonly totpSecret: string | null;
  readonly totpBackupCodes: string | null;
  // Passkey fields
  readonly passkeyEnabled: boolean;
}
