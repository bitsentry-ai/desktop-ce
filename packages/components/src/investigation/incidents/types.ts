import type { ModelCatalogProviderKey } from "../../llm/modelCatalog";
import type {
  AccessLevel,
  AgentSessionState,
  ChatMessage,
  ComposerAttachment,
  InteractionMode,
} from "../../chat/types";
import type { AgentLlmSelection } from "../../services/contracts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DesktopIpcError = {
  code?: string;
  message?: string;
};

export interface IncidentThread {
  id: string;
  title: string;
  createdAt: string;
  prompt: string;
  state: AgentSessionState;
  sessionId?: string;
  archived?: boolean;
  /** Set when archived in this session, so a later save sends the same time. */
  archivedAt?: string;
  lastMessagePreview?: string | null;
}

export type IncidentAgentRequestBase = {
  text: string;
  sessionId: string | null;
  attachments: ComposerAttachment[];
  llm: AgentLlmSelection;
  incidentThreadId: string;
  accessLevel?: AccessLevel;
  interactionMode?: InteractionMode;
  traitValues?: Record<string, boolean | string>;
};

export type ProviderLockEntry = {
  providerKey: ModelCatalogProviderKey;
  modelId: string;
  accessLevel?: AccessLevel;
};

export type UnknownRecord = Record<string, unknown>;

/** Normalized messages for a session plus the raw JSON they were built from. */
export interface SessionMessagesCache {
  messages: ChatMessage[];
  json: string[];
}
