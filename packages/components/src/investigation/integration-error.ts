/**
 * The recovery message for a failed integration step. A read tool reports a stable error code, and that code decides the message.
 * Errors that cross the desktop IPC boundary arrive as plain text, so those fall back to markers that name a specific cause.
 * Anything unrecognised stays generic: a precise message is only shown when the cause is certain.
 */
const KEY_BY_CODE: Record<string, string> = {
  INTEGRATION_READ_CANCELLED: "incidents.integrationRecovery.cancelled",
  INTEGRATION_READ_TIMEOUT: "incidents.integrationRecovery.timeout",
  DESTINATION_NOT_ALLOWED: "incidents.integrationRecovery.destinationBlocked",
  PLUGIN_UNAVAILABLE: "incidents.integrationRecovery.unavailable",
  CONNECTION_UNAVAILABLE: "incidents.integrationRecovery.unavailable",
  CREDENTIALS_REJECTED: "incidents.integrationRecovery.credentials",
  STALE_RESOURCE: "incidents.integrationRecovery.stale",
  RESOURCE_NOT_FOUND: "incidents.integrationRecovery.deleted",
};
const GENERIC_KEY = "incidents.integrationWrites.error";

export function integrationErrorKeyForCode(code: string): string {
  return KEY_BY_CODE[code] ?? GENERIC_KEY;
}

export function integrationErrorKey(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return KEY_BY_CODE.INTEGRATION_READ_CANCELLED!;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("itop_allowed_base_urls") || message.includes("outline_allowed_api_bases")) return KEY_BY_CODE.DESTINATION_NOT_ALLOWED!;
  if (message.includes("credential") || message.includes("unauthorized")) return KEY_BY_CODE.CREDENTIALS_REJECTED!;
  if (message.includes("revision") || message.includes("changed") || message.includes("target instance")) return KEY_BY_CODE.STALE_RESOURCE!;
  if (message.includes("unavailable") || message.includes("disabled") || message.includes("missing")) return KEY_BY_CODE.PLUGIN_UNAVAILABLE!;
  if (message.includes("close") || message.includes("closing")) return "incidents.integrationRecovery.close";
  return GENERIC_KEY;
}
