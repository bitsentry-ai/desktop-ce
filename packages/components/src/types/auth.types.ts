import type { CurrentUser as ApiCurrentUser } from "./api.types";

// Shared authentication types across frontend components

type User = ApiCurrentUser;

interface PasswordLoginResult {
  token?: string;
  refreshToken?: string;
  user: User;
  requiresTwoFactor?: boolean;
  tempToken?: string;
  totpEnabled?: boolean;
  emailOtpEnabled?: boolean;
}

interface TwoFactorAuthResult {
  token: string;
  refreshToken?: string;
  rememberMeExpiryHours?: number;
  user: User;
  totpVerified?: boolean;
  emailOtpVerified?: boolean;
}

export interface TotpSetupData {
  secret: string;
  qrCode: string;
  manualEntryKey: string;
  backupCodes: string[];
}
