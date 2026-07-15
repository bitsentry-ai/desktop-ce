// ─── Shared runbook storage utilities ─────────────────────────────────────────────
// Used by both Runbook.tsx and Incidents.tsx to avoid duplication

export const RUNBOOKS_LS_KEY = "bitsentry_runbooks";

export interface RunbookAction {
  id: string;
  type: "shell" | "llm" | "http" | "plugin" | "external_source";
  title: string;
  command?: string;
  prompt?: string;
  llmProviderKey?:
    | "groq"
    | "kilocode"
    | "openai"
    | "anthropic"
    | "gemini"
    | "openrouter";
  llmModel?: string;
  url?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Array<{ key: string; value: string }>;
  body?: string;
  pluginId?: string;
  pluginActionId?: string;
  pluginInput?: string;
  pluginAuth?: string;
  query?: string;
  parameters?: Array<{
    id: string;
    key: string;
    label: string;
    description?: string;
    defaultValue?: string;
    required?: boolean;
  }>;
}

export interface Runbook {
  id: string;
  title: string;
  description: string;
  actions: RunbookAction[];
  createdAt: string;
  updatedAt: string;
}

function isRunbook(value: unknown): value is Runbook {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("id" in value) || !("title" in value) || !("actions" in value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    Array.isArray(value.actions)
  );
}

/**
 * Load all runbooks from localStorage
 */
export function loadRunbooks(): Runbook[] {
  try {
    const raw = localStorage.getItem(RUNBOOKS_LS_KEY);
    if (raw === null || raw.length === 0) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRunbook);
  } catch {
    return [];
  }
}

/**
 * Save runbooks to localStorage
 */
export function saveRunbooks(runbooks: Runbook[]) {
  try {
    localStorage.setItem(RUNBOOKS_LS_KEY, JSON.stringify(runbooks));
  } catch {}
}

/**
 * Check if at least one valid runbook exists (has 1+ actions)
 */
export function hasValidRunbook(): boolean {
  const runbooks = loadRunbooks();
  return runbooks.some((rb) => rb.actions.length > 0);
}
