import { useCallback, useEffect, useRef, useState } from "react";
import { getErrorMessage } from "@bitsentry-ce/core";
import { useTranslation } from "@bitsentry-ce/i18n";
import {
  getDesktopApi,
  type DesktopSavedLlmProviderConfig,
} from "../services/desktop-api";
import { useToast } from "../hooks/use-toast";
import type { ProviderId as CodingAgentId } from "../settings/CodingAgentProvidersSection";

const PRIMARY_AGENT_PRIORITY: CodingAgentId[] = [
  "codex",
  "cursor",
  "opencode",
  "claude_code",
];

const PRIMARY_AGENT_IDS = new Set<string>(PRIMARY_AGENT_PRIORITY);

export type DesktopSavedLlmProviders = Partial<
  Record<string, DesktopSavedLlmProviderConfig>
>;

function createPlaceholderSavedProvider(
  isPrimary: boolean,
): DesktopSavedLlmProviderConfig {
  return {
    hasApiKey: false,
    baseUrl: "",
    model: "",
    availableModels: [],
    isSelectable: true,
    isPrimary,
  };
}

function cloneSavedProviders(
  saved: DesktopSavedLlmProviders,
): DesktopSavedLlmProviders {
  const next: DesktopSavedLlmProviders = {};
  for (const [providerKey, config] of Object.entries(saved)) {
    if (config === undefined) continue;
    next[providerKey] = {
      ...config,
      availableModels: [...config.availableModels],
    };
  }
  return next;
}

function getPrimaryProviderKey(saved: DesktopSavedLlmProviders): string | null {
  for (const [providerKey, config] of Object.entries(saved)) {
    if (config?.isPrimary === true) return providerKey;
  }
  return null;
}

export function withPrimarySavedProvider(
  saved: DesktopSavedLlmProviders,
  providerId: string,
): DesktopSavedLlmProviders {
  const next = cloneSavedProviders(saved);
  for (const [providerKey, config] of Object.entries(next)) {
    if (config === undefined) continue;
    next[providerKey] = {
      ...config,
      isPrimary: providerKey === providerId,
    };
  }
  next[providerId] = {
    ...(next[providerId] ?? createPlaceholderSavedProvider(false)),
    isPrimary: true,
  };
  return next;
}

export function getPrimaryCodingAgentFromSavedProviders(
  saved: DesktopSavedLlmProviders,
): CodingAgentId | null {
  for (const providerKey of PRIMARY_AGENT_PRIORITY) {
    if (saved[providerKey]?.isPrimary === true) return providerKey;
  }
  return null;
}

function requireDesktopLlmApi() {
  const desktopApi = getDesktopApi();
  if (typeof desktopApi?.llm?.getProviders !== "function") {
    throw new Error("Desktop LLM API is unavailable.");
  }

  return desktopApi.llm;
}

export async function saveDesktopPrimaryCodingAgent(
  providerId: CodingAgentId,
): Promise<void> {
  const llmApi = requireDesktopLlmApi();
  if (typeof llmApi.saveProvider !== "function") {
    throw new Error("Desktop LLM saveProvider API is unavailable.");
  }

  await llmApi.saveProvider(providerId, { isPrimary: true });
}

export function useDesktopSavedLlmProviders() {
  const savedProvidersRef = useRef<DesktopSavedLlmProviders | null>(null);
  const loadSavedProvidersPromiseRef = useRef<
    Promise<DesktopSavedLlmProviders | null> | null
  >(null);
  const savedProvidersRevisionRef = useRef(0);
  const [primaryAgent, setPrimaryAgent] = useState<CodingAgentId | null>(null);

  const loadSavedProvidersOnce =
    useCallback(async (): Promise<DesktopSavedLlmProviders | null> => {
      if (savedProvidersRef.current !== null) {
        return savedProvidersRef.current;
      }
      if (loadSavedProvidersPromiseRef.current !== null) {
        return loadSavedProvidersPromiseRef.current;
      }

      const loadRevision = savedProvidersRevisionRef.current;
      const loadPromise = (async () => {
        try {
  const llmApi = requireDesktopLlmApi();
          const saved = await llmApi.getProviders();
          if (loadRevision !== savedProvidersRevisionRef.current) {
            const cachedPrimaryProviderKey = getPrimaryProviderKey(
              savedProvidersRef.current ?? {},
            );
            if (cachedPrimaryProviderKey !== null) {
              const merged = withPrimarySavedProvider(
                saved,
                cachedPrimaryProviderKey,
              );
              savedProvidersRef.current = merged;
              return merged;
            }
            return savedProvidersRef.current;
          }
          savedProvidersRef.current = saved;
          setPrimaryAgent(getPrimaryCodingAgentFromSavedProviders(saved));
          return saved;
        } catch {
          return null;
        }
      })();

      loadSavedProvidersPromiseRef.current = loadPromise;
      return loadPromise;
    }, []);

  const setCachedPrimaryProvider = useCallback(
    (providerId: string): DesktopSavedLlmProviders | null => {
      let previous: DesktopSavedLlmProviders | null = null;
      if (savedProvidersRef.current !== null) {
        previous = cloneSavedProviders(savedProvidersRef.current);
      }
      savedProvidersRef.current = withPrimarySavedProvider(
        savedProvidersRef.current ?? {},
        providerId,
      );
      savedProvidersRevisionRef.current += 1;
      loadSavedProvidersPromiseRef.current = null;
      let nextPrimaryAgent: CodingAgentId | null = null;
      if (PRIMARY_AGENT_IDS.has(providerId)) {
        nextPrimaryAgent = providerId as CodingAgentId;
      }
      setPrimaryAgent(nextPrimaryAgent);
      return previous;
    },
    [],
  );

  const restoreCachedSavedProviders = useCallback(
    (previous: DesktopSavedLlmProviders | null) => {
      if (previous === null) {
        savedProvidersRef.current = null;
      } else {
        savedProvidersRef.current = cloneSavedProviders(previous);
      }
      savedProvidersRevisionRef.current += 1;
      loadSavedProvidersPromiseRef.current = null;
      let restoredPrimaryAgent: CodingAgentId | null = null;
      if (previous !== null) {
        restoredPrimaryAgent = getPrimaryCodingAgentFromSavedProviders(previous);
      }
      setPrimaryAgent(restoredPrimaryAgent);
    },
    [],
  );

  return {
    primaryAgent,
    setPrimaryAgent,
    loadSavedProvidersOnce,
    setCachedPrimaryProvider,
    restoreCachedSavedProviders,
  };
}

type CaptureDesktopAnalyticsEvent = (
  event: string,
  properties?: Record<string, unknown>,
) => void;

type SetDesktopPrimaryAgentOptions = {
  onOptimisticSelection?: (id: CodingAgentId) => void;
  onSuccess?: () => void;
  onError?: (
    error: unknown,
    context: { previousPrimaryAgent: CodingAgentId | null },
  ) => void;
};

export function useDesktopPrimaryAgentSelection({
  captureDesktopAnalyticsEvent,
}: {
  captureDesktopAnalyticsEvent: CaptureDesktopAnalyticsEvent;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const {
    primaryAgent,
    setPrimaryAgent,
    loadSavedProvidersOnce,
    setCachedPrimaryProvider,
    restoreCachedSavedProviders,
  } = useDesktopSavedLlmProviders();
  const primarySelectionPendingRef = useRef(false);
  const [isPrimarySelectionPending, setIsPrimarySelectionPending] =
    useState(false);

  useEffect(() => {
    void loadSavedProvidersOnce();
  }, [loadSavedProvidersOnce]);

  const beginPrimarySelection = useCallback(() => {
    if (primarySelectionPendingRef.current) return false;
    primarySelectionPendingRef.current = true;
    setIsPrimarySelectionPending(true);
    return true;
  }, []);

  const endPrimarySelection = useCallback(() => {
    primarySelectionPendingRef.current = false;
    setIsPrimarySelectionPending(false);
  }, []);

  const handleSetPrimaryAgent = useCallback(
    (
      id: CodingAgentId,
      options?: SetDesktopPrimaryAgentOptions,
    ) => {
      if (!beginPrimarySelection()) return;

      const previousPrimaryAgent = primaryAgent;
      const previousSavedProviders = setCachedPrimaryProvider(id);
      setPrimaryAgent(id);
      options?.onOptimisticSelection?.(id);

      void saveDesktopPrimaryCodingAgent(id)
        .then(() => {
          setCachedPrimaryProvider(id);
          setPrimaryAgent(id);
          captureDesktopAnalyticsEvent("desktop_coding_agent_primary_set", {
            provider: id,
          });
          options?.onSuccess?.();
        })
        .catch((error: unknown) => {
          restoreCachedSavedProviders(previousSavedProviders);
          setPrimaryAgent(previousPrimaryAgent);
          options?.onError?.(error, { previousPrimaryAgent });
          toast({
            variant: "destructive",
            title: t("settings.appSettings.updateFailed"),
            description: getErrorMessage(
              error,
              t("settings.appSettings.failedToUpdatePrimaryAgent"),
            ),
          });
        })
        .finally(() => {
          endPrimarySelection();
        });
    },
    [
      beginPrimarySelection,
      captureDesktopAnalyticsEvent,
      endPrimarySelection,
      primaryAgent,
      restoreCachedSavedProviders,
      setCachedPrimaryProvider,
      setPrimaryAgent,
      t,
      toast,
    ],
  );

  return {
    primaryAgent,
    setPrimaryAgent,
    loadSavedProvidersOnce,
    isPrimarySelectionPending,
    beginPrimarySelection,
    endPrimarySelection,
    setCachedPrimaryProvider,
    restoreCachedSavedProviders,
    handleSetPrimaryAgent,
  };
}
