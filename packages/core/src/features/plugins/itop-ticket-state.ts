/**
 * Reads a ticket's state from an iTop `core/get` payload for one object.
 * Returns undefined when the payload does not identify exactly one object with a non-empty state.
 */
export function readItopTicketState(payload: unknown, statusField: string): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const objects = (payload as { objects?: unknown }).objects;
  if (typeof objects !== "object" || objects === null) return undefined;
  const entries = Object.values(objects);
  if (entries.length !== 1) return undefined;
  const fields = (entries[0] as { fields?: unknown } | null)?.fields;
  if (typeof fields !== "object" || fields === null) return undefined;
  const state = (fields as Record<string, unknown>)[statusField];
  return typeof state === "string" && state !== "" ? state : undefined;
}
