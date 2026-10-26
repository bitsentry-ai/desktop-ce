// Shared authentication types across frontend components

export interface TotpSetupData {
  secret: string;
  qrCode: string;
  manualEntryKey: string;
  backupCodes: string[];
}
