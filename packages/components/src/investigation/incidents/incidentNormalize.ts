import { customerReportDisplayText } from "@bitsentry-ce/core/features/plugins";
import type { ModelCatalogProviderKey } from "../../llm/modelCatalog";
import type {
  AccessLevel,
  AgentActivityPhase,
  AgentMessageUpdatePayload,
  AgentSessionState,
  AgentThreadTokenUsage,
  ChatMessage,
  ComposerAttachment,
  ComposerTextAttachmentMimeType,
  ToolCallCard,
} from "../../chat/types";
import type { IncidentThread, SessionMessagesCache, UnknownRecord } from "./types";

export function asRecord(value: unknown): UnknownRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as UnknownRecord;
}

export function readJsonRecord(raw: string | null): UnknownRecord {
  if (raw === null || raw.length === 0) return {};
  try {
    const parsed = asRecord(JSON.parse(raw));
    if (parsed === null) return {};
    return parsed;
  } catch {
    return {};
  }
}

export function getString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  if (value.length === 0) return undefined;
  return value;
}

export function getTrimmedString(record: UnknownRecord, key: string): string | undefined {
  const value = getString(record, key);
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

export function isAccessLevel(value: unknown): value is AccessLevel {
  return (
    value === "auto-accept-edits" ||
    value === "full-access"
  );
}

export function isModelCatalogProviderKey(
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

export function normalizeIncidentPreview(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = customerReportDisplayText(value).replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return null;
  return normalized;
}

export function shouldAutoTitleIncident(title: string | null | undefined): boolean {
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

export function normalizeIncidentState(
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

export function fallbackIncident(): IncidentThread {
  return {
    id: crypto.randomUUID(),
    title: "Untitled Incident",
    createdAt: new Date().toISOString(),
    prompt: "",
    state: "IDLE",
  };
}

export function normalizeIncidents(parsed: unknown[]): IncidentThread[] {
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
      archived: record.archived === true || getString(record, "archivedAt") !== undefined,
      lastMessagePreview:
        normalizeIncidentPreview(getString(record, "lastMessagePreview")) ??
        normalizeIncidentPreview(prompt),
    };
  });
}

export function normalizeIncidentTokenUsageMap(
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
    if (usage.kind === "actual" || usage.kind === "estimate") {
      entry.kind = usage.kind;
    }
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
    const rawBudget = usage.sandboxTokenBudget;
    if (asRecord(rawBudget) !== null) {
      entry.sandboxTokenBudget = rawBudget as NonNullable<
        AgentThreadTokenUsage["sandboxTokenBudget"]
      >;
    }

    normalized[incidentId] = entry;
  }
  return normalized;
}

export function updateIncidentTokenUsage(
  tokenUsageByIncident: Record<string, AgentThreadTokenUsage>,
  incidentId: string,
  tokenUsage: AgentThreadTokenUsage,
): Record<string, AgentThreadTokenUsage> {
  const current = tokenUsageByIncident[incidentId];
  if (tokenUsage.kind === "estimate" && current !== undefined) {
    return tokenUsageByIncident;
  }
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(tokenUsage)) {
    return tokenUsageByIncident;
  }
  return { ...tokenUsageByIncident, [incidentId]: tokenUsage };
}

export function selectIncidentTokenUsage(
  tokenUsageByIncident: Record<string, AgentThreadTokenUsage>,
  incidentId: string | null,
): AgentThreadTokenUsage | undefined {
  return incidentId === null ? undefined : tokenUsageByIncident[incidentId];
}

export function normalizeToolCallState(value: unknown): ToolCallCard["state"] {
  if (value === "running" || value === "done" || value === "failed") {
    return value;
  }
  return "done";
}

export function normalizeToolCalls(toolCalls: unknown): ToolCallCard[] {
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

export function dedupeToolCallIds(toolCallIds: unknown): string[] {
  if (!Array.isArray(toolCallIds)) return [];
  return Array.from(
    new Set(toolCallIds.filter((toolCallId) => typeof toolCallId === "string")),
  );
}

export function isSupportedTextAttachmentMimeType(
  value: string,
): value is ComposerTextAttachmentMimeType {
  return (
    value === "text/plain" ||
    value === "text/yaml" ||
    value === "text/x-yaml" ||
    value === "application/yaml" ||
    value === "application/x-yaml" ||
    value === "text/markdown" ||
    value === "text/x-markdown" ||
    value === "application/json"
  );
}

export function normalizeComposerAttachments(
  value: unknown,
): ComposerAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments = value
    .map((attachment): ComposerAttachment | null => {
      const record = asRecord(attachment);
      if (record === null) return null;
      const id = getString(record, "id");
      const name = getString(record, "name");
      const mimeType = getString(record, "mimeType");
      if (
        id === undefined ||
        name === undefined ||
        mimeType === undefined ||
        typeof record.sizeBytes !== "number"
      ) {
        return null;
      }
      if (record.type === "image") {
        const dataUrl = getString(record, "dataUrl");
        if (dataUrl === undefined) return null;
        return { id, type: "image", name, mimeType, sizeBytes: record.sizeBytes, dataUrl };
      }
      if (record.type === "csv") {
        const text = getString(record, "text");
        if (
          mimeType !== "text/csv" ||
          text === undefined ||
          typeof record.rowCount !== "number" ||
          typeof record.totalRowCount !== "number"
        ) {
          return null;
        }
        return {
          id,
          type: "csv",
          name,
          mimeType,
          sizeBytes: record.sizeBytes,
          text,
          rowCount: record.rowCount,
          totalRowCount: record.totalRowCount,
        };
      }
      if (record.type === "text" && isSupportedTextAttachmentMimeType(mimeType)) {
        const text = getString(record, "text");
        if (text === undefined) return null;
        return { id, type: "text", name, mimeType, sizeBytes: record.sizeBytes, text };
      }
      return null;
    })
    .filter(
      (attachment): attachment is ComposerAttachment => attachment !== null,
    );
  if (attachments.length === 0) return undefined;
  return attachments;
}

export function normalizeAgentStatus(value: unknown): Extract<ChatMessage, { kind: "agent" }>["status"] {
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

export function normalizeAgentActivity(value: unknown): AgentActivityPhase | undefined {
  if (
    value === "asking_model" ||
    value === "running_runbook" ||
    value === "waiting_for_summary"
  ) {
    return value;
  }
  return undefined;
}

export function normalizeIterationStatus(value: unknown): "thinking" | "streaming" | "done" | "error" {
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

export function normalizeAgentIterations(value: unknown): Extract<ChatMessage, { kind: "agent" }>["iterations"] {
  if (!Array.isArray(value)) return [];
  return value.map((iteration, index) => {
    const record = asRecord(iteration);
    if (record === null) {
      return {
        id: `iteration-${String(index)}`,
        startedAt: new Date(0).toISOString(),
        text: "",
        toolCallIds: [],
        status: "done",
      };
    }

    return {
      id: getString(record, "id") ?? `iteration-${String(index)}`,
      startedAt: getString(record, "startedAt") ?? new Date(0).toISOString(),
      completedAt: getString(record, "completedAt"),
      text: getString(record, "text") ?? "",
      ...(record.hasCommandOutput === true ? { hasCommandOutput: true as const } : {}),
      toolCallIds: dedupeToolCallIds(record.toolCallIds),
      status: normalizeIterationStatus(record.status),
    };
  });
}

/** Normalizes a stored or IPC message, keeping its id or assigning one. */
export function migrateMessage(msg: unknown, fallbackId: string = crypto.randomUUID()): ChatMessage {
  const record = asRecord(msg);
  const id = (record === null ? undefined : getString(record, "id")) ?? fallbackId;
  return { ...migrateMessageBody(record), id };
}

/**
 * Migrate legacy ChatMessage format to new iterations-based format.
 * Legacy messages had streamText/startedAt directly on agent message.
 */
export function migrateMessageBody(record: Record<string, unknown> | null): ChatMessage {
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
          toolCallIds: dedupeToolCallIds(toolCalls.map((tc) => tc.toolCallId)),
          status: "done",
        },
      ],
      activeIterationId: null,
      finalText: getString(record, "finalText") ?? null,
      status: normalizeAgentStatus(record.status),
      activity: normalizeAgentActivity(record.activity),
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
      activity: normalizeAgentActivity(record.activity),
      errorMsg: getString(record, "errorMsg"),
    };
  }
  return { kind: "user", text: "" };
}

export function normalizeIncidentMessagesMap(
  input: Record<string, unknown>,
): Record<string, ChatMessage[]> {
  const migrated: Record<string, ChatMessage[]> = {};
  for (const [key, msgs] of Object.entries(input)) {
    if (!Array.isArray(msgs)) continue;
    migrated[key] = msgs.map((message, index) => migrateMessage(message, `${key}:${String(index)}`));
  }
  return migrated;
}

/**
 * Applies a full snapshot, reusing the previous message object wherever the
 * raw message is unchanged, so only changed messages are normalized and
 * unchanged rows keep their identity.
 */
export function reconcileMessages(
  previous: SessionMessagesCache | undefined,
  next: ChatMessage[],
): SessionMessagesCache {
  const json = next.map((message) => JSON.stringify(message));
  let changed = previous === undefined || previous.messages.length !== next.length;
  const messages = next.map((message, index) => {
    const reused = previous?.messages[index];
    if (reused !== undefined && previous?.json[index] === json[index]) return reused;
    changed = true;
    return migrateMessage(message);
  });
  if (!changed && previous !== undefined) return previous;
  return { messages, json };
}

/** Replaces the one streamed message, or returns null when the cache is out of step. */
export function applyMessageUpdate(
  previous: SessionMessagesCache | undefined,
  update: AgentMessageUpdatePayload,
): SessionMessagesCache | null {
  const current = previous?.messages[update.messageIndex];
  if (
    previous === undefined ||
    previous.messages.length !== update.messageCount ||
    current?.id === undefined ||
    current.id !== update.message.id
  ) {
    return null;
  }
  const messages = [...previous.messages];
  const json = [...previous.json];
  messages[update.messageIndex] = migrateMessage(update.message);
  json[update.messageIndex] = JSON.stringify(update.message);
  return { messages, json };
}

export function getChatMessagePreview(
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

export function getIncidentPreviewFromMessages(
  messages: ChatMessage[] | undefined,
): string | null {
  if (messages === undefined || messages.length === 0) return null;
  return getChatMessagePreview(messages[messages.length - 1]);
}
