import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import * as Sentry from "@sentry/react";
import { useSearchParams, useNavigate } from "react-router-dom";
import Navbar from "../layout/Navbar";
import TopBar from "../layout/TopBar";
import { ChatBubble } from "../chat/ChatBubble";
import IncidentArtifactsRail, {
  countIncidentArtifacts,
} from "./IncidentArtifactsRail";
import {
  ShieldAlert,
  SquarePen,
  ArrowDown,
  X,
  History,
  AlertTriangle,
  Ban,
  BookOpen,
  Check,
  CopyIcon,
  Archive,
  FileText,
  RefreshCw,
  Upload,
} from "lucide-react";
import { cn } from "../lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../ui/tooltip";
import { useAgentService } from "../services/hooks";
import { getDesktopApi } from "../services/desktop-api";
import { hasValidRunbook, loadRunbooks } from "../runbook/runbookStorage";
import {
  type ModelCatalogEntry,
  type ModelCatalogProviderKey,
  getCapabilityBadges,
  getCatalogModel,
  requiresToolCapableAccess,
} from "../llm/modelCatalog";
import { useTranslation } from "@bitsentry-ce/i18n";
import { getProviderModelOptions } from "../chat/utils";
import type {
  AccessLevel,
  AgentSessionState,
  AgentThreadSnapshot,
  AgentThreadTokenUsage,
  ChatMessage,
  ComposerImageAttachment,
  InteractionMode,
  SavedProviderConfig,
  StreamDeltaRecord,
  ToolCallCard,
  ThreadStatus,
} from "../chat/types";
import { Composer } from "../chat/Composer";
import type {
  AgentServicePort,
  RunbookAuthoringProposalReview,
} from "../services/contracts";

// ─── Types ────────────────────────────────────────────────────────────────────

type DesktopIpcError = {
  code?: string;
  message?: string;
};

interface IncidentThread {
  id: string;
  title: string;
  createdAt: string;
  prompt: string;
  state: AgentSessionState;
  sessionId?: string;
  archived?: boolean;
  lastMessagePreview?: string | null;
}

// ─── Local-storage helpers ────────────────────────────────────────────────────

const LS_KEY = "bitsentry_incidents";
const INCIDENT_MESSAGES_KEY = "bitsentry_incident_messages";
const INCIDENT_PROVIDER_LOCK_KEY = "bitsentry_incident_providers";
const INCIDENT_TOKEN_USAGE_KEY = "bitsentry_incident_token_usage";
const LLM_PROVIDERS_UPDATED_EVENT = "bitsentry:llm-providers-updated";

type ProviderLockEntry = {
  providerKey: ModelCatalogProviderKey;
  modelId: string;
  accessLevel?: AccessLevel;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as UnknownRecord;
}

function readJsonRecord(raw: string | null): UnknownRecord {
  if (raw === null || raw.length === 0) return {};
  try {
    const parsed = asRecord(JSON.parse(raw));
    if (parsed === null) return {};
    return parsed;
  } catch {
    return {};
  }
}

function getString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  if (value.length === 0) return undefined;
  return value;
}

function getTrimmedString(record: UnknownRecord, key: string): string | undefined {
  const value = getString(record, key);
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

function isAccessLevel(value: unknown): value is AccessLevel {
  return (
    value === "supervised" ||
    value === "auto-accept-edits" ||
    value === "full-access"
  );
}

function isModelCatalogProviderKey(
  value: unknown,
): value is ModelCatalogProviderKey {
  return (
    value === "claude_code" ||
    value === "codex" ||
    value === "opencode" ||
    value === "cursor" ||
    value === "openai" ||
    value === "anthropic" ||
    value === "gemini" ||
    value === "groq" ||
    value === "kilocode" ||
    value === "openrouter"
  );
}

function loadProviderLocks(): Record<string, ProviderLockEntry> {
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

function saveProviderLock(
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

function normalizeIncidentPreview(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return null;
  return normalized;
}

function shouldAutoTitleIncident(title: string | null | undefined): boolean {
  let normalized = "";
  if (typeof title === "string") {
    normalized = title.trim();
  }
  return (
    normalized.length === 0 ||
    normalized === "New Incident" ||
    normalized === "Untitled Incident"
  );
}

function normalizeIncidentState(
  value: unknown,
  sessionId: string | undefined,
): AgentSessionState {
  if (value === "RUNNING") {
    if (sessionId !== undefined) return "RUNNING";
    return "FAILED";
  }
  if (
    value === "IDLE" ||
    value === "COMPLETED" ||
    value === "FAILED" ||
    value === "CANCELLED"
  ) {
    return value;
  }
  return "IDLE";
}

function fallbackIncident(): IncidentThread {
  return {
    id: crypto.randomUUID(),
    title: "Untitled Incident",
    createdAt: new Date().toISOString(),
    prompt: "",
    state: "IDLE",
  };
}

function normalizeIncidents(parsed: unknown[]): IncidentThread[] {
  return parsed.map((i: unknown): IncidentThread => {
    const record = asRecord(i);
    if (record === null) return fallbackIncident();

    const sessionId = getTrimmedString(record, "sessionId");
    const id = getString(record, "id") ?? crypto.randomUUID();
    const title = getTrimmedString(record, "title") ?? "Untitled Incident";
    const createdAt = getString(record, "createdAt") ?? new Date().toISOString();
    const prompt = getString(record, "prompt") ?? "";
    return {
      id,
      title,
      createdAt,
      prompt,
      // Preserve running incidents only when a resumable agent session is attached.
      state: normalizeIncidentState(record.state, sessionId),
      sessionId,
      archived: record.archived === true,
      lastMessagePreview:
        normalizeIncidentPreview(getString(record, "lastMessagePreview")) ??
        normalizeIncidentPreview(prompt),
    };
  });
}

function loadIncidents(): IncidentThread[] {
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

function saveIncidents(incidents: IncidentThread[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(incidents));
  } catch {}
}

function saveIncidentMessages(messagesMap: Record<string, ChatMessage[]>) {
  try {
    localStorage.setItem(INCIDENT_MESSAGES_KEY, JSON.stringify(messagesMap));
  } catch {}
}

function normalizeIncidentTokenUsageMap(
  input: Record<string, unknown>,
): Record<string, AgentThreadTokenUsage> {
  const normalized: Record<string, AgentThreadTokenUsage> = {};
  for (const [incidentId, value] of Object.entries(input)) {
    const usage = asRecord(value);
    if (usage === null) continue;
    if (
      typeof usage.inputTokens !== "number" ||
      !Number.isFinite(usage.inputTokens) ||
      typeof usage.outputTokens !== "number" ||
      !Number.isFinite(usage.outputTokens)
    ) {
      continue;
    }

    const entry: AgentThreadTokenUsage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
    if (
      typeof usage.contextTokens === "number" &&
      Number.isFinite(usage.contextTokens)
    ) {
      entry.contextTokens = usage.contextTokens;
    }
    if (
      typeof usage.contextLimit === "number" &&
      Number.isFinite(usage.contextLimit)
    ) {
      entry.contextLimit = usage.contextLimit;
    }

    normalized[incidentId] = entry;
  }
  return normalized;
}

function normalizeToolCallState(value: unknown): ToolCallCard["state"] {
  if (value === "running" || value === "done" || value === "failed") {
    return value;
  }
  return "done";
}

function normalizeToolCalls(toolCalls: unknown): ToolCallCard[] {
  if (!Array.isArray(toolCalls)) return [];
  const normalized = new Map<string, ToolCallCard>();

  for (const value of toolCalls) {
    const record = asRecord(value);
    if (record === null) continue;
    const toolCallId = getString(record, "toolCallId");
    const toolName = getString(record, "toolName");
    if (toolCallId === undefined || toolName === undefined) continue;

    const card: ToolCallCard = {
      toolCallId,
      toolName,
      state: normalizeToolCallState(record.state),
    };
    const input = asRecord(record.input);
    if (input !== null) card.input = input;
    const output = getString(record, "output");
    if (output !== undefined) card.output = output;
    const error = getString(record, "error");
    if (error !== undefined) card.error = error;
    const modelContext = getString(record, "modelContext");
    if (modelContext !== undefined) card.modelContext = modelContext;

    normalized.set(toolCallId, card);
  }

  return Array.from(normalized.values());
}

function dedupeToolCallIds(toolCallIds: unknown): string[] {
  if (!Array.isArray(toolCallIds)) return [];
  return Array.from(
    new Set(toolCallIds.filter((toolCallId) => typeof toolCallId === "string")),
  );
}

function normalizeStreamDeltas(value: unknown): StreamDeltaRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((delta): StreamDeltaRecord | null => {
      const record = asRecord(delta);
      if (record === null) return null;
      const timestamp = getString(record, "timestamp");
      const text = getString(record, "text");
      if (timestamp === undefined || text === undefined) return null;
      if (record.kind === "command_output") {
        return { timestamp, text, kind: "command_output" };
      }
      if (record.kind === "text") {
        return { timestamp, text, kind: "text" };
      }
      return { timestamp, text };
    })
    .filter((delta): delta is StreamDeltaRecord => delta !== null);
}

function normalizeComposerAttachments(
  value: unknown,
): ComposerImageAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments = value
    .map((attachment): ComposerImageAttachment | null => {
      const record = asRecord(attachment);
      if (record === null) return null;
      const id = getString(record, "id");
      const name = getString(record, "name");
      const mimeType = getString(record, "mimeType");
      const dataUrl = getString(record, "dataUrl");
      if (
        id === undefined ||
        name === undefined ||
        mimeType === undefined ||
        dataUrl === undefined ||
        record.type !== "image" ||
        typeof record.sizeBytes !== "number"
      ) {
        return null;
      }
      return {
        id,
        type: "image",
        name,
        mimeType,
        sizeBytes: record.sizeBytes,
        dataUrl,
      };
    })
    .filter(
      (attachment): attachment is ComposerImageAttachment => attachment !== null,
    );
  if (attachments.length === 0) return undefined;
  return attachments;
}

function normalizeAgentStatus(value: unknown): Extract<ChatMessage, { kind: "agent" }>["status"] {
  if (
    value === "thinking" ||
    value === "streaming" ||
    value === "done" ||
    value === "error" ||
    value === "cancelled"
  ) {
    return value;
  }
  return "done";
}

function normalizeIterationStatus(value: unknown): "thinking" | "streaming" | "done" | "error" {
  if (
    value === "thinking" ||
    value === "streaming" ||
    value === "done" ||
    value === "error"
  ) {
    return value;
  }
  return "done";
}

function normalizeAgentIterations(value: unknown): Extract<ChatMessage, { kind: "agent" }>["iterations"] {
  if (!Array.isArray(value)) return [];
  return value.map((iteration, index) => {
    const record = asRecord(iteration);
    if (record === null) {
      return {
        id: `iteration-${String(index)}`,
        startedAt: new Date(0).toISOString(),
        text: "",
        streamDeltas: [],
        toolCallIds: [],
        status: "done",
      };
    }

    return {
      id: getString(record, "id") ?? `iteration-${String(index)}`,
      startedAt: getString(record, "startedAt") ?? new Date(0).toISOString(),
      completedAt: getString(record, "completedAt"),
      text: getString(record, "text") ?? "",
      streamDeltas: normalizeStreamDeltas(record.streamDeltas),
      toolCallIds: dedupeToolCallIds(record.toolCallIds),
      status: normalizeIterationStatus(record.status),
    };
  });
}

/**
 * Migrate legacy ChatMessage format to new iterations-based format.
 * Legacy messages had streamText/startedAt directly on agent message.
 */
function migrateMessage(msg: unknown): ChatMessage {
  const record = asRecord(msg);
  if (record === null) {
    return { kind: "user", text: "" };
  }

  if (record.kind === "user") {
    const message: ChatMessage = {
      kind: "user",
      text: getString(record, "text") ?? "",
    };
    const attachments = normalizeComposerAttachments(record.attachments);
    if (attachments !== undefined) {
      message.attachments = attachments;
    }
    return message;
  }

  if (record.kind === "agent" && !Array.isArray(record.iterations)) {
    const toolCalls = normalizeToolCalls(record.toolCalls);
    return {
      kind: "agent",
      toolCalls,
      iterations: [
        {
          id: "legacy",
          startedAt: getString(record, "startedAt") ?? new Date(0).toISOString(),
          text:
            getString(record, "finalText") ??
            getString(record, "streamText") ??
            "",
          streamDeltas: [],
          toolCallIds: dedupeToolCallIds(toolCalls.map((tc) => tc.toolCallId)),
          status: "done",
        },
      ],
      activeIterationId: null,
      finalText: getString(record, "finalText") ?? null,
      status: normalizeAgentStatus(record.status),
      errorMsg: getString(record, "errorMsg"),
    };
  }
  if (record.kind === "agent" && Array.isArray(record.iterations)) {
    return {
      kind: "agent",
      toolCalls: normalizeToolCalls(record.toolCalls),
      iterations: normalizeAgentIterations(record.iterations),
      activeIterationId: getString(record, "activeIterationId") ?? null,
      finalText: getString(record, "finalText") ?? null,
      status: normalizeAgentStatus(record.status),
      errorMsg: getString(record, "errorMsg"),
    };
  }
  return { kind: "user", text: "" };
}

function normalizeIncidentMessagesMap(
  input: Record<string, unknown>,
): Record<string, ChatMessage[]> {
  const migrated: Record<string, ChatMessage[]> = {};
  for (const [key, msgs] of Object.entries(input)) {
    if (!Array.isArray(msgs)) continue;
    migrated[key] = msgs.map(migrateMessage);
  }
  return migrated;
}

function normalizeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => migrateMessage(message));
}

function getChatMessagePreview(
  message: ChatMessage | undefined,
): string | null {
  if (message === undefined) return null;
  if (message.kind === "user") {
    return normalizeIncidentPreview(message.text);
  }

  const latestIteration = message.iterations[message.iterations.length - 1];
  return normalizeIncidentPreview(
    message.finalText ?? latestIteration?.text ?? message.errorMsg,
  );
}

function getIncidentPreviewFromMessages(
  messages: ChatMessage[] | undefined,
): string | null {
  if (messages === undefined || messages.length === 0) return null;
  return getChatMessagePreview(messages[messages.length - 1]);
}

function loadIncidentMessages(): Record<string, ChatMessage[]> {
  const parsed = readJsonRecord(localStorage.getItem(INCIDENT_MESSAGES_KEY));
  return normalizeIncidentMessagesMap(parsed);
}

function loadIncidentTokenUsage(): Record<string, AgentThreadTokenUsage> {
  const parsed = readJsonRecord(localStorage.getItem(INCIDENT_TOKEN_USAGE_KEY));
  return normalizeIncidentTokenUsageMap(parsed);
}

function saveIncidentTokenUsage(
  tokenUsageByIncident: Record<string, AgentThreadTokenUsage>,
): void {
  try {
    localStorage.setItem(
      INCIDENT_TOKEN_USAGE_KEY,
      JSON.stringify(tokenUsageByIncident),
    );
  } catch {}
}

function hasDesktopIncidentsApi(): boolean {
  if (typeof window === "undefined") return false;
  return getDesktopApi()?.incidents !== undefined;
}

function hasDesktopLlmApi(): boolean {
  if (typeof window === "undefined") return false;
  return getDesktopApi()?.llm?.getProviders !== undefined;
}

function hasManagedDesktopLlmApi(): boolean {
  if (typeof window === "undefined") return false;
  return typeof getDesktopApi()?.llm?.ping === "function";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

function isMissingIncidentsHandlerError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes("No handler registered for 'incidents:getState'") ||
    message.includes("No handler registered for 'incidents:replaceState'")
  );
}

function isMissingAgentSessionError(error: unknown): boolean {
  const record = asRecord(error);
  if (record !== null) {
    const ipcError: DesktopIpcError = {
      code: getString(record, "code"),
      message: getString(record, "message"),
    };
    if (
      ipcError.code === "not_found" &&
      typeof ipcError.message === "string" &&
      ipcError.message.includes("Session not found:")
    ) {
      return true;
    }
  }

  const message = errorMessage(error);
  return message.includes("Session not found:");
}

function getRecoveredIncidentState(
  state: AgentSessionState,
): AgentSessionState {
  if (state === "RUNNING") return "FAILED";
  return state;
}

function listConfiguredProviderKeys(
  savedProviders: Record<string, SavedProviderConfig>,
): ModelCatalogProviderKey[] {
  const orderedKeys: ModelCatalogProviderKey[] = [
    "claude_code",
    "codex",
    "opencode",
    "cursor",
    "openai",
    "anthropic",
    "gemini",
    "groq",
    "kilocode",
    "openrouter",
  ];
  return orderedKeys.filter((providerKey) => {
    const provider = savedProviders[providerKey];
    if (provider === undefined) return false;
    if (!provider.isSelectable) return false;
    return provider.hasApiKey;
  });
}

function normalizeProviderConfigs(
  input: Record<string, unknown>,
): Record<string, SavedProviderConfig> {
  const configs: Record<string, SavedProviderConfig> = {};
  for (const [key, value] of Object.entries(input)) {
    const record = asRecord(value);
    if (record === null) continue;
    if (typeof record.hasApiKey !== "boolean") continue;
    if (typeof record.baseUrl !== "string") continue;
    if (typeof record.model !== "string") continue;
    if (!Array.isArray(record.availableModels)) continue;
    if (typeof record.isSelectable !== "boolean") continue;
    if (typeof record.isPrimary !== "boolean") continue;

    configs[key] = {
      hasApiKey: record.hasApiKey,
      apiKey: getString(record, "apiKey"),
      baseUrl: record.baseUrl,
      model: record.model,
      availableModels: record.availableModels.filter(
        (model): model is string => typeof model === "string",
      ),
      isSelectable: record.isSelectable,
      isPrimary: record.isPrimary,
    };
  }
  return configs;
}

function captureIncidentException(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  try {
    if (context === undefined) {
      Sentry.captureException(error);
    } else {
      Sentry.captureException(error, { extra: context });
    }
  } catch {}
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read image file."));
    };
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      resolve("");
    };
    reader.readAsDataURL(file);
  });
}

async function loadDesktopIncidentState(): Promise<{
  incidents: IncidentThread[];
  messagesMap: Record<string, ChatMessage[]>;
}> {
  const incidentsApi = getDesktopApi()?.incidents;
  if (incidentsApi === undefined) {
    return {
      incidents: loadIncidents(),
      messagesMap: loadIncidentMessages(),
    };
  }

  const snapshot = await incidentsApi.getState();
  const incidents = normalizeIncidents(snapshot.incidents);
  const messagesMap = normalizeIncidentMessagesMap(snapshot.incidentMessages);

  if (incidents.length > 0 || Object.keys(messagesMap).length > 0) {
    return { incidents, messagesMap };
  }

  return {
    incidents: loadIncidents(),
    messagesMap: loadIncidentMessages(),
  };
}

async function saveDesktopIncidentState(
  incidents: IncidentThread[],
  messagesMap: Record<string, ChatMessage[]>,
): Promise<void> {
  const incidentsApi = getDesktopApi()?.incidents;
  if (incidentsApi === undefined) return;

  await incidentsApi.replaceState({
    incidents,
    incidentMessages: messagesMap,
  });
}

function relativeTime(iso: string): string {
  if (iso.length === 0) return "unknown time";

  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return "unknown time";

  const diff = Date.now() - timestamp;
  if (diff < 0) return "just now"; // Future dates

  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${String(mins)}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${String(hrs)}h ago`;
  return `${String(Math.floor(hrs / 24))}d ago`;
}

/**
 * Get the active runbook id for the incident agent.
 */
function getRunbookId(): string | undefined {
  try {
    return loadRunbooks().find((rb) => rb.actions.length > 0)?.id;
  } catch {
    return undefined;
  }
}

const NO_LLM_PROVIDER_CONFIGURED_MESSAGE =
  "No LLM provider configured. Please configure a provider in Settings.";

function normalizeErrorMessage(errorMsg: string | undefined): string {
  return (errorMsg ?? "").replace(/^Error:\s*/i, "").trim();
}

function translateIncidentPreview(
  preview: string,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (normalizeErrorMessage(preview) === NO_LLM_PROVIDER_CONFIGURED_MESSAGE) {
    return t("common.incidents.noLlmProviderConfigured");
  }
  return preview;
}

// ─── Status pill ──────────────────────────────────────────────────────────────

function StatusPill({ state }: { state: AgentSessionState }) {
  const { t } = useTranslation();
  const map: Record<AgentSessionState, { label: string; cls: string }> = {
    IDLE: {
      label: t("common.incidents.statusIdle"),
      cls: "bg-muted text-muted-foreground",
    },
    RUNNING: {
      label: t("common.incidents.statusRunning"),
      cls: "bg-amber-500/15 text-amber-500",
    },
    COMPLETED: {
      label: t("common.incidents.statusCompleted"),
      cls: "bg-emerald-500/15 text-emerald-500",
    },
    FAILED: {
      label: t("common.incidents.statusFailed"),
      cls: "bg-destructive/15 text-destructive",
    },
    CANCELLED: {
      label: t("common.incidents.statusCancelled"),
      cls: "bg-muted text-muted-foreground",
    },
  };

  const { label, cls } = map[state];
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", cls)}>
      {label}
    </span>
  );
}

// ─── Editable title ───────────────────────────────────────────────────────────

function EditableTitle({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);
  useEffect(() => {
    if (disabled) {
      setEditing(false);
    }
  }, [disabled]);

  const commit = () => {
    const trimmed = draft.trim() || "New Incident";
    setDraft(trimmed);
    onChange(trimmed);
    setEditing(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
    if (e.key === "Escape") {
      setDraft(value);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        autoFocus
        value={draft}
        onChange={(e) => { setDraft(e.target.value); }}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        className="flex-1 min-w-0 truncate bg-transparent text-sm font-medium outline-none border-b border-primary/50 focus:border-primary"
      />
    );
  }

  let title = t("common.incidents.clickToRename");
  if (disabled) {
    title = t("common.incidents.archivedIncidentsAreReadOnly");
  }

  return (
    <button
      onClick={() => {
        if (!disabled) {
          setEditing(true);
        }
      }}
      title={title}
      disabled={disabled}
      className={cn(
        "flex-1 min-w-0 truncate text-left text-sm font-medium transition-colors",
        disabled && "cursor-default text-foreground",
        !disabled && "hover:text-muted-foreground",
      )}
    >
      {value}
    </button>
  );
}

// ─── Warning banner ────────────────────────────────────────────────────────────

function WarningBanner({
  onNavigateToRunbook,
}: {
  onNavigateToRunbook: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mx-6 mt-4 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <AlertTriangle size={16} className="shrink-0 text-amber-500" />
      <div className="flex-1 text-sm">
        <span className="font-medium text-foreground">
          {t("common.incidents.noValidRunbookFound")}
        </span>
        <span className="text-muted-foreground">
          {" "}
          {t("common.incidents.createARunbookWithAt")}
        </span>
      </div>
      <button
        onClick={onNavigateToRunbook}
        className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-border-hover transition-colors"
      >
        <BookOpen size={12} />
        {t("common.incidents.openRunbooks")}
      </button>
    </div>
  );
}

function ProviderBanner({
  onNavigateToSettings,
}: {
  onNavigateToSettings: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mx-6 mt-4 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <AlertTriangle size={16} className="shrink-0 text-amber-500" />
      <div className="flex-1 text-sm">
        <span className="font-medium text-foreground">
          {t("common.incidents.noChatModelIsConfigured")}
        </span>
        <span className="text-muted-foreground">
          {" "}
          {t("common.incidents.addAnApiKeyIn")}
        </span>
      </div>
      <button
        onClick={onNavigateToSettings}
        className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-border-hover transition-colors"
      >
        {t("common.incidents.openSettings")}
      </button>
    </div>
  );
}

// ─── Shell shared by both views ───────────────────────────────────────────────

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Navbar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        {children}
      </div>
    </div>
  );
}

function parseRunbookAuthoringProposal(
  toolCall: ToolCallCard,
): RunbookAuthoringProposalReview | null {
  if (
    toolCall.state !== "done" ||
    (toolCall.toolName !== "propose_runbook_edit" &&
      toolCall.toolName !== "propose_runbook_create") ||
    typeof toolCall.output !== "string" ||
    toolCall.output.trim().length === 0
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(toolCall.output) as Partial<RunbookAuthoringProposalReview>;
    if (
      typeof parsed.proposalId !== "string" ||
      typeof parsed.status !== "string" ||
      typeof parsed.kind !== "string" ||
      parsed.proposedRunbook === undefined ||
      !Array.isArray(parsed.operationDiffs)
    ) {
      return null;
    }

    return parsed as RunbookAuthoringProposalReview;
  } catch {
    return null;
  }
}

function getRunbookAuthoringProposalsFromMessage(
  message: ChatMessage,
): RunbookAuthoringProposalReview[] {
  if (message.kind !== "agent") return [];

  return message.toolCalls
    .map((toolCall) => parseRunbookAuthoringProposal(toolCall))
    .filter((proposal): proposal is RunbookAuthoringProposalReview => proposal !== null);
}

function RunbookAuthoringProposalCards({
  agent,
  incidentId,
  sessionId,
  message,
  onRevisionRequested,
}: {
  agent: AgentServicePort;
  incidentId: string;
  sessionId: string | null;
  message: ChatMessage;
  onRevisionRequested: (requestedEdit: string) => void;
}) {
  const { t } = useTranslation();
  const proposals = getRunbookAuthoringProposalsFromMessage(message);
  const [decisionStateByProposalId, setDecisionStateByProposalId] = useState<
    Record<string, RunbookAuthoringProposalReview>
  >({});
  const [pendingProposalId, setPendingProposalId] = useState<string | null>(null);
  const [revisionDraftByProposalId, setRevisionDraftByProposalId] = useState<Record<string, string>>({});
  const [errorByProposalId, setErrorByProposalId] = useState<Record<string, string>>({});

  if (proposals.length === 0) return null;

  const setDecisionProposal = (proposal: RunbookAuthoringProposalReview) => {
    setDecisionStateByProposalId((prev) => ({
      ...prev,
      [proposal.proposalId]: proposal,
    }));
  };

  const setProposalError = (proposalId: string, error: unknown) => {
    setErrorByProposalId((prev) => ({
      ...prev,
      [proposalId]: errorMessage(error),
    }));
  };

  return (
    <div className="ml-10 space-y-3">
      {proposals.map((initialProposal) => {
        const proposal =
          decisionStateByProposalId[initialProposal.proposalId] ?? initialProposal;
        const isPending = proposal.status === "pending_approval";
        const isBusy = pendingProposalId === proposal.proposalId;
        const revisionDraft = revisionDraftByProposalId[proposal.proposalId] ?? "";
        const riskLabels = [
          ...new Set(
            proposal.operationDiffs.flatMap((diff) => diff.riskLabels),
          ),
        ];
        const error = errorByProposalId[proposal.proposalId];

        const handleApprove = async () => {
          if (sessionId === null) return;
          setPendingProposalId(proposal.proposalId);
          setErrorByProposalId((prev) => ({ ...prev, [proposal.proposalId]: "" }));
          try {
            const result = await agent.approveRunbookAuthoringProposal({
              sessionId,
              incidentThreadId: incidentId,
              proposalId: proposal.proposalId,
            });
            setDecisionProposal(result.proposal);
          } catch (err: unknown) {
            setProposalError(proposal.proposalId, err);
          } finally {
            setPendingProposalId(null);
          }
        };

        const handleReject = async () => {
          if (sessionId === null) return;
          setPendingProposalId(proposal.proposalId);
          setErrorByProposalId((prev) => ({ ...prev, [proposal.proposalId]: "" }));
          try {
            const result = await agent.rejectRunbookAuthoringProposal({
              sessionId,
              incidentThreadId: incidentId,
              proposalId: proposal.proposalId,
              reason: "Rejected from incident runbook authoring review.",
            });
            setDecisionProposal(result.proposal);
          } catch (err: unknown) {
            setProposalError(proposal.proposalId, err);
          } finally {
            setPendingProposalId(null);
          }
        };

        const handleRequestRevision = async () => {
          if (sessionId === null || revisionDraft.trim().length === 0) return;
          const requestedEdit = revisionDraft.trim();
          setPendingProposalId(proposal.proposalId);
          setErrorByProposalId((prev) => ({ ...prev, [proposal.proposalId]: "" }));
          try {
            const result = await agent.requestRunbookAuthoringRevision({
              sessionId,
              incidentThreadId: incidentId,
              proposalId: proposal.proposalId,
              requestedEdit,
            });
            setDecisionProposal(result.proposal);
            onRevisionRequested(t("common.incidents.reviseRunbookProposal", {
              proposalId: proposal.proposalId,
              requestedEdit,
            }));
          } catch (err: unknown) {
            setProposalError(proposal.proposalId, err);
          } finally {
            setPendingProposalId(null);
          }
        };

        let proposalKindLabel = t("common.incidents.runbookEditProposal");
        if (proposal.kind === "create_new_runbook") {
          proposalKindLabel = t("common.incidents.newRunbookProposal");
        }

        let proposalStatusLabel = t("common.incidents.statusPendingApproval");
        if (proposal.status === "approved") {
          proposalStatusLabel = t("common.incidents.statusApproved");
        }
        if (proposal.status === "rejected") {
          proposalStatusLabel = t("common.incidents.statusRejected");
        }
        if (proposal.status === "revision_requested") {
          proposalStatusLabel = t("common.incidents.statusRevisionRequested");
        }

        return (
          <div
            key={proposal.proposalId}
            className="w-full max-w-3xl rounded-lg border border-border bg-background px-4 py-3 text-sm shadow-sm"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{proposalKindLabel}</span>
                  <span className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {proposalStatusLabel}
                  </span>
                  {proposal.saved && (
                    <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">
                      {t("common.incidents.saved")}
                    </span>
                  )}
                </div>
                <p className="truncate text-muted-foreground">
                  {proposal.proposedRunbook.title}
                </p>
              </div>
              {isPending && (
                <div className="flex shrink-0 flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      void handleApprove();
                    }}
                    disabled={isBusy || sessionId === null || !proposal.validation.valid}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-50 dark:text-emerald-300"
                  >
                    <Check size={13} />
                    {t("common.incidents.approve")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void handleReject();
                    }}
                    disabled={isBusy || sessionId === null}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Ban size={13} />
                    {t("common.incidents.deny")}
                  </button>
                </div>
              )}
            </div>

            {riskLabels.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {riskLabels.map((riskLabel) => (
                  <span
                    key={riskLabel}
                    className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300"
                  >
                    {riskLabel.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            )}

            {(proposal.validation.errors.length > 0 ||
              proposal.validation.warnings.length > 0) && (
              <div className="mt-3 space-y-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
                {proposal.validation.errors.map((validationError) => (
                  <p key={validationError} className="text-destructive">
                    {validationError}
                  </p>
                ))}
                {proposal.validation.warnings.map((warning) => (
                  <p key={warning} className="text-muted-foreground">
                    {warning}
                  </p>
                ))}
              </div>
            )}

            <div className="mt-3 space-y-2">
              {proposal.operationDiffs.map((diff) => (
                <details
                  key={diff.operationId}
                  className="rounded-md border border-border/70 bg-muted/30 px-3 py-2"
                >
                  <summary className="cursor-pointer text-xs font-medium text-foreground">
                    {diff.type.replace(/_/g, " ")}: {diff.rationale}
                  </summary>
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    <pre className="max-h-48 overflow-auto rounded bg-background p-2 text-[11px] leading-relaxed text-muted-foreground">
                      {JSON.stringify(diff.before, null, 2)}
                    </pre>
                    <pre className="max-h-48 overflow-auto rounded bg-background p-2 text-[11px] leading-relaxed text-muted-foreground">
                      {JSON.stringify(diff.after, null, 2)}
                    </pre>
                  </div>
                </details>
              ))}
            </div>

            {isPending && (
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input
                  value={revisionDraft}
                  onChange={(event) => {
                    setRevisionDraftByProposalId((prev) => ({
                      ...prev,
                      [proposal.proposalId]: event.target.value,
                    }));
                  }}
                  className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/50"
                  placeholder={t("common.incidents.suggestDifferentEdit")}
                  disabled={isBusy || sessionId === null}
                />
                <button
                  type="button"
                  onClick={() => {
                    void handleRequestRevision();
                  }}
                  disabled={isBusy || sessionId === null || revisionDraft.trim().length === 0}
                  className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-muted/60 px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw size={13} />
                  {t("common.incidents.suggest")}
                </button>
              </div>
            )}

            {error !== undefined && error.length > 0 && (
              <p className="mt-2 text-xs text-destructive">{error}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function IncidentsPage() {
  const { t } = useTranslation();
  const agent = useAgentService();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [desktopStoreMode, setDesktopStoreMode] = useState<"desktop" | "local">(
    () => {
      if (hasDesktopIncidentsApi()) return "desktop";
      return "local";
    },
  );
  const isDesktopIncidents = desktopStoreMode === "desktop";

  const activeId = searchParams.get("id");
  const viewMode = searchParams.get("view");
  const urlPrompt = searchParams.get("prompt");
  const isHistoryContext = viewMode === "history";

  const [incidents, setIncidents] = useState<IncidentThread[]>(() => {
    if (isDesktopIncidents) return [];
    return loadIncidents();
  });
  const [messagesMap, setMessagesMap] = useState<Record<string, ChatMessage[]>>(
    () => {
      if (isDesktopIncidents) return {};
      return loadIncidentMessages();
    },
  );
  const [desktopHydrated, setDesktopHydrated] = useState(!isDesktopIncidents);
  const [providerConfigs, setProviderConfigs] = useState<
    Record<string, SavedProviderConfig>
  >({});
  const [providerConfigsLoaded, setProviderConfigsLoaded] = useState(
    () => !hasDesktopLlmApi(),
  );
  const [selectedProviderKey, setSelectedProviderKey] =
    useState<ModelCatalogProviderKey | null>(null);
  const [selectedModelId, setSelectedModelId] = useState("");
  // Access level is per-incident state, persisted in the provider lock.
  // Managed here (not in Composer) so it can be saved/restored per chat.
  const [selectedAccessLevel, setSelectedAccessLevel] = useState<AccessLevel>("supervised");
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [composerImages, setComposerImages] = useState<
    ComposerImageAttachment[]
  >([]);
  const [tokenUsageByIncident, setTokenUsageByIncident] = useState<
    Record<string, AgentThreadTokenUsage>
  >(() => loadIncidentTokenUsage());
  const [sessionTokenUsage, setSessionTokenUsage] = useState<
    | AgentThreadTokenUsage
    | undefined
  >();
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const pendingEventsRef = useRef<
    Array<{
      sessionId: string;
      snapshot?: AgentThreadSnapshot;
    }>
  >([]);
  const autoOpenedArtifactsThreadRef = useRef<string | null>(null);
  const desktopSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const desktopStoreFallbackLoggedRef = useRef(false);
  const latestDesktopStateRef = useRef<{
    incidents: IncidentThread[];
    messagesMap: Record<string, ChatMessage[]>;
  }>({
    incidents: [],
    messagesMap: {},
  });
  const desktopHydratedRef = useRef(desktopHydrated);
  const isDesktopIncidentsRef = useRef(isDesktopIncidents);
  const incidentsRef = useRef<IncidentThread[]>([]);
  const reconciledSessionIdsRef = useRef<Set<string>>(new Set());
  const checkingSessionIdsRef = useRef<Set<string>>(new Set());

  const [prompt, setPrompt] = useState("");
  const [showScrollIndicator, setShowScrollIndicator] = useState(false);
  const [isScrollingToBottom, setIsScrollingToBottom] = useState(false);
  const showScrollIndicatorRef = useRef(false);
  const scrollButtonRef = useRef<HTMLButtonElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollAnimationRef = useRef<number | null>(null);

  const activeIncident = incidents.find((i) => i.id === activeId) ?? null;
  const activeSessionId = activeIncident?.sessionId ?? null;
  const rawMessages = useMemo((): ChatMessage[] => {
    if (activeId === null) return [];
    return messagesMap[activeId] ?? [];
  }, [activeId, messagesMap]);
  const configuredProviderKeys = useMemo(
    () => listConfiguredProviderKeys(providerConfigs),
    [providerConfigs],
  );
  const selectedModelCapability = useMemo<ModelCatalogEntry | undefined>(
    () => {
      if (selectedProviderKey === null) return;
      return getCatalogModel(selectedProviderKey, selectedModelId);
    },
    [selectedModelId, selectedProviderKey],
  );
  const composerSupportsPhotos = Boolean(
    selectedModelCapability?.supportsImageInput,
  );
  const composerSupportsFiles = Boolean(
    selectedModelCapability &&
    (selectedModelCapability.supportsPdfInput ||
      selectedModelCapability.supportsAudioInput ||
      selectedModelCapability.supportsVideoInput),
  );
  const composerSupportsThinking = Boolean(
    selectedModelCapability?.supportsThinking,
  );
  const composerFileAccept = useMemo(() => {
    if (selectedModelCapability === undefined) return "";

    const acceptedTypes: string[] = [];
    if (selectedModelCapability.supportsPdfInput)
      acceptedTypes.push(".pdf,application/pdf");
    if (selectedModelCapability.supportsAudioInput)
      acceptedTypes.push("audio/*");
    if (selectedModelCapability.supportsVideoInput)
      acceptedTypes.push("video/*");
    return acceptedTypes.join(",");
  }, [selectedModelCapability]);

  // For past incidents with no in-memory messages, show the original prompt + a note
  const messages = useMemo((): ChatMessage[] => {
    if (
      activeIncident !== null &&
      rawMessages.length === 0 &&
      activeIncident.state !== "IDLE"
    ) {
      const result: ChatMessage[] = [];
      if (activeIncident.prompt.length > 0) {
        result.push({ kind: "user", text: activeIncident.prompt });
      }
      result.push({
        kind: "agent",
        iterations: [],
        activeIterationId: null,
        toolCalls: [],
        finalText: "Session data is no longer available for this incident.",
        status: "done",
      });
      return result;
    }
    return rawMessages;
  }, [activeIncident, rawMessages]);

  latestDesktopStateRef.current = { incidents, messagesMap };
  desktopHydratedRef.current = desktopHydrated;
  isDesktopIncidentsRef.current = isDesktopIncidents;
  incidentsRef.current = incidents;

  const detachIncidentSession = useCallback(
    (incidentId: string, sessionId: string, nextState: AgentSessionState) => {
      setIncidents((prev) =>
        prev.map((incident) => {
          if (incident.id !== incidentId || incident.sessionId !== sessionId) {
            return incident;
          }
          return {
            ...incident,
            state: nextState,
            sessionId: undefined,
          };
        }),
      );
    },
    [],
  );

  useEffect(() => {
    setIncidents((prev) => {
      let changed = false;
      const next = prev.map((incident) => {
        if (normalizeIncidentPreview(incident.lastMessagePreview)) {
          return incident;
        }

        const preview =
          getIncidentPreviewFromMessages(messagesMap[incident.id]) ??
          normalizeIncidentPreview(incident.prompt);

        if (preview === null) {
          return incident;
        }

        changed = true;
        return {
          ...incident,
          lastMessagePreview: preview,
        };
      });

      if (changed) return next;
      return prev;
    });
  }, [messagesMap]);

  useEffect(() => {
    if (!isDesktopIncidents) return;

    let cancelled = false;
    void loadDesktopIncidentState()
      .then((snapshot) => {
        if (cancelled) return;
        setIncidents(snapshot.incidents);
        setMessagesMap(snapshot.messagesMap);
        setDesktopHydrated(true);
      })
            .catch((error: unknown) => {
        if (isMissingIncidentsHandlerError(error)) {
          if (!desktopStoreFallbackLoggedRef.current) {
            desktopStoreFallbackLoggedRef.current = true;
            console.warn(
              "Incidents desktop IPC unavailable, falling back to local storage.",
            );
          }
          if (!cancelled) {
            setIncidents(loadIncidents());
            setMessagesMap(loadIncidentMessages());
            setDesktopStoreMode("local");
            setDesktopHydrated(true);
          }
          return;
        }
        console.error("Failed to load incidents from desktop store:", error);
        captureIncidentException(error, {
          operation: "loadDesktopIncidentState",
          hasDesktopIncidentsApi: true,
        });
        if (!cancelled) {
          setIncidents(loadIncidents());
          setMessagesMap(loadIncidentMessages());
          setDesktopStoreMode("local");
          setDesktopHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isDesktopIncidents]);

  useEffect(() => {
    const handleIncidentStoreUpdate = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          action?: string;
          incidentId?: string;
          archivedAt?: string;
        }>
      ).detail;

      if (detail?.incidentId === undefined) return;

      if (detail.action === "archive") {
        setIncidents((prev) =>
          prev.map((incident) => {
            if (incident.id !== detail.incidentId) return incident;
            return { ...incident, archived: true };
          }),
        );

        if (activeId === detail.incidentId && !isHistoryContext) {
          void navigate("/incidents");
        }
        return;
      }

      if (detail.action === "unarchive") {
        setIncidents((prev) =>
          prev.map((incident) => {
            if (incident.id !== detail.incidentId) return incident;
            return { ...incident, archived: false };
          }),
        );
      }
    };

    window.addEventListener(
      "bitsentry:incidents-updated",
      handleIncidentStoreUpdate,
    );
    return () => {
      window.removeEventListener(
        "bitsentry:incidents-updated",
        handleIncidentStoreUpdate,
      );
    };
  }, [activeId, isHistoryContext, navigate]);

  useEffect(() => {
    if (!hasDesktopLlmApi()) return;

    let cancelled = false;
    const loadProviderConfigs = async () => {
      const llmApi = getDesktopApi()?.llm;
      if (llmApi === undefined) return;

      try {
        const saved = await llmApi.getProviders();
        if (!cancelled) {
          setProviderConfigs(normalizeProviderConfigs(saved));
        }
      } catch (error: unknown) {
        if (!cancelled) {
          captureIncidentException(error, {
            operation: "getProviders",
            source: "incidents",
          });
        }
      } finally {
        if (!cancelled) {
          setProviderConfigsLoaded(true);
        }
      }
    };
    const refreshProviderConfigs = () => {
      void loadProviderConfigs();
    };

    refreshProviderConfigs();
    window.addEventListener(
      LLM_PROVIDERS_UPDATED_EVENT,
      refreshProviderConfigs,
    );
    window.addEventListener("focus", refreshProviderConfigs);

    return () => {
      cancelled = true;
      window.removeEventListener(
        LLM_PROVIDERS_UPDATED_EVENT,
        refreshProviderConfigs,
      );
      window.removeEventListener("focus", refreshProviderConfigs);
    };
  }, []);

  useEffect(() => {
    if (configuredProviderKeys.length === 0) {
      setSelectedProviderKey(null);
      setSelectedModelId("");
      setThinkingEnabled(false);
      return;
    }

    const currentProviderStillValid =
      selectedProviderKey !== null &&
      configuredProviderKeys.includes(selectedProviderKey);

    let nextProviderKey = configuredProviderKeys[0];
    if (currentProviderStillValid) {
      nextProviderKey = selectedProviderKey;
    } else {
      const primaryProviderKey = configuredProviderKeys.find(
        (providerKey) => providerConfigs[providerKey]?.isPrimary,
      );
      if (primaryProviderKey !== undefined) {
        nextProviderKey = primaryProviderKey;
      }
    }

    if (nextProviderKey !== selectedProviderKey) {
      setSelectedProviderKey(nextProviderKey);
    }

    const modelOptions = getProviderModelOptions(
      nextProviderKey,
      providerConfigs,
    );
    const preferredModel = providerConfigs[nextProviderKey]?.model?.trim();
    let nextModelId = "";
    if (
      selectedProviderKey === nextProviderKey &&
      modelOptions.includes(selectedModelId)
    ) {
      nextModelId = selectedModelId;
    } else if (
      preferredModel !== undefined &&
      preferredModel.length > 0 &&
      modelOptions.includes(preferredModel)
    ) {
      nextModelId = preferredModel;
    } else if (modelOptions[0] !== undefined) {
      nextModelId = modelOptions[0];
    }

    if (nextModelId !== selectedModelId) {
      setSelectedModelId(nextModelId);
    }
  }, [
    configuredProviderKeys,
    providerConfigs,
    selectedModelId,
    selectedProviderKey,
  ]);

  useEffect(() => {
    if (selectedModelCapability === undefined) {
      setThinkingEnabled(false);
      return;
    }

    if (!selectedModelCapability.supportsThinking) {
      setThinkingEnabled(false);
      return;
    }

    if (selectedModelCapability.thinkingMode === "always_on") {
      setThinkingEnabled(true);
      return;
    }

    setThinkingEnabled(true);
  }, [selectedModelCapability]);

  useEffect(() => {
    if (isDesktopIncidents && !desktopHydrated) return;

    if (isDesktopIncidents) {
      saveIncidents(incidents);
      saveIncidentMessages(messagesMap);

      if (desktopSyncTimerRef.current != null) {
        clearTimeout(desktopSyncTimerRef.current);
      }
      desktopSyncTimerRef.current = setTimeout(() => {
        desktopSyncTimerRef.current = null;
        void saveDesktopIncidentState(incidents, messagesMap)
          .then(() => {
            window.dispatchEvent(
              new CustomEvent("bitsentry:incidents-updated"),
            );
          })
          .catch((error: unknown) => {
            if (isMissingIncidentsHandlerError(error)) {
              if (!desktopStoreFallbackLoggedRef.current) {
                desktopStoreFallbackLoggedRef.current = true;
                console.warn(
                  "Incidents desktop IPC unavailable, falling back to local storage.",
                );
              }
              saveIncidents(incidents);
              saveIncidentMessages(messagesMap);
              setDesktopStoreMode("local");
              return;
            }
            console.error("Failed to save incidents to desktop store:", error);
            captureIncidentException(error, {
              operation: "saveDesktopIncidentState",
              incidentCount: incidents.length,
              messageMapCount: Object.keys(messagesMap).length,
            });
          });
      }, 150);
      window.dispatchEvent(new CustomEvent("bitsentry:incidents-updated"));
    } else {
      saveIncidents(incidents);
      saveIncidentMessages(messagesMap);
      window.dispatchEvent(new CustomEvent("bitsentry:incidents-updated"));
    }
  }, [desktopHydrated, incidents, isDesktopIncidents, messagesMap]);

  useEffect(() => {
    saveIncidentTokenUsage(tokenUsageByIncident);
  }, [tokenUsageByIncident]);

  useEffect(
    () => () => {
      if (desktopSyncTimerRef.current != null) {
        clearTimeout(desktopSyncTimerRef.current);
        desktopSyncTimerRef.current = null;

        const {
          incidents: latestIncidents,
          messagesMap: latestMessagesMap,
        } = latestDesktopStateRef.current;

        saveIncidents(latestIncidents);
        saveIncidentMessages(latestMessagesMap);

        if (
          isDesktopIncidentsRef.current &&
          desktopHydratedRef.current
        ) {
          void saveDesktopIncidentState(latestIncidents, latestMessagesMap)
            .catch((error: unknown) => {
              if (isMissingIncidentsHandlerError(error)) {
                if (!desktopStoreFallbackLoggedRef.current) {
                  desktopStoreFallbackLoggedRef.current = true;
                  console.warn(
                    "Incidents desktop IPC unavailable, falling back to local storage.",
                  );
                }
                return;
              }
              console.error(
                "Failed to flush incidents to desktop store on cleanup:",
                error,
              );
              captureIncidentException(error, {
                operation: "saveDesktopIncidentState:cleanup",
                incidentCount: latestIncidents.length,
                messageMapCount: Object.keys(latestMessagesMap).length,
              });
            });
        }
      }
    },
    [],
  );

  // Auto-scroll with threshold check - only scroll if user is near bottom (within 64px)
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const suppressNextAutoScrollRef = useRef(false);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const checkScrollPosition = () => {
      // Don't update indicator state during programmatic scroll animation
      if (isScrollingToBottom) return;

      const { scrollTop, scrollHeight, clientHeight } = container;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      // User has scrolled up if more than 64px from bottom
      userScrolledUpRef.current = distanceFromBottom > 64;
      const shouldShowScrollIndicator =
        userScrolledUpRef.current &&
        activeId !== null &&
        rawMessages.length > 0;

      if (showScrollIndicatorRef.current !== shouldShowScrollIndicator) {
        showScrollIndicatorRef.current = shouldShowScrollIndicator;
        setShowScrollIndicator(shouldShowScrollIndicator);
      }
    };

    checkScrollPosition();

    // Track user scroll position
    container.addEventListener("scroll", checkScrollPosition);
    return () => {
      container.removeEventListener("scroll", checkScrollPosition);
    };
  }, [activeId, rawMessages.length, isScrollingToBottom]);

  useEffect(() => {
    const container = scrollContainerRef.current;

    if (
      container === null ||
      activeId === null ||
      userScrolledUpRef.current
    ) {
      suppressNextAutoScrollRef.current = false;
      return;
    }

    if (suppressNextAutoScrollRef.current) {
      suppressNextAutoScrollRef.current = false;
      return;
    }

    container.scrollTop = container.scrollHeight - container.clientHeight;
  }, [rawMessages, activeId]);

  // Per-thread transient state reset is handled in the provider lock restoration
  // effect above (which also runs on activeId change).

  // Reset scroll state when thread changes - NO AUTO SCROLL
  useEffect(() => {
    suppressNextAutoScrollRef.current = true;
    userScrolledUpRef.current = false;
    showScrollIndicatorRef.current = false;
    setShowScrollIndicator(false);
    setIsScrollingToBottom(false);
    // Reset button style
    if (scrollButtonRef.current !== null) {
      scrollButtonRef.current.style.transform = "translateX(-50%)";
      scrollButtonRef.current.style.opacity = "1";
    }
    // Cancel any ongoing scroll animation
    if (scrollAnimationRef.current !== null) {
      cancelAnimationFrame(scrollAnimationRef.current);
      scrollAnimationRef.current = null;
    }
  }, [activeId]);

  // Enforce minimum access for CLI providers whose incident tool bridge needs it.
  useEffect(() => {
    if (
      selectedProviderKey !== null &&
      requiresToolCapableAccess(selectedProviderKey) &&
      selectedAccessLevel === "supervised"
    ) {
      setSelectedAccessLevel("auto-accept-edits");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProviderKey]);

  // Access level is saved to the provider lock on handleSend and handleNewIncident.
  // No intermediate saves — changes before a send are in-memory only.
  useEffect(() => {
    if (activeId === null) {
      setSessionTokenUsage(undefined);
      return;
    }
    setSessionTokenUsage(tokenUsageByIncident[activeId]);
  }, [activeId, tokenUsageByIncident]);

  // Restore provider/model/accessLevel for this incident thread on tab switch.
  // Also resets per-session transient UI state (access level).
  useEffect(() => {
    if (activeId === null) return;

    // Default access level for the new chat
    const defaultLevel: AccessLevel = "supervised";

    if (configuredProviderKeys.length === 0) {
      setSelectedAccessLevel(defaultLevel);
      return;
    }

    const lock = loadProviderLocks()[activeId];
    if (lock === undefined) {
      // No saved lock — reset access level to default so it doesn't leak from the
      // previous tab. Provider/model stay with the global primary selection.
      // No lock is written here; handleSend saves on first use.
      setSelectedAccessLevel(defaultLevel);
      return;
    }

    // Use the same readiness/selectability criteria as the configured-provider
    // list, so an unready CLI lock can't restore its (possibly elevated)
    // accessLevel and have provider normalization then map it onto a different
    // configured provider — e.g. an inherited 'full-access' on a cloud provider.
    const isAvailable = configuredProviderKeys.includes(lock.providerKey);

    if (!isAvailable) {
      // Saved provider no longer configured — reset access level to default.
      setSelectedAccessLevel(defaultLevel);
      return;
    }

    setSelectedProviderKey(lock.providerKey);
    const opts = getProviderModelOptions(lock.providerKey, providerConfigs);
    if (opts.includes(lock.modelId)) {
      setSelectedModelId(lock.modelId);
    } else {
      // Saved model no longer available for this provider — clear the model so
      // the global selection effect picks a valid default for the new provider,
      // preventing the previous thread's model from leaking into this thread.
      setSelectedModelId("");
    }

    // Restore persisted access level; enforce CLI tool-capable minimum.
    const savedLevel = lock.accessLevel ?? defaultLevel;
    let effectiveLevel: AccessLevel = savedLevel;
    if (
      requiresToolCapableAccess(lock.providerKey) &&
      savedLevel === "supervised"
    ) {
      effectiveLevel = "auto-accept-edits";
    }
    setSelectedAccessLevel(effectiveLevel);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, configuredProviderKeys.length, Object.keys(providerConfigs).length]);

  // Pre-populate prompt from ?prompt= URL param (e.g. launched from Runbook page)
  useEffect(() => {
    if (urlPrompt === null || activeId === null) return;
    setPrompt(decodeURIComponent(urlPrompt));
    void navigate(`/incidents?id=${activeId}`, { replace: true });
  }, [urlPrompt, activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const applySnapshotToIncident = useCallback(
    (incidentId: string, snapshot: AgentThreadSnapshot) => {
      const normalizedMessages = normalizeChatMessages(snapshot.messages);

      setMessagesMap((prev) => ({
        ...prev,
        [incidentId]: normalizedMessages,
      }));
      if (snapshot.tokenUsage !== undefined) {
        const tokenUsage = snapshot.tokenUsage;
        setTokenUsageByIncident((prev) => ({
          ...prev,
          [incidentId]: tokenUsage,
        }));
        if (incidentId === activeId) {
          setSessionTokenUsage(tokenUsage);
        }
      }

      const preview = getIncidentPreviewFromMessages(normalizedMessages);
      setIncidents((prev) =>
        prev.map((incident) => {
          if (incident.id !== incidentId) return incident;
          return {
            ...incident,
            state: snapshot.threadState,
            sessionId: incident.sessionId ?? snapshot.sessionId,
            lastMessagePreview: preview ?? incident.lastMessagePreview,
          };
        }),
      );
    },
    [activeId],
  );

  useEffect(() => {
    const unsub = agent.onEvent(({ sessionId: sid, snapshot }) => {
      if (!snapshot) return;

      const incident = incidentsRef.current.find(
        (item) => item.sessionId === sid,
      );
      if (!incident) {
        pendingEventsRef.current.push({ sessionId: sid, snapshot });
        return;
      }
      applySnapshotToIncident(incident.id, snapshot);
    });
    return () => { unsub(); };
  }, [agent, applySnapshotToIncident]);

  useEffect(() => {
    const pending = pendingEventsRef.current;
    if (pending.length === 0) return;

    const remaining: Array<{
      sessionId: string;
      snapshot?: AgentThreadSnapshot;
    }> = [];

    for (const pendingEntry of pending) {
      const incident = incidentsRef.current.find(
        (item) => item.sessionId === pendingEntry.sessionId,
      );
      if (!incident || !pendingEntry.snapshot) {
        remaining.push(pendingEntry);
        continue;
      }
      applySnapshotToIncident(incident.id, pendingEntry.snapshot);
    }

    pendingEventsRef.current = remaining;
  }, [incidents, applySnapshotToIncident]);

  useEffect(() => {
    if (isDesktopIncidents && !desktopHydrated) return;

    const candidates = incidents.filter(
      (incident) =>
        typeof incident.sessionId === "string" &&
        incident.sessionId.length > 0 &&
        !reconciledSessionIdsRef.current.has(incident.sessionId) &&
        !checkingSessionIdsRef.current.has(incident.sessionId),
    );

    if (candidates.length === 0) return;

    for (const incident of candidates) {
      const sessionId = incident.sessionId;
      if (!sessionId) continue;

      checkingSessionIdsRef.current.add(sessionId);

      void agent
        .getStatus(sessionId)
        .then(async (status) => {
          reconciledSessionIdsRef.current.add(sessionId);
          checkingSessionIdsRef.current.delete(sessionId);

          if (status === null) {
            detachIncidentSession(
              incident.id,
              sessionId,
              getRecoveredIncidentState(incident.state),
            );
            return;
          }

          const snapshot = await agent.getSnapshot(sessionId).catch((error: unknown) => {
            captureIncidentException(error, {
              operation: "getSnapshot",
              source: "persisted-session-refresh",
              incidentId: incident.id,
              sessionId,
            });
            return null;
          });
          if (snapshot !== null) {
            applySnapshotToIncident(incident.id, snapshot);
          }
        })
        .catch((error: unknown) => {
          checkingSessionIdsRef.current.delete(sessionId);

          if (isMissingAgentSessionError(error)) {
            reconciledSessionIdsRef.current.add(sessionId);
            detachIncidentSession(
              incident.id,
              sessionId,
              getRecoveredIncidentState(incident.state),
            );
            return;
          }

          console.error(
            "Failed to refresh persisted incident session status:",
            error,
          );
          captureIncidentException(error, {
            operation: "getStatus",
            source: "persisted-session-refresh",
            incidentId: incident.id,
            sessionId,
          });
        });
    }
  }, [
    agent,
    applySnapshotToIncident,
    desktopHydrated,
    detachIncidentSession,
    incidents,
    isDesktopIncidents,
  ]);

  useEffect(() => {
    if (activeId === null || activeIncident?.sessionId === undefined) return;

    let cancelled = false;
    const sessionId = activeIncident.sessionId;
    const incidentState = activeIncident.state;
    void agent
      .getStatus(sessionId)
      .then(async (status) => {
        if (cancelled) return;
        if (status === null) {
          detachIncidentSession(
            activeId,
            sessionId,
            getRecoveredIncidentState(incidentState),
          );
          return;
        }

        const snapshot = await agent.getSnapshot(sessionId).catch((error: unknown) => {
          captureIncidentException(error, {
            operation: "getSnapshot",
            source: "active-session-refresh",
            incidentId: activeId,
            sessionId,
          });
          return null;
        });
        if (!cancelled && snapshot !== null) {
          applySnapshotToIncident(activeId, snapshot);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;

        if (isMissingAgentSessionError(error)) {
          detachIncidentSession(
            activeId,
            sessionId,
            getRecoveredIncidentState(incidentState),
          );
          return;
        }

        console.error("Failed to refresh active incident session status:", error);
        captureIncidentException(error, {
          operation: "getStatus",
          source: "active-session-refresh",
          incidentId: activeId,
          sessionId,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeId,
    activeIncident?.sessionId,
    activeIncident?.state,
    agent,
    applySnapshotToIncident,
    detachIncidentSession,
  ]);

  // ── actions ──────────────────────────────────────────────────────────────

  const handleNewIncident = () => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    setIncidents((prev) => [
      { id, title: "New Incident", createdAt: now, prompt: "", state: "IDLE" },
      ...prev,
    ]);
    // Pre-seed with current settings so new chats inherit the last used
    // provider/model/accessLevel rather than resetting to defaults.
    if (selectedProviderKey !== null) {
      saveProviderLock(id, selectedProviderKey, selectedModelId, selectedAccessLevel);
    }
    setPrompt("");
    void navigate(`/incidents?id=${id}`);
  };

  const handleArchiveIncident = () => {
    if (activeId === null || activeIncident === null) return;

    const nextIncidents = incidents.map((incident) => {
      if (incident.id !== activeId) return incident;
      return { ...incident, archived: true };
    });

    setIncidents(nextIncidents);

    if (isHistoryContext) {
      void navigate("/incidents?view=history");
      return;
    }

    const remaining = nextIncidents.filter(
      (incident) => incident.id !== activeId && incident.archived !== true,
    );
    if (remaining.length > 0) {
      void navigate(`/incidents?id=${remaining[0].id}`);
    } else {
      void navigate("/incidents");
    }
  };

  const handleUnarchiveIncident = useCallback(
    (incidentId: string) => {
      setIncidents((prev) =>
        prev.map((incident) => {
          if (incident.id !== incidentId) return incident;
          return { ...incident, archived: false };
        }),
      );

      window.dispatchEvent(
        new CustomEvent("bitsentry:incidents-updated", {
          detail: { action: "unarchive", incidentId },
        }),
      );

      void navigate(`/incidents?id=${incidentId}`);
    },
    [navigate],
  );

  const handlePickImages = useCallback(() => {
    if (!selectedModelCapability?.supportsImageInput) return;
    imageInputRef.current?.click();
  }, [selectedModelCapability]);

  const handlePickFiles = useCallback(() => {
    if (!composerSupportsFiles) return;
    fileInputRef.current?.click();
  }, [composerSupportsFiles]);

  const handleImageFilesSelected = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;

      const acceptedFiles = Array.from(files)
        .filter((file) => file.type.startsWith("image/"))
        .slice(0, Math.max(0, 4 - composerImages.length));

      const nextImages = await Promise.all(
        acceptedFiles
          .filter((file) => file.size <= 3 * 1024 * 1024)
          .map(async (file) => ({
            id: crypto.randomUUID(),
            type: "image" as const,
            name: file.name || "image",
            mimeType: file.type || "image/png",
            sizeBytes: file.size,
            dataUrl: await readFileAsDataUrl(file),
          })),
      );

      if (nextImages.length === 0) return;
      setComposerImages((prev) => [...prev, ...nextImages].slice(0, 4));
    },
    [composerImages.length],
  );

  const handleComposerPaste = useCallback(
    async (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (!selectedModelCapability?.supportsImageInput) return;

      const clipboardItems = Array.from(event.clipboardData?.items ?? []);
      const imageFiles = clipboardItems
        .filter(
          (item) => item.kind === "file" && item.type.startsWith("image/"),
        )
        .map((item) => item.getAsFile())
        .filter((file): file is File => file instanceof File);

      if (imageFiles.length === 0) return;

      event.preventDefault();

      const transferable = new DataTransfer();
      for (const file of imageFiles) {
        transferable.items.add(file);
      }

      await handleImageFilesSelected(transferable.files);
    },
    [handleImageFilesSelected, selectedModelCapability],
  );

  const handleRemoveComposerImage = useCallback((imageId: string) => {
    setComposerImages((prev) => prev.filter((image) => image.id !== imageId));
  }, []);

  const handleSend = async (options?: {
    accessLevel?: AccessLevel;
    interactionMode?: InteractionMode;
    traitValues?: Record<string, boolean | string>;
  }) => {
    if (
      (!prompt.trim() && composerImages.length === 0) ||
      activeId === null ||
      selectedProviderKey === null ||
      selectedModelId.length === 0
    )
      return;
    if (activeIncident?.archived === true) return;
    const text = prompt.trim();
    const wasRunning = activeIncident?.state === "RUNNING";
    const shouldContinueSession = activeSessionId !== null || wasRunning;
    const preview = normalizeIncidentPreview(text);
    let nextTitle = activeIncident?.title ?? "New Incident";
    if (shouldAutoTitleIncident(activeIncident?.title)) {
      nextTitle = text.slice(0, 50);
      if (nextTitle.length === 0) {
        nextTitle = "New Incident";
      }
    }
    setPrompt("");
    const outgoingImages = composerImages;
    setComposerImages([]);

    // Persist provider, model, and access level for this thread.
    if (selectedProviderKey !== null) {
      saveProviderLock(activeId, selectedProviderKey, selectedModelId, options?.accessLevel ?? selectedAccessLevel);
    }

    setIncidents((prev) =>
      prev.map((incident) => {
        if (incident.id !== activeId) return incident;
        return {
          ...incident,
          title: nextTitle,
          prompt: text,
          state: "RUNNING",
          lastMessagePreview: preview ?? incident.lastMessagePreview,
        };
      }),
    );

    try {
      const runbookId = getRunbookId();
      const llm: {
        providerKey: ModelCatalogProviderKey;
        model: string;
        thinkingEnabled?: boolean;
      } = {
        providerKey: selectedProviderKey,
        model: selectedModelId,
      };
      if (selectedModelCapability?.supportsThinking === true) {
        llm.thinkingEnabled = thinkingEnabled;
      }

      let result: { sessionId: string };
      if (shouldContinueSession) {
        result = await agent.send({
          message: text,
          sessionId: activeSessionId ?? undefined,
          attachments: outgoingImages,
          llm,
          runbookId,
          incidentThreadId: activeId,
          accessLevel: options?.accessLevel ?? selectedAccessLevel,
          interactionMode: options?.interactionMode,
          traitValues: options?.traitValues,
        });
      } else {
        result = await agent.start({
          prompt: text,
          attachments: outgoingImages,
          llm,
          runbookId,
          incidentThreadId: activeId,
          accessLevel: options?.accessLevel ?? selectedAccessLevel,
          interactionMode: options?.interactionMode,
          traitValues: options?.traitValues,
        });
      }
      setIncidents((prev) =>
        prev.map((incident) => {
          if (incident.id !== activeId) return incident;
          return { ...incident, sessionId: result.sessionId };
        }),
      );
      try {
        const snapshot = await agent.getSnapshot(result.sessionId);
        if (snapshot !== null) {
          applySnapshotToIncident(activeId, snapshot);
        }
      } catch (snapshotError: unknown) {
        console.warn(
          "Agent session started but initial snapshot retrieval failed:",
          snapshotError,
        );
        captureIncidentException(snapshotError, {
          operation: "getSnapshot",
          source: "handleSend:start",
          incidentId: activeId,
          sessionId: result.sessionId,
          providerKey: selectedProviderKey,
          modelId: selectedModelId,
        });
      }
    } catch (err: unknown) {
      const message = errorMessage(err);
      const isBusyAgentError =
        message.includes("still responding") ||
        message.includes("already running for this incident");

      if (isBusyAgentError) {
        setPrompt(text);
        setComposerImages(outgoingImages);
        setIncidents((prev) =>
          prev.map((incident) => {
            if (incident.id !== activeId) return incident;
            return {
              ...incident,
              state: "RUNNING",
            };
          }),
        );
        return;
      }

      console.error("Failed to start agent:", err);
      let operation = "agent.start";
      if (shouldContinueSession) {
        operation = "agent.send";
      }
      captureIncidentException(err, {
        operation,
        incidentId: activeId,
        providerKey: selectedProviderKey,
        modelId: selectedModelId,
        accessLevel: options?.accessLevel ?? selectedAccessLevel,
        interactionMode: options?.interactionMode ?? null,
        hasRunbookId: Boolean(getRunbookId()),
        promptLength: text.length,
        attachmentCount: outgoingImages.length,
      });
      setMessagesMap((prev) => ({
        ...prev,
        [activeId]: [
          ...(prev[activeId] ?? []),
          { kind: "user", text, attachments: outgoingImages },
          {
            kind: "agent",
            iterations: [],
            activeIterationId: null,
            toolCalls: [],
            finalText: message,
            status: "error",
            errorMsg: message,
          },
        ],
      }));
      setIncidents((prev) =>
        prev.map((incident) => {
          if (incident.id !== activeId) return incident;
          return { ...incident, state: "FAILED", sessionId: undefined };
        }),
      );
    }
  };

  const handleCancel = async () => {
    if (activeSessionId === null) return;
    await agent.cancel(activeSessionId);
  };

  const incidentState: AgentSessionState = activeIncident?.state ?? "IDLE";
  const isArchivedIncident = activeIncident?.archived === true;
  const artifactCount = useMemo(
    () => countIncidentArtifacts(messages, activeId),
    [activeId, messages],
  );
  const visibleIncidents = useMemo(() => {
    if (isHistoryContext) return incidents;
    return incidents.filter((incident) => incident.archived !== true);
  }, [incidents, isHistoryContext]);

  useEffect(() => {
    if (activeId === null) {
      setArtifactsOpen(false);
      autoOpenedArtifactsThreadRef.current = null;
      return;
    }

    if (autoOpenedArtifactsThreadRef.current !== activeId) {
      setArtifactsOpen(false);
    }

    if (artifactCount === 0) return;
    if (autoOpenedArtifactsThreadRef.current === activeId) return;

    setArtifactsOpen(true);
    autoOpenedArtifactsThreadRef.current = activeId;
  }, [activeId, artifactCount]);

  // ── Thread status for UI state machine ────────────────────────────────────────
  const threadStatus: ThreadStatus = useMemo(() => {
    if (activeIncident === null) return "idle";
    if (!hasValidRunbook()) return "blocked_no_runbook";
    if (incidentState === "RUNNING") return "streaming";
    if (incidentState === "IDLE") return "ready";
    return incidentState.toLowerCase() as ThreadStatus;
  }, [activeIncident, incidentState]);
  const hasConfiguredProvider =
    providerConfigsLoaded &&
    selectedProviderKey !== null &&
    selectedModelId.length > 0;
  const modelOptions = useMemo(() => {
    if (selectedProviderKey === null) return [];
    return getProviderModelOptions(selectedProviderKey, providerConfigs);
  }, [providerConfigs, selectedProviderKey]);
  const capabilityBadges = useMemo(() => {
    if (selectedModelCapability === undefined) return [];
    return getCapabilityBadges(selectedModelCapability);
  }, [selectedModelCapability]);

  // ── Callbacks must be declared before early returns (React hooks rule) ──────

  // Navigate to runbook page (handoff - no inline creation per spec)
  const handleNavigateToRunbook = useCallback(() => {
    void navigate("/runbooks");
  }, [navigate]);

  const handleNavigateToSettings = useCallback(() => {
    let hash = "#coding-agents";
    if (hasManagedDesktopLlmApi()) {
      hash = "#llm-providers";
    }

    void navigate({
      pathname: "/app-settings",
      hash,
    });
  }, [navigate]);

  const isBlocked =
    activeIncident !== null &&
    (threadStatus === "blocked_no_runbook" || !hasConfiguredProvider);
  const isActiveProcessing = threadStatus === "streaming";
  let artifactsButtonClassName = "hover:bg-muted";
  if (artifactsOpen) {
    artifactsButtonClassName = "bg-muted text-foreground";
  }
  let artifactsTooltipLabel = t("common.incidents.showRunbookResults");
  if (artifactsOpen) {
    artifactsTooltipLabel = t("common.incidents.hideRunbookResults");
  }

  // ── Top-bar action buttons (shared) ──────────────────────────────────────

  const topBarActions = (
    <>
      {activeIncident !== null && artifactCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              data-tour="incidents-artifacts-btn"
              onClick={() => { setArtifactsOpen((open) => !open); }}
              className={cn(
                "flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors",
                artifactsButtonClassName,
              )}
            >
              <FileText size={12} />
              {t("common.incidents.runbookResults")}
              {artifactCount > 0 && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">
                  {artifactCount}
                </span>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {artifactsTooltipLabel}
          </TooltipContent>
        </Tooltip>
      )}
      {isActiveProcessing && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => {
                void handleCancel();
              }}
              className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted transition-colors"
            >
              <X size={12} />
              {t("common.actions.cancel")}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("common.incidents.cancelInvestigation")}
          </TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            data-tour="incidents-history-btn"
            onClick={() => {
              void navigate("/incidents?view=history");
            }}
            aria-label={t("common.incidents.incidentHistory")}
            className="flex size-7 items-center justify-center rounded-md border border-border hover:bg-muted transition-colors"
          >
            <History size={13} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("common.incidents.incidentHistory")}
        </TooltipContent>
      </Tooltip>
      {activeIncident && isArchivedIncident && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => { handleUnarchiveIncident(activeIncident.id); }}
              aria-label={t("common.incidents.unarchiveIncident")}
              className="flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted transition-colors"
            >
              <Upload size={13} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("common.incidents.unarchiveIncident")}
          </TooltipContent>
        </Tooltip>
      )}
      {activeIncident && !isArchivedIncident && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleArchiveIncident}
              disabled={isActiveProcessing}
              aria-label={t("common.incidents.archiveIncident")}
              className="flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted transition-colors disabled:opacity-50"
            >
              <Archive size={13} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("common.incidents.archiveIncident")}
          </TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            data-tour="incidents-new-btn"
            onClick={handleNewIncident}
            disabled={isActiveProcessing}
            className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted transition-colors disabled:opacity-50"
          >
            <SquarePen size={12} />
            {t("common.actions.new")}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("common.incidents.newIncident")}
        </TooltipContent>
      </Tooltip>
    </>
  );

  // ── History view ──────────────────────────────────────────────────────────

  const showHistoryView = !activeId;

  if (showHistoryView) {
    return (
      <PageShell>
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="flex-1 text-sm font-medium text-muted-foreground">
              {t("common.incidents.allIncidents")}
            </span>
            {topBarActions}
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-6 page-enter">
            {visibleIncidents.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-3 py-24 text-center text-muted-foreground">
                <ShieldAlert size={36} className="opacity-25" />
                <p className="text-sm">
                  {t("common.incidents.noIncidentsYetCreateOne")}
                </p>
              </div>
            )}
            {visibleIncidents.length > 0 && (
              <div
                data-tour="incidents-list"
                className="divide-y divide-border overflow-hidden rounded-lg border border-border"
              >
                {visibleIncidents.map((inc) => {
                  let incidentHref = `/incidents?id=${inc.id}`;
                  if (isHistoryContext) {
                    incidentHref = `/incidents?view=history&id=${inc.id}`;
                  }
                  let IncidentIcon = ShieldAlert;
                  if (inc.archived === true) {
                    IncidentIcon = Archive;
                  }
                  const preview = normalizeIncidentPreview(
                    inc.lastMessagePreview,
                  );

                  return (
                    <div
                      key={inc.id}
                      className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
                    >
                      <button
                        onClick={() => {
                          void navigate(incidentHref);
                        }}
                        className={cn(
                          "flex min-w-0 flex-1 items-center gap-3 text-left",
                          inc.archived === true && "opacity-50",
                        )}
                      >
                        <IncidentIcon
                          size={14}
                          className="shrink-0 text-muted-foreground"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">
                            {inc.title}
                          </div>
                          {preview !== null && (
                            <div className="truncate text-xs text-muted-foreground">
                              {translateIncidentPreview(preview, t)}
                            </div>
                          )}
                          <div className="text-[11px] text-muted-foreground/70">
                            {relativeTime(inc.createdAt)}
                          </div>
                        </div>
                        <StatusPill state={inc.state} />
                      </button>
                      {inc.archived === true && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => {
                                handleUnarchiveIncident(inc.id);
                              }}
                              aria-label={t(
                                "common.incidents.unarchiveIncident_2",
                              )}
                              className="flex size-7 items-center justify-center rounded-md border border-transparent text-muted-foreground opacity-0 transition-all hover:border-border hover:bg-muted hover:text-foreground group-hover:opacity-100"
                            >
                              <Upload size={13} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="left">
                            {t("common.incidents.unarchiveIncident_2")}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </PageShell>
    );
  }

  // ── Chat view ─────────────────────────────────────────────────────────────
  let messagesTopPaddingClass = "pt-6";
  if (activeIncident !== null && isArchivedIncident) {
    messagesTopPaddingClass = "pt-28";
  }

  return (
    <PageShell>
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          {activeIncident !== null && (
            <>
              <div data-tour="incidents-title" className="min-w-0 flex-1">
                <EditableTitle
                  value={activeIncident.title}
                  disabled={isArchivedIncident}
                  onChange={(title) => {
                    if (isArchivedIncident) return;
                    setIncidents((prev) =>
                      prev.map((incident) => {
                        if (incident.id !== activeId) return incident;
                        return { ...incident, title };
                      }),
                    );
                  }}
                />
              </div>
              <div data-tour="incidents-status">
                <StatusPill state={incidentState} />
              </div>
            </>
          )}
          {activeIncident === null && (
            <div className="flex-1" />
          )}
          {topBarActions}
        </div>

        {/* Warning banner when blocked */}
        {!isArchivedIncident && threadStatus === "blocked_no_runbook" && (
          <WarningBanner onNavigateToRunbook={handleNavigateToRunbook} />
        )}
        {!isArchivedIncident &&
          threadStatus !== "blocked_no_runbook" &&
          providerConfigsLoaded &&
          !hasConfiguredProvider && (
            <ProviderBanner onNavigateToSettings={handleNavigateToSettings} />
          )}

        <div className="relative flex-1 overflow-hidden">
          <div
            className={cn(
              "flex h-full flex-col transition-[margin] duration-300",
              artifactsOpen && "md:mr-[430px]",
            )}
          >
            {/* Messages container with floating scroll button */}
            <div className="relative flex-1 overflow-hidden">
              <div
                ref={scrollContainerRef}
                className={cn(
                  "absolute inset-0 overflow-y-auto px-6 pb-6 space-y-5 page-enter",
                  messagesTopPaddingClass,
                )}
              >
                {activeIncident === null && (
                  <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
                    <ShieldAlert size={36} className="opacity-25" />
                    <p className="text-sm">
                      {t("common.incidents.createOrOpenAnIncident")}
                    </p>
                    <button
                      onClick={handleNewIncident}
                      className="flex items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-2 text-xs hover:border-primary/40 hover:text-foreground transition-colors"
                    >
                      <SquarePen size={12} />
                      {t("common.incidents.newIncident")}
                    </button>
                  </div>
                )}
                {activeIncident !== null &&
                  messages.map((msg, i) => (
                    <div key={i} className="space-y-3">
                      <ChatBubble
                        msg={msg}
                        providerKey={selectedProviderKey}
                      />
                      <RunbookAuthoringProposalCards
                        agent={agent}
                        incidentId={activeIncident.id}
                        sessionId={activeSessionId}
                        message={msg}
                        onRevisionRequested={(requestedEdit) => {
                          setPrompt(requestedEdit);
                        }}
                      />
                    </div>
                  ))}
                <div ref={messagesEndRef} />
              </div>

              {activeIncident !== null && isArchivedIncident && (
                <div className="pointer-events-none absolute inset-x-6 top-6 z-10 rounded-lg border border-border bg-background/95 px-4 py-3 text-sm text-muted-foreground shadow-sm backdrop-blur">
                  {t("common.incidents.thisIncidentIsArchivedAnd")}
                </div>
              )}

              {/* Scroll button - OUTSIDE scroll container to avoid clipping */}
              {showScrollIndicator && (
                <button
                  ref={scrollButtonRef}
                  type="button"
                  onClick={() => {
                    const container = scrollContainerRef.current;
                    const button = scrollButtonRef.current;
                    if (container === null || button === null) return;

                    if (scrollAnimationRef.current !== null) {
                      cancelAnimationFrame(scrollAnimationRef.current);
                    }

                    const targetScroll =
                      container.scrollHeight - container.clientHeight;
                    const startScroll = container.scrollTop;
                    const distance = targetScroll - startScroll;
                    const duration = 300;
                    const buttonMoveDistance = 100;

                    setIsScrollingToBottom(true);

                    const startTime = performance.now();

                    const animateScroll = (currentTime: number) => {
                      const elapsed = currentTime - startTime;
                      const progress = Math.min(elapsed / duration, 1);
                      const easeOut = 1 - Math.pow(1 - progress, 3);

                      container.scrollTop = startScroll + distance * easeOut;

                      const translateY = easeOut * buttonMoveDistance;
                      const opacity = 1 - translateY / 80;
                      button.style.transform = `translateX(-50%) translateY(${String(translateY)}px)`;
                      button.style.opacity = String(Math.max(0, opacity));

                      if (progress < 1) {
                        scrollAnimationRef.current =
                          requestAnimationFrame(animateScroll);
                      } else {
                        userScrolledUpRef.current = false;
                        showScrollIndicatorRef.current = false;
                        setShowScrollIndicator(false);
                        setIsScrollingToBottom(false);
                        scrollAnimationRef.current = null;
                      }
                    };

                    scrollAnimationRef.current =
                      requestAnimationFrame(animateScroll);
                  }}
                  className="absolute left-1/2 -translate-x-1/2 z-10 rounded-full bg-foreground p-2.5 shadow-lg hover:bg-foreground/90"
                  style={{ bottom: "1.5rem" }}
                  aria-label={t("common.incidents.scrollToBottom")}
                >
                  <ArrowDown className="h-5 w-5 text-background" />
                </button>
              )}
            </div>

            {/* Composer */}
            {activeIncident !== null && (
              <Composer
                key={activeId}
                prompt={prompt}
                onPromptChange={setPrompt}
                onSend={(options) => {
                  void handleSend(options);
                }}
                onCancel={() => {
                  void handleCancel();
                }}
                isProcessing={isActiveProcessing}
                isBlocked={isBlocked}
                isArchived={isArchivedIncident}
                composerImages={composerImages}
                onRemoveImage={handleRemoveComposerImage}
                onPickImages={handlePickImages}
                onPickFiles={handlePickFiles}
                onImageFilesSelected={(files) => {
                  void handleImageFilesSelected(files);
                }}
                onPaste={(e) => {
                  void handleComposerPaste(e);
                }}
                imageInputRef={imageInputRef}
                fileInputRef={fileInputRef}
                selectedProviderKey={selectedProviderKey}
                selectedModelId={selectedModelId}
                onSelectProvider={setSelectedProviderKey}
                onSelectModel={setSelectedModelId}
                configuredProviderKeys={configuredProviderKeys}
                providerConfigs={providerConfigs}
                selectedModelCapability={selectedModelCapability}
                thinkingEnabled={thinkingEnabled}
                onThinkingToggle={() => { setThinkingEnabled((v) => !v); }}
                threadStatus={threadStatus}
                composerFileAccept={composerFileAccept}
                tokenUsage={sessionTokenUsage}
                accessLevel={selectedAccessLevel}
                onAccessLevelChange={setSelectedAccessLevel}
              />
            )}
          </div>

          <IncidentArtifactsRail
            isOpen={artifactsOpen}
            onClose={() => { setArtifactsOpen(false); }}
            messages={messages}
            incidentId={activeId}
          />
        </div>
      </div>
    </PageShell>
  );
}
