import { customerReportDisplayText } from "@bitsentry-ce/core/features/plugins";
import type { ModelCatalogProviderKey } from "../../llm/modelCatalog";
import type { SavedProviderConfig } from "../../chat/types";
import type {
  AgentSendRequest,
  AgentServicePort,
  AgentStartRequest,
} from "../../services/contracts";
import { CODING_AGENT_PRIORITY } from "../../desktop/codingAgentPriority";
import { asRecord, getString, shouldAutoTitleIncident } from "./incidentNormalize";
import type { IncidentAgentRequestBase, IncidentThread } from "./types";

export function canSendIncidentMessage(
  prompt: string,
  imageCount: number,
  activeId: string | null,
  providerKey: ModelCatalogProviderKey | null,
  modelId: string,
): boolean {
  return (prompt.trim().length > 0 || imageCount > 0) && activeId !== null && providerKey !== null && modelId.length > 0;
}

export function buildIncidentAgentRequest(
  input: IncidentAgentRequestBase & { continueSession: true },
): AgentSendRequest;
export function buildIncidentAgentRequest(
  input: IncidentAgentRequestBase & { continueSession: false },
): AgentStartRequest;
export function buildIncidentAgentRequest(
  input: IncidentAgentRequestBase & { continueSession: boolean },
): AgentStartRequest | AgentSendRequest {
  const common = {
    attachments: input.attachments,
    llm: input.llm,
    incidentThreadId: input.incidentThreadId,
    accessLevel: input.accessLevel,
    interactionMode: input.interactionMode,
    traitValues: input.traitValues,
  };

  if (input.continueSession) {
    return {
      message: input.text,
      sessionId: input.sessionId ?? undefined,
      ...common,
    };
  }

  return {
    prompt: input.text,
    ...common,
  };
}

export async function sendIncidentAgentMessage(
  agent: Pick<AgentServicePort, "start" | "send">,
  input: IncidentAgentRequestBase & { continueSession: boolean },
): Promise<{ sessionId: string }> {
  if (input.continueSession) {
    return agent.send(buildIncidentAgentRequest({ ...input, continueSession: true }));
  }

  return agent.start(buildIncidentAgentRequest({ ...input, continueSession: false }));
}

export function resolveIncidentTitle(incident: IncidentThread | null | undefined, text: string): string {
  if (!shouldAutoTitleIncident(incident?.title)) return incident?.title ?? "New Incident";
  return customerReportDisplayText(text).trim().slice(0, 50) || "New Incident";
}

export function listConfiguredProviderKeys(
  savedProviders: Record<string, SavedProviderConfig>,
): ModelCatalogProviderKey[] {
  const orderedKeys: ModelCatalogProviderKey[] = [
    ...CODING_AGENT_PRIORITY,
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

export function normalizeProviderConfigs(
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
