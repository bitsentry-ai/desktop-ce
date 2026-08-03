/**
 * Composer — chat input area with T3Code-style toolbar.
 *
 * Toolbar layout:
 *   [ModelPicker v] [Traits v] [Mode] [Access v]           [Send/Stop]
 *
 * Keyboard: Enter sends (IME-guarded), Shift+Enter = newline.
 * Attachments: plus icon left of textarea for images/files.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ComposerImageAttachment,
  SavedProviderConfig,
  ThreadStatus,
} from "./types";
import { cn } from "../lib/utils";
import {
  type ModelCatalogEntry,
  type ModelCatalogProviderKey,
  getEffectiveComposerOptions,
  getModelContextWindowLimit,
  providerSupportsPlanMode,
  isCliProvider,
} from "../llm/modelCatalog";
import { useTranslation } from "@bitsentry-ce/i18n";
import {
  ImagePlus,
  Paperclip,
  Plus,
  X,
} from "lucide-react";
import { ModelPicker } from "./ModelPicker";
import type { AccessLevel, InteractionMode } from "./types";
import { DEFAULT_ACCESS_LEVEL, DEFAULT_INTERACTION_MODE } from "./types";
import { TraitsDropdown } from "./TraitsDropdown";
import { ModeToggle } from "./ModeToggle";
import { AccessSelector } from "./AccessSelector";
import { SendButton } from "./SendButton";
import { ContextIndicator } from "./ContextIndicator";

export interface ComposerProps {
  prompt: string;
  onPromptChange: (value: string) => void;
  onSend: (options?: {
    accessLevel?: AccessLevel;
    interactionMode?: InteractionMode;
    traitValues?: Record<string, string | boolean>;
  }) => void;
  onCancel: () => void;
  isProcessing: boolean;
  isBlocked: boolean;
  isArchived: boolean;
  // Images
  composerImages: ComposerImageAttachment[];
  onRemoveImage: (id: string) => void;
  onPickImages: () => void;
  onPickFiles: () => void;
  onImageFilesSelected: (files: FileList | null) => void;
  onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  imageInputRef: React.RefObject<HTMLInputElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  // Model selection
  selectedProviderKey: ModelCatalogProviderKey | null;
  selectedModelId: string;
  onSelectProvider: (key: ModelCatalogProviderKey) => void;
  onSelectModel: (modelId: string) => void;
  configuredProviderKeys: ModelCatalogProviderKey[];
  providerConfigs: Record<string, SavedProviderConfig>;
  // Model capabilities
  selectedModelCapability: ModelCatalogEntry | undefined;
  thinkingEnabled: boolean;
  onThinkingToggle: () => void;
  // Placeholders
  placeholder?: string;
  // File accept types
  composerFileAccept?: string;
  // Thread status
  threadStatus?: ThreadStatus;
  // Cumulative token usage for the current session (from final events)
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    contextTokens?: number;
    contextLimit?: number;
  };
  // Controlled access level (managed by parent so it persists per-incident)
  accessLevel?: AccessLevel;
  onAccessLevelChange?: (level: AccessLevel) => void;
}

export function Composer({
  prompt,
  onPromptChange,
  onSend,
  onCancel,
  isProcessing,
  isBlocked,
  isArchived,
  composerImages,
  onRemoveImage,
  onPickImages,
  onPickFiles,
  onImageFilesSelected,
  onPaste,
  imageInputRef,
  fileInputRef,
  selectedProviderKey,
  selectedModelId,
  onSelectProvider,
  onSelectModel,
  configuredProviderKeys,
  providerConfigs,
  selectedModelCapability,
  thinkingEnabled,
  onThinkingToggle,
  placeholder,
  composerFileAccept,
  threadStatus,
  tokenUsage,
  accessLevel: accessLevelProp,
  onAccessLevelChange,
}: ComposerProps) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Local state ────────────────────────────────────────────────────────────
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const attachMenuRef = useRef<HTMLDivElement>(null);

  // Access level: use controlled prop when provided, otherwise internal state.
  const [accessLevelInternal, setAccessLevelInternal] = useState<AccessLevel>(DEFAULT_ACCESS_LEVEL);
  const accessLevel = accessLevelProp ?? accessLevelInternal;
  const setAccessLevel = (level: AccessLevel) => {
    setAccessLevelInternal(level);
    onAccessLevelChange?.(level);
  };
  const [interactionMode, setInteractionMode] = useState<InteractionMode>(DEFAULT_INTERACTION_MODE);
  // Seed with defaults from EXPLICIT composerOptions only (not derived from reasoningOptions).
  // Derived options (cloud LLMs) are controlled by thinkingEnabled; seeding them would override it.
  const [traitValues, setTraitValues] = useState<Record<string, string | boolean>>(() => {
    const explicitOpts = selectedModelCapability?.composerOptions ?? [];
    if (explicitOpts.length === 0) return {};
    const defaults: Record<string, string | boolean> = {};
    for (const opt of explicitOpts) {
      if (opt.type === "select") {
        const defaultChoice = opt.options.find((o) => o.isDefault === true);
        if (defaultChoice !== undefined) defaults[opt.id] = defaultChoice.value;
      } else if (opt.defaultValue !== undefined) {
        defaults[opt.id] = opt.defaultValue;
      }
    }
    return defaults;
  });

  // ── Derived ────────────────────────────────────────────────────────────────
  const composerSupportsPhotos = Boolean(selectedModelCapability?.supportsImageInput);
  const hasAttachOptions = composerSupportsPhotos;
  const canSend = !isBlocked && (prompt.trim().length > 0 || composerImages.length > 0);

  const composerOptions = useMemo(
    () => {
      if (selectedModelCapability === undefined) {
        return [];
      }

      return getEffectiveComposerOptions(selectedModelCapability);
    },
    [selectedModelCapability],
  );
  const contextWindowLimit = useMemo(
    () => getModelContextWindowLimit(selectedModelCapability, traitValues),
    [selectedModelCapability, traitValues],
  );

  let showPlanMode = false;
  if (selectedProviderKey !== null) {
    showPlanMode = providerSupportsPlanMode(selectedProviderKey);
  }

  // Access level is controlled by Incidents.tsx (persisted/restored per incident).
  // No clamping needed here — the parent handles Codex-specific minimum.

  // Reset traitValues to new model's defaults when selectedModelCapability changes
  const prevCapabilityRef = useRef(selectedModelCapability);
  useEffect(() => {
    if (prevCapabilityRef.current === selectedModelCapability) return;
    prevCapabilityRef.current = selectedModelCapability;
    const explicitOpts = selectedModelCapability?.composerOptions ?? [];
    const defaults: Record<string, string | boolean> = {};
    for (const opt of explicitOpts) {
      if (opt.type === "select") {
        const defaultChoice = opt.options.find((o) => o.isDefault === true);
        if (defaultChoice !== undefined) defaults[opt.id] = defaultChoice.value;
      } else if (opt.defaultValue !== undefined) {
        defaults[opt.id] = opt.defaultValue;
      }
    }
    setTraitValues(defaults);
  }, [selectedModelCapability]);

  // traitValues.thinking → onThinkingToggle (user changes via TraitsDropdown)
  useEffect(() => {
    if (traitValues.thinking !== undefined && traitValues.thinking !== thinkingEnabled) {
      onThinkingToggle();
    }
  }, [traitValues.thinking]); // eslint-disable-line react-hooks/exhaustive-deps

  // thinkingEnabled prop → traitValues.thinking (external reset on model switch)
  useEffect(() => {
    setTraitValues((prev) => {
      if (prev.thinking === undefined || prev.thinking === thinkingEnabled) return prev;
      return { ...prev, thinking: thinkingEnabled };
    });
  }, [thinkingEnabled]);

  // ── Close popovers on outside click ────────────────────────────────────────
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target;
      if (
        attachMenuOpen &&
        attachMenuRef.current !== null &&
        target instanceof Node &&
        !attachMenuRef.current.contains(target)
      ) {
        setAttachMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => { document.removeEventListener("mousedown", handleClickOutside); };
  }, [attachMenuOpen]);

  // ── Keyboard: Enter sends, Shift+Enter newline ─────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.nativeEvent.isComposing &&
        !isProcessing &&
        canSend
      ) {
        e.preventDefault();
        onSend({ accessLevel, interactionMode, traitValues });
      }
    },
    [onSend, isProcessing, canSend, accessLevel, interactionMode, traitValues],
  );

  const handleTraitChange = useCallback((id: string, value: string | boolean) => {
    setTraitValues((prev) => ({ ...prev, [id]: value }));
  }, []);

  if (isArchived) return null;

  let placeholderText = placeholder;
  if (placeholderText === undefined) {
    placeholderText = t("common.incidents.describeTheSecurityIssueTo");
    if (isBlocked) {
      placeholderText = t("common.incidents.configureAProviderInSettings");
      if (threadStatus === "blocked_no_runbook") {
        placeholderText = t("common.incidents.createARunbookToEnable");
      }
    }
  }

  let accessSelector: ReactNode = null;
  if (selectedProviderKey !== null && isCliProvider(selectedProviderKey)) {
    accessSelector = (
      <AccessSelector
        value={accessLevel}
        onChange={setAccessLevel}
        disabled={isProcessing}
      />
    );
  }

  let contextIndicator: ReactNode = null;
  if (tokenUsage !== undefined || contextWindowLimit !== undefined) {
    contextIndicator = (
      <ContextIndicator
        inputTokens={tokenUsage?.inputTokens ?? 0}
        outputTokens={tokenUsage?.outputTokens ?? 0}
        contextTokens={tokenUsage?.contextTokens}
        contextLimit={tokenUsage?.contextLimit ?? contextWindowLimit}
        usageUnavailable={tokenUsage === undefined && contextWindowLimit !== undefined}
      />
    );
  }

  return (
    <div className="shrink-0 px-4 pb-4">
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          onImageFilesSelected(event.target.files);
          event.currentTarget.value = "";
        }}
      />
      {/* TODO: Wire file handling end-to-end (currently only images are supported) */}
      <input
        ref={fileInputRef}
        type="file"
        accept={composerFileAccept ?? ""}
        multiple
        className="hidden"
        onChange={(event) => {
          event.currentTarget.value = "";
        }}
      />
      <div
        data-tour="incidents-composer"
        className={cn(
          "group rounded-[20px] border bg-card transition-colors duration-200",
          !isProcessing && !isBlocked && "focus-within:border-ring/45",
          isBlocked && "opacity-60",
        )}
      >
        {/* Textarea area with optional attach button */}
        <div className="relative px-3 pb-2 pt-3.5 sm:px-4 sm:pt-4">
          {composerImages.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {composerImages.map((image) => (
                <div
                  key={image.id}
                  className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                >
                  <img
                    src={image.dataUrl}
                    alt={image.name}
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => { onRemoveImage(image.id); }}
                    className="absolute right-1 top-1 rounded-full bg-background/80 p-0.5 text-muted-foreground hover:bg-background/90"
                    aria-label={t("common.incidents.removeAttachment", {
                      name: image.name,
                    })}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-start gap-2">
            {/* Attach button (left of textarea) */}
            {hasAttachOptions && (
              <div ref={attachMenuRef} className="relative z-40 mt-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => { setAttachMenuOpen((v) => !v); }}
                  disabled={isProcessing || isBlocked}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors",
                    "hover:bg-accent hover:text-foreground/80 disabled:cursor-not-allowed disabled:opacity-50",
                    attachMenuOpen && "bg-accent text-foreground/80",
                  )}
                  aria-label={t("common.incidents.composerOptions")}
                >
                  <Plus size={16} />
                </button>

                {attachMenuOpen && (
                  <div className="absolute bottom-full left-0 mb-2 min-w-[180px] rounded-xl border border-border bg-popover p-1.5 shadow-lg">
                    {composerSupportsPhotos && (
                      <button
                        type="button"
                        onClick={() => {
                          onPickImages();
                          setAttachMenuOpen(false);
                        }}
                        disabled={composerImages.length >= 4}
                        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <ImagePlus size={14} className="shrink-0 text-muted-foreground" />
                        {t("common.incidents.addPhotos")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            <textarea
              ref={textareaRef}
              rows={3}
              value={prompt}
              onChange={(e) => { onPromptChange(e.target.value); }}
              onKeyDown={handleKeyDown}
              onPaste={(event) => { onPaste(event); }}
              disabled={isProcessing || isBlocked}
              placeholder={placeholderText}
              className="w-full flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
            />
          </div>
        </div>

        {/* ── Toolbar ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-1.5 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
          {/* Left: model picker + traits + mode + access */}
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {/* Model picker */}
            <ModelPicker
              selectedProviderKey={selectedProviderKey}
              selectedModelId={selectedModelId}
              onSelectProvider={onSelectProvider}
              onSelectModel={onSelectModel}
              configuredProviderKeys={configuredProviderKeys}
              providerConfigs={providerConfigs}
              threadStatus={threadStatus}
              disabled={isProcessing}
            />

            {/* Traits dropdown (capability-gated) */}
            <TraitsDropdown
              options={composerOptions}
              values={traitValues}
              onChange={handleTraitChange}
              disabled={isProcessing}
            />

            {/* Mode toggle (hidden if provider doesn't support plan mode) */}
            {showPlanMode && (
              <ModeToggle
                value={interactionMode}
                onChange={setInteractionMode}
                disabled={isProcessing}
              />
            )}

            {/* Access selector: only meaningful for CLI providers. Some CLI
                providers need tool-capable access for incident runbook tools. */}
            {accessSelector}

          </div>

          {/* Right: context + send / stop */}
          <div data-tour="incidents-send-btn" className="flex shrink-0 items-center gap-2">
            {contextIndicator}
            <SendButton
              isProcessing={isProcessing}
              canSend={canSend}
              onSend={() => { onSend({ accessLevel, interactionMode, traitValues }); }}
              onCancel={onCancel}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
