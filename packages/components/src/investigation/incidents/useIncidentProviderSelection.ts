import { useEffect, useMemo, useState } from "react";
import {
  type ModelCatalogEntry,
  type ModelCatalogProviderKey,
  getModelCapability,
} from "../../llm/modelCatalog";
import {
  getProviderModelOptionsWithDiscovery,
  useDiscoveredModels,
} from "../../llm/modelDiscovery";
import type { AccessLevel, SavedProviderConfig } from "../../chat/types";
import { getDesktopApi } from "../../services/desktop-api";
import { resolveSyncedModelId } from "../provider-selection";
import {
  listConfiguredProviderKeys,
  normalizeProviderConfigs,
} from "./incidentAgentRequest";
import { captureIncidentException, hasDesktopLlmApi } from "./incidentDesktopApi";
import { LLM_PROVIDERS_UPDATED_EVENT, loadProviderLocks } from "./incidentStorage";

/** Provider, model, thinking and access-level selection, restored per incident from its provider lock. */
export function useIncidentProviderSelection(activeId: string | null) {
  const [providerConfigs, setProviderConfigs] = useState<
    Record<string, SavedProviderConfig>
  >({});
  const [providerConfigsLoaded, setProviderConfigsLoaded] = useState(
    () => !hasDesktopLlmApi(),
  );
  const [selectedProviderKey, setSelectedProviderKey] =
    useState<ModelCatalogProviderKey | null>(null);
  const [selectedModelId, setSelectedModelId] = useState("");
  const discoveredModels = useDiscoveredModels();
  // Access level is per-incident state, persisted in the provider lock.
  // Managed here (not in Composer) so it can be saved/restored per chat.
  const [selectedAccessLevel, setSelectedAccessLevel] = useState<AccessLevel>("auto-accept-edits");
  const [thinkingEnabled, setThinkingEnabled] = useState(false);

  const configuredProviderKeys = useMemo(
    () => listConfiguredProviderKeys(providerConfigs),
    [providerConfigs],
  );
  const providerConfigCount = Object.keys(providerConfigs).length;
  const selectedModelCapability = useMemo<ModelCatalogEntry | undefined>(
    () => {
      if (selectedProviderKey === null) return;
      return getModelCapability(selectedProviderKey, selectedModelId);
    },
    [selectedModelId, selectedProviderKey],
  );

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

    const modelOptions = getProviderModelOptionsWithDiscovery(
      nextProviderKey,
      providerConfigs,
      discoveredModels,
    );
    const preferredModel = providerConfigs[nextProviderKey]?.model?.trim();
    const nextModelId = resolveSyncedModelId(
      selectedProviderKey,
      nextProviderKey,
      selectedModelId,
      preferredModel,
      modelOptions,
    );

    if (nextModelId !== selectedModelId) {
      setSelectedModelId(nextModelId);
    }
  }, [
    configuredProviderKeys,
    providerConfigs,
    discoveredModels,
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

  // Restore provider/model/accessLevel for this incident thread on tab switch.
  // Also resets per-session transient UI state (access level).
  useEffect(() => {
    if (activeId === null) return;

    // Default access level for the new chat
    const defaultLevel: AccessLevel = "auto-accept-edits";

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
    const opts = getProviderModelOptionsWithDiscovery(
      lock.providerKey,
      providerConfigs,
      discoveredModels,
    );
    if (opts.includes(lock.modelId)) {
      setSelectedModelId(lock.modelId);
    } else {
      // Saved model no longer available for this provider — clear the model so
      // the global selection effect picks a valid default for the new provider,
      // preventing the previous thread's model from leaking into this thread.
      setSelectedModelId("");
    }

    // Restore the supported persisted access level, defaulting to Safe Tools.
    const savedLevel = lock.accessLevel ?? defaultLevel;
    setSelectedAccessLevel(savedLevel);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeId,
    configuredProviderKeys.length,
    discoveredModels,
    providerConfigCount,
  ]);

  return {
    providerConfigs,
    providerConfigsLoaded,
    selectedProviderKey,
    setSelectedProviderKey,
    selectedModelId,
    setSelectedModelId,
    selectedAccessLevel,
    setSelectedAccessLevel,
    thinkingEnabled,
    setThinkingEnabled,
    configuredProviderKeys,
    selectedModelCapability,
  };
}
