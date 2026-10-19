/**
 * Where each incident's current agent session starts in its thread.
 *
 * A session's snapshot holds only its own messages. When an incident moves to
 * a new session, for example after an app restart, the messages before it
 * stay in the thread and the new session's messages follow them.
 */

const SESSION_HISTORY_KEY = "bitsentry_incident_session_history";

type SessionStart = { sessionId: string; historyLength: number };

function readAll(): Record<string, SessionStart> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SESSION_HISTORY_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const entries: Record<string, SessionStart> = {};
    for (const [incidentId, value] of Object.entries(parsed)) {
      const record = value as Partial<SessionStart> | null;
      if (typeof record?.sessionId === "string" && typeof record.historyLength === "number" && record.historyLength >= 0) {
        entries[incidentId] = { sessionId: record.sessionId, historyLength: record.historyLength };
      }
    }
    return entries;
  } catch {
    return {};
  }
}

/** Records that `sessionId` starts after the incident's first `historyLength` messages. */
export function rememberSessionStart(incidentId: string, sessionId: string, historyLength: number): void {
  const entries = readAll();
  if (entries[incidentId]?.sessionId === sessionId) return;
  entries[incidentId] = { sessionId, historyLength };
  try {
    localStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(entries));
  } catch {}
}

/** How many of the thread's messages come before the session; 0 when the session's snapshot is the whole thread. */
export function sessionHistoryLength(incidentId: string, sessionId: string): number {
  const entry = readAll()[incidentId];
  return entry?.sessionId === sessionId ? entry.historyLength : 0;
}
