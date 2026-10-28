import type { ModelCatalogProviderKey } from "../../llm/modelCatalog";
import type { AccessLevel, AgentThreadTokenUsage, ChatMessage } from "../../chat/types";
import {
  asRecord,
  getString,
  isAccessLevel,
  isModelCatalogProviderKey,
  normalizeIncidentMessagesMap,
  normalizeIncidents,
  normalizeIncidentTokenUsageMap,
  readJsonRecord,
} from "./incidentNormalize";
import type { IncidentThread, ProviderLockEntry } from "./types";

// ─── Local-storage helpers ────────────────────────────────────────────────────

const LS_KEY = "bitsentry_incidents";
const INCIDENT_MESSAGES_KEY = "bitsentry_incident_messages";
const INCIDENT_PROVIDER_LOCK_KEY = "bitsentry_incident_providers";
const INCIDENT_TOKEN_USAGE_KEY = "bitsentry_incident_token_usage";
export const LLM_PROVIDERS_UPDATED_EVENT = "bitsentry:llm-providers-updated";
// Web mode only: streaming changes arrive faster than the debounce; still save this often.
export const LOCAL_SAVE_DEBOUNCE_MS = 150;
export const LOCAL_SAVE_MAX_WAIT_MS = 1000;

export function loadProviderLocks(): Record<string, ProviderLockEntry> {
  const parsed = readJsonRecord(localStorage.getItem(INCIDENT_PROVIDER_LOCK_KEY));
  const locks: Record<string, ProviderLockEntry> = {};

  for (const [incidentId, value] of Object.entries(parsed)) {
    const record = asRecord(value);
    if (record === null) continue;
    const providerKey = record.providerKey;
    const modelId = getString(record, "modelId");
    if (!isModelCatalogProviderKey(providerKey) || modelId === undefined) {
      continue;
    }

    const entry: ProviderLockEntry = { providerKey, modelId };
    if (isAccessLevel(record.accessLevel)) {
      entry.accessLevel = record.accessLevel;
    }
    locks[incidentId] = entry;
  }

  return locks;
}

export function saveProviderLock(
  incidentId: string,
  providerKey: ModelCatalogProviderKey,
  modelId: string,
  accessLevel?: AccessLevel,
): void {
  try {
    const locks = loadProviderLocks();
    locks[incidentId] = { providerKey, modelId, accessLevel };
    localStorage.setItem(INCIDENT_PROVIDER_LOCK_KEY, JSON.stringify(locks));
  } catch {}
}

export function loadIncidents(): IncidentThread[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw === null || raw.length === 0) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeIncidents(parsed);
  } catch {
    return [];
  }
}

const localStorageWriteWarnedKeys = new Set<string>();

function saveLocalStorageJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    if (localStorageWriteWarnedKeys.has(key)) return;
    localStorageWriteWarnedKeys.add(key);
    console.warn(`Failed to save ${key} to local storage:`, error);
  }
}

export function saveIncidents(incidents: IncidentThread[]) {
  saveLocalStorageJson(LS_KEY, incidents);
}

export function saveIncidentMessages(messagesMap: Record<string, ChatMessage[]>) {
  saveLocalStorageJson(INCIDENT_MESSAGES_KEY, messagesMap);
}

export function loadIncidentMessages(): Record<string, ChatMessage[]> {
  const parsed = readJsonRecord(localStorage.getItem(INCIDENT_MESSAGES_KEY));
  return normalizeIncidentMessagesMap(parsed);
}

export function loadIncidentTokenUsage(): Record<string, AgentThreadTokenUsage> {
  const parsed = readJsonRecord(localStorage.getItem(INCIDENT_TOKEN_USAGE_KEY));
  return normalizeIncidentTokenUsageMap(parsed);
}

export function saveIncidentTokenUsage(
  tokenUsageByIncident: Record<string, AgentThreadTokenUsage>,
): void {
  try {
    localStorage.setItem(
      INCIDENT_TOKEN_USAGE_KEY,
      JSON.stringify(tokenUsageByIncident),
    );
  } catch {}
}
