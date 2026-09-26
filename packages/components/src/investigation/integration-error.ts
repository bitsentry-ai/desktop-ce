export function integrationErrorKey(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("credential") || message.includes("unauthorized")) return "incidents.integrationRecovery.credentials";
  if (message.includes("revision") || message.includes("changed") || message.includes("target instance")) return "incidents.integrationRecovery.stale";
  if (message.includes("unavailable") || message.includes("disabled") || message.includes("missing")) return "incidents.integrationRecovery.unavailable";
  if (message.includes("close") || message.includes("closing")) return "incidents.integrationRecovery.close";
  return "incidents.integrationWrites.error";
}
