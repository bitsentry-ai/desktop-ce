/**
 * ModelPicker — T3Code-style two-panel provider/model picker.
 *
 * Layout:
 *   [Provider sidebar] | [Search + model list]
 *
 * Provider lock: once a conversation is active (threadStatus !== 'idle'),
 * cross-provider switching is disabled. Within-provider model switching
 * remains available.
 *
 * Keyboard: Cmd+K opens, Escape closes.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { cn } from "../lib/utils";
import {
  type ModelCatalogProviderKey,
  getProviderModelCatalog,
  getModelDisplayName,
  isCliProvider,
} from "../llm/modelCatalog";
import { getProviderModelOptions } from "./utils";
import type { SavedProviderConfig, ThreadStatus } from "./types";
import { getProviderLogo } from "./ProviderLogos";
import { useTranslation } from "@bitsentry-ce/i18n";
import { useFavoriteModels } from "../hooks/useFavoriteModels";
import { getDesktopApi } from "../services/desktop-api";
import {
  clearDiscoveredModels,
  mergeDiscoveredModelIds,
  publishDiscoveredModels,
  useDiscoveredModels,
} from "../llm/modelDiscovery";
import { Check, ChevronDown, Cpu, Lock, Search, Star } from "lucide-react";

interface ModelPickerProps {
  selectedProviderKey: ModelCatalogProviderKey | null;
  selectedModelId: string;
  onSelectProvider: (key: ModelCatalogProviderKey) => void;
  onSelectModel: (modelId: string) => void;
  onSelectModelSelection?: (
    providerKey: ModelCatalogProviderKey,
    modelId: string,
  ) => void;
  configuredProviderKeys: ModelCatalogProviderKey[];
  providerConfigs: Record<string, SavedProviderConfig>;
  threadStatus?: ThreadStatus;
  disabled?: boolean;
}

function resolveModelListRequest(
  panelProvider: ModelCatalogProviderKey,
  providerConfigs: Record<string, SavedProviderConfig>,
): Promise<string[]> | null {
  const desktopApi = getDesktopApi();
  if (isCliProvider(panelProvider)) {
    if (panelProvider !== "opencode") return null;
    const localListModels = desktopApi?.llm?.local?.listModels;
    return localListModels === undefined ? null : localListModels(panelProvider);
  }

  const apiListModels = desktopApi?.llm?.listModels;
  if (apiListModels === undefined) return null;
  const config = providerConfigs[panelProvider];
  return apiListModels(panelProvider, {
    apiKey: config?.apiKey,
    baseUrl: config?.baseUrl,
  }).then((result) => result.models);
}

function isMissingApiKeyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /api key is required/i.test(message);
}

function buildTriggerPresentation({
  selectedProviderKey,
  selectedModelId,
  isProviderLocked,
  t,
}: {
  selectedProviderKey: ModelCatalogProviderKey | null;
  selectedModelId: string;
  isProviderLocked: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}): {
  triggerIcon: ReactNode;
  triggerLabel: string;
  triggerTitle: string | undefined;
  triggerRightIcon: ReactNode;
} {
  let triggerIcon: ReactNode = <Cpu size={13} className="shrink-0" />;
  if (selectedProviderKey !== null) {
    const TriggerLogo = getProviderLogo(selectedProviderKey);
    if (TriggerLogo !== null) {
      triggerIcon = <TriggerLogo size={13} className="shrink-0" />;
    }
  }

  let triggerLabel = t("common.incidents.selectModel");
  if (selectedProviderKey !== null && selectedModelId.length > 0) {
    triggerLabel = getModelDisplayName(selectedProviderKey, selectedModelId);
  }

  let triggerTitle: string | undefined;
  if (isProviderLocked && selectedProviderKey !== null) {
    triggerTitle = t("common.modelPicker.providerLockedDuringActiveConversation", {
      provider:
        getProviderModelCatalog(selectedProviderKey)?.displayName ??
        selectedProviderKey,
    });
  }

  const triggerRightIcon: ReactNode = isProviderLocked
    ? <Lock size={9} className="shrink-0 opacity-50" />
    : <ChevronDown size={10} className="shrink-0 opacity-60" />;

  return { triggerIcon, triggerLabel, triggerTitle, triggerRightIcon };
}

function useModelDiscovery({
  open,
  panelProvider,
  providerConfigs,
  setModelLoadErrors,
}: {
  open: boolean;
  panelProvider: ModelCatalogProviderKey | null;
  providerConfigs: Record<string, SavedProviderConfig>;
  setModelLoadErrors: Dispatch<SetStateAction<Record<string, boolean>>>;
}): void {
  useEffect(() => {
    if (!open || panelProvider === null) return;
    const request = resolveModelListRequest(panelProvider, providerConfigs);
    if (request === null) return;

    let cancelled = false;
    setModelLoadErrors((previous) => ({ ...previous, [panelProvider]: false }));

    void request
      .then((models) => {
        if (cancelled) return;
        publishDiscoveredModels(panelProvider, models);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isMissingApiKeyError(error)) {
          clearDiscoveredModels(panelProvider);
          setModelLoadErrors((previous) => ({ ...previous, [panelProvider]: false }));
          return;
        }
        setModelLoadErrors((previous) => ({ ...previous, [panelProvider]: true }));
      });

    return () => {
      cancelled = true;
    };
  }, [open, panelProvider, providerConfigs, setModelLoadErrors]);
}

export function ModelPicker({
  selectedProviderKey,
  selectedModelId,
  onSelectProvider,
  onSelectModel,
  onSelectModelSelection,
  configuredProviderKeys,
  providerConfigs,
  threadStatus,
  disabled,
}: ModelPickerProps) {
  const { t } = useTranslation();
  const { isFavorite, toggleFavorite } = useFavoriteModels();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [modelLoadErrors, setModelLoadErrors] = useState<Record<string, boolean>>({});
  const discoveredModels = useDiscoveredModels();
  // Which provider's models are shown in the right panel
  const [activePanel, setActivePanel] = useState<ModelCatalogProviderKey | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Lock provider once a conversation is active. 'idle', 'blocked_no_runbook', and 'ready'
  // mean no messages sent yet — picker stays fully open. Any other status means at least one
  // message was sent; only within-provider model switching is allowed.
  const isConversationActive = threadStatus !== undefined &&
    threadStatus !== "idle" &&
    threadStatus !== "blocked_no_runbook" &&
    threadStatus !== "ready";
  const isProviderLocked = isConversationActive && selectedProviderKey !== null;

  // When picker opens, default right panel to the selected provider
  useEffect(() => {
    if (open) {
      setActivePanel(selectedProviderKey);
      setSearch("");
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open, selectedProviderKey]);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target;
      if (
        open &&
        ref.current !== null &&
        target instanceof Node &&
        !ref.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => { document.removeEventListener("mousedown", handleClickOutside); };
  }, [open]);

  const handleSelect = useCallback(
    (providerKey: ModelCatalogProviderKey, modelId: string) => {
      const selectModelSelection = onSelectModelSelection;
      if (selectModelSelection !== undefined) {
        selectModelSelection(providerKey, modelId);
      } else {
        onSelectProvider(providerKey);
        onSelectModel(modelId);
      }
      setOpen(false);
    },
    [onSelectModelSelection, onSelectProvider, onSelectModel],
  );

  const handleProviderClick = useCallback(
    (providerKey: ModelCatalogProviderKey) => {
      if (isProviderLocked && providerKey !== selectedProviderKey) return;
      setActivePanel(providerKey);
      setSearch("");
    },
    [isProviderLocked, selectedProviderKey],
  );

  const panelProvider = activePanel ?? selectedProviderKey ?? configuredProviderKeys[0] ?? null;

  useModelDiscovery({
    open,
    panelProvider,
    providerConfigs,
    setModelLoadErrors,
  });

  const panelModels = useMemo(() => {
    if (panelProvider === null) return [];
    const all = mergeDiscoveredModelIds(
      panelProvider,
      getProviderModelOptions(panelProvider, providerConfigs),
      discoveredModels,
    );
    const searchTerm = search.trim().toLowerCase();
    let filtered = all;
    if (searchTerm.length > 0) {
      filtered = all.filter((id) =>
        getModelDisplayName(panelProvider, id).toLowerCase().includes(searchTerm),
      );
    }

    // Starred models float to the top when not searching
    if (searchTerm.length > 0) return filtered;
    const starred = filtered.filter((id) => isFavorite(panelProvider, id));
    const rest = filtered.filter((id) => !isFavorite(panelProvider, id));
    return [...starred, ...rest];
  }, [discoveredModels, panelProvider, providerConfigs, search, isFavorite]);

  // Cmd+K to open/close, Escape to close, Cmd+1–5 to pick Nth model when open
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
      if (open && (e.metaKey || e.ctrlKey) && /^[1-5]$/.test(e.key)) {
        const model = panelModels[parseInt(e.key, 10) - 1];
        if (model !== undefined && panelProvider !== null) {
          e.preventDefault();
          handleSelect(panelProvider, model);
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); };
  }, [open, panelModels, panelProvider, handleSelect]);

  const { triggerIcon, triggerLabel, triggerTitle, triggerRightIcon } =
    buildTriggerPresentation({
      selectedProviderKey,
      selectedModelId,
      isProviderLocked,
      t,
    });

  let panelHeader: ReactNode = null;
  if (panelProvider !== null) {
    panelHeader = (
      <div className="border-b border-border/60 px-3 py-2 text-xs font-semibold text-foreground">
        {getProviderModelCatalog(panelProvider)?.displayName ?? panelProvider}
      </div>
    );
  }

  let modelListContent: ReactNode = (
    <div className="px-3 py-3 text-xs text-muted-foreground/50">
      {t("common.modelPicker.noModelsFound")}
    </div>
  );
  if (
    panelProvider !== null &&
    modelLoadErrors[panelProvider] === true
  ) {
    modelListContent = (
      <div className="px-3 py-3 text-xs text-muted-foreground/50">
        {t("common.modelPicker.modelsUnavailable")}
      </div>
    );
  } else if (panelProvider !== null && panelModels.length > 0) {
    modelListContent = panelModels.map((modelId, idx) => {
      const isSelected =
        selectedProviderKey === panelProvider && selectedModelId === modelId;
      const starred = isFavorite(panelProvider, modelId);

      let shortcut: string | null = null;
      if (idx < 5) {
        shortcut = `⌘${String(idx + 1)}`;
      }

      let rowClassName = "text-muted-foreground";
      if (isSelected) {
        rowClassName = "text-foreground";
      }

      let shortcutContent: ReactNode = null;
      if (shortcut !== null) {
        shortcutContent = (
          <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] font-mono text-muted-foreground/50">
            {shortcut}
          </span>
        );
      }

      let starClassName =
        "opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-amber-400";
      let starTitle = t("common.modelPicker.addToFavorites");
      let starIconClassName = "";
      if (starred) {
        starClassName = "opacity-100 text-amber-400";
        starTitle = t("common.modelPicker.removeFromFavorites");
        starIconClassName = "fill-current";
      }

      return (
        <div
          key={modelId}
          className={cn(
            "group flex w-full items-center gap-2 px-3 py-2 transition-colors hover:bg-accent",
            rowClassName,
          )}
        >
          <button
            type="button"
            onClick={() => { handleSelect(panelProvider, modelId); }}
            className="flex flex-1 items-center gap-2 text-left"
          >
            <span className="w-4 shrink-0">
              {isSelected && <Check size={12} className="text-primary" />}
            </span>
            <span className="flex-1 text-xs">
              {getModelDisplayName(panelProvider, modelId)}
            </span>
          </button>
          {shortcutContent}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleFavorite(panelProvider, modelId);
            }}
            className={cn("shrink-0 transition-opacity", starClassName)}
            title={starTitle}
          >
            <Star size={11} className={starIconClassName} />
          </button>
        </div>
      );
    });
  }

  return (
    <div
      ref={ref}
      data-tour="incidents-model-picker"
      className="relative z-50 shrink-0"
    >
      {/* Trigger */}
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); }}
        disabled={disabled === true || configuredProviderKeys.length === 0}
        title={triggerTitle}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors",
          "text-muted-foreground/70 hover:bg-accent hover:text-foreground/80",
          "disabled:cursor-not-allowed disabled:opacity-50",
          open && "bg-accent text-foreground/80",
        )}
      >
        {triggerIcon}
        <span className="max-w-[10rem] truncate">{triggerLabel}</span>
        {triggerRightIcon}
      </button>

      {/* Two-panel popover */}
      {open && (
        <div className="absolute bottom-full left-0 mb-2 flex overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
          style={{ minWidth: 340, maxHeight: 380 }}>

          {/* Left: provider sidebar */}
          <div className="flex w-12 shrink-0 flex-col gap-1 border-r border-border/60 bg-muted/20 p-1.5 overflow-y-auto">
            {configuredProviderKeys.map((providerKey) => {
              const Logo = getProviderLogo(providerKey);
              const config = providerConfigs[providerKey];
              const isReady = config.isSelectable;
              const isSelected = panelProvider === providerKey;
              const isLocked = isProviderLocked && providerKey !== selectedProviderKey;
              const isCli = isCliProvider(providerKey);

              if (!isReady && !isCli) return null;

              let className = "hover:bg-background/60";
              if (isSelected) {
                className = "bg-background shadow-sm";
              }

              return (
                <button
                  key={providerKey}
                  type="button"
                  onClick={() => { handleProviderClick(providerKey); }}
                  disabled={isLocked}
                  title={getProviderModelCatalog(providerKey)?.displayName ?? providerKey}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-lg transition-colors",
                    className,
                    isLocked && "cursor-not-allowed opacity-30",
                  )}
                >
                  {Logo === null && <Cpu size={18} />}
                  {Logo !== null && <Logo size={18} />}
                </button>
              );
            })}
          </div>

          {/* Right: search + model list */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Provider name header */}
            {panelHeader}

            {isProviderLocked && triggerTitle !== undefined && (
              <div
                role="status"
                className="border-b border-border/60 px-3 py-2 text-[11px] text-muted-foreground"
              >
                {triggerTitle}
              </div>
            )}

            {/* Search */}
            <div className="relative px-3 pt-2 pb-1">
              <Search size={12} className="absolute left-5 top-1/2 -translate-y-1/2 mt-0.5 text-muted-foreground/50" />
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => { setSearch(e.target.value); }}
                placeholder={t("common.modelPicker.searchModels")}
                className="w-full rounded-md bg-muted/40 py-1.5 pl-6 pr-2 text-xs outline-none placeholder:text-muted-foreground/50 focus:bg-muted/60"
              />
            </div>

            {/* Model list */}
            <div className="flex-1 overflow-y-auto py-1">
              {modelListContent}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
