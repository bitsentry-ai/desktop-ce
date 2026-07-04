import { useEffect, useMemo, useState } from "react";

import {
  getCatalogModelIds,
  type ModelCatalogProviderKey,
} from "../../llm/modelCatalog";
import type {
  DesktopRpcChannel,
  ErrorSourceRow,
  LLMProviderDto,
  PluginDescriptor,
  RunbookLlmProviderKey,
} from "../../services";
import { getDesktopApi } from "../../services/desktop-api";
import type { LlmModelOption } from "./RunbookActionFieldShared";

type DesktopIpcInvoke = <T>(
  channel: DesktopRpcChannel,
  payload?: unknown,
) => Promise<T>;

const LLM_PROVIDERS_UPDATED_EVENT = "bitsentry:llm-providers-updated";

export function useRunbookResourceData({
  ipcInvoke,
}: {
  ipcInvoke: DesktopIpcInvoke;
}) {
  const [errorSources, setErrorSources] = useState<ErrorSourceRow[]>([]);
  const [errorSourcesLoading, setErrorSourcesLoading] = useState(true);
  const [llmProviders, setLlmProviders] = useState<LLMProviderDto[]>([]);
  const [pluginDescriptors, setPluginDescriptors] = useState<PluginDescriptor[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(true);

  const errorSourceNameCounts = errorSources.reduce<Record<string, number>>(
    (counts, source) => {
      counts[source.name] = (counts[source.name] ?? 0) + 1;
      return counts;
    },
    {},
  );

  const errorSourceOptions = errorSources.map((source) => ({
    id: source.id,
    label: formatErrorSourceLabel(
      source,
      errorSourceNameCounts[source.name] ?? 0,
    ),
  }));

  const errorSourceLabelsById = errorSourceOptions.reduce<
    Record<string, string>
  >((labels, source) => {
    labels[source.id] = source.label;
    return labels;
  }, {});

  const validErrorSourceIds = useMemo(
    () => new Set(errorSources.map((source) => source.id)),
    [errorSources],
  );

  const selectableLlmProviders = useMemo(
    () =>
      llmProviders.filter(
        (provider) => provider.hasApiKey && provider.isSelectable,
      ),
    [llmProviders],
  );

  const llmProviderLabelsByKey = useMemo(
    () =>
      llmProviders.reduce<Partial<Record<RunbookLlmProviderKey, string>>>(
        (labels, provider) => {
          labels[provider.providerKey] = provider.displayName;
          return labels;
        },
        {},
      ),
    [llmProviders],
  );

  const llmModelOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: LlmModelOption[] = [];

    selectableLlmProviders.forEach((provider) => {
      const providerKey = provider.providerKey;
      const models = mergeProviderModels(
        providerKey,
        provider.availableModels,
        provider.model,
      );

      models.forEach((modelId) => {
        const normalized = modelId.trim();
        if (normalized.length === 0) return;
        const dedupeKey = `${provider.providerKey}:${normalized.toLowerCase()}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        options.push({
          providerKey: provider.providerKey,
          modelId: normalized,
          label: `${provider.displayName} · ${normalized}`,
        });
      });
    });

    return options;
  }, [selectableLlmProviders]);

  const pluginOptions = useMemo(
    () =>
      pluginDescriptors.map((plugin) => ({
        id: plugin.id,
        label: plugin.name,
      })),
    [pluginDescriptors],
  );

  const validPluginActionIdsByPluginId = useMemo(
    () =>
      new Map(
        pluginDescriptors.map((plugin) => [
          plugin.id,
          new Set(plugin.actions.map((action) => action.id)),
        ]),
      ),
    [pluginDescriptors],
  );

  useEffect(() => {
    let cancelled = false;

    const loadErrorSources = async () => {
      setErrorSourcesLoading(true);
      try {
        const response = await ipcInvoke<{ data: ErrorSourceRow[] }>(
          "errorSources:getAll",
          {},
        );
        if (!cancelled) {
          setErrorSources(response.data);
        }
      } catch (error) {
        console.error("Failed to load external sources:", error);
        if (!cancelled) {
          setErrorSources([]);
        }
      } finally {
        if (!cancelled) {
          setErrorSourcesLoading(false);
        }
      }
    };

    void loadErrorSources();
    return () => {
      cancelled = true;
    };
  }, [ipcInvoke]);

  useEffect(() => {
    let cancelled = false;

    const loadPlugins = async () => {
      setPluginsLoading(true);
      try {
        const response = await ipcInvoke<{ data: PluginDescriptor[] }>(
          "plugins:list",
          {},
        );
        if (!cancelled) {
          setPluginDescriptors(response.data);
        }
      } catch (error) {
        console.error("Failed to load plugins:", error);
        if (!cancelled) {
          setPluginDescriptors([]);
        }
      } finally {
        if (!cancelled) {
          setPluginsLoading(false);
        }
      }
    };

    void loadPlugins();
    return () => {
      cancelled = true;
    };
  }, [ipcInvoke]);

  useEffect(() => {
    let cancelled = false;

    const loadLlmProviders = async () => {
      try {
        const desktopApi = getDesktopApi();
        if (desktopApi?.llm === undefined) {
          throw new Error("Desktop API bridge unavailable");
        }

        const providers = await desktopApi.llm.getProviders();
        if (cancelled) {
          return;
        }

        const displayNames: Record<string, string> = {
          groq: "Groq",
          kilocode: "KiloCode",
          openai: "OpenAI",
          anthropic: "Anthropic",
          gemini: "Gemini",
          openrouter: "OpenRouter",
          claude_code: "Claude Code",
          codex: "Codex",
          opencode: "OpenCode",
          cursor: "Cursor",
        };
        const providerTypes: Record<string, LLMProviderDto["providerType"]> = {
          groq: "third_party",
          kilocode: "third_party",
          openai: "research_lab",
          anthropic: "research_lab",
          gemini: "research_lab",
          openrouter: "third_party",
          claude_code: "research_lab",
          codex: "research_lab",
          opencode: "research_lab",
          cursor: "research_lab",
        };

        setLlmProviders(
          Object.entries(providers).map(([providerKey, config]) => {
            let model: string | null = null;
            if (config.model.length > 0) {
              model = config.model;
            }

            return {
              id: providerKey,
              providerKey: providerKey as LLMProviderDto["providerKey"],
              displayName: displayNames[providerKey] ?? providerKey,
              providerType: providerTypes[providerKey] ?? "third_party",
              baseUrl: config.baseUrl,
              hasApiKey: config.hasApiKey,
              model,
              availableModels: mergeProviderModels(
                providerKey as ModelCatalogProviderKey,
                config.availableModels,
                config.model,
              ),
              isPrimary: config.isPrimary,
              isSelectable: config.isSelectable,
              lastTestedAt: null,
              testStatus: null,
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
            };
          }),
        );
      } catch (error) {
        console.error("Failed to load LLM providers:", error);
        if (!cancelled) {
          setLlmProviders([]);
        }
      }
    };

    const handleLlmProvidersUpdated = () => {
      void loadLlmProviders();
    };

    void loadLlmProviders();
    window.addEventListener(
      LLM_PROVIDERS_UPDATED_EVENT,
      handleLlmProvidersUpdated,
    );
    return () => {
      cancelled = true;
      window.removeEventListener(
        LLM_PROVIDERS_UPDATED_EVENT,
        handleLlmProvidersUpdated,
      );
    };
  }, []);

  return {
    errorSourceOptions,
    errorSourceLabelsById,
    errorSourcesLoading,
    errorSourceCount: errorSources.length,
    validErrorSourceIds,
    pluginDescriptors,
    pluginOptions,
    pluginsLoading,
    validPluginActionIdsByPluginId,
    llmProviderLabelsByKey,
    llmModelOptions,
    selectableLlmProviderCount: selectableLlmProviders.length,
  };
}

function mergeProviderModels(
  providerKey: ModelCatalogProviderKey,
  availableModels: string[],
  selectedModel?: string | null,
): string[] {
  const discoveredModels = availableModels
    .map((modelId) => modelId.trim())
    .filter((modelId) => modelId.length > 0);
  let baseModels = discoveredModels;
  if (baseModels.length === 0) {
    baseModels = getCatalogModelIds(providerKey);
  }

  return Array.from(
    new Set(
      [...baseModels, selectedModel ?? ""]
        .map((modelId) => modelId.trim())
        .filter((modelId) => modelId.length > 0),
    ),
  );
}

function formatErrorSourceLabel(
  source: ErrorSourceRow,
  duplicateNameCount: number,
): string {
  if (duplicateNameCount <= 1) {
    return source.name;
  }

  return `${source.name} (${source.id.slice(0, 8)})`;
}
