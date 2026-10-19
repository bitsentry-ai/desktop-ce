import IncidentIntegrationsRail, {
  IntegrationsRailTriggers,
  useDesktopIntegrationPorts,
  useIntegrationsRailState,
} from "../IncidentIntegrationsRail";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import type { LegendListRef } from "@legendapp/list/react";
import { hasWaitingAgentIndicator } from "../../chat/ChatBubble";
import IncidentArtifactsRail, {
  countIncidentArtifacts,
} from "../IncidentArtifactsRail";
import {
  ShieldAlert,
  SquarePen,
  ArrowDown,
  X,
  History,
  Archive,
  FileText,
  Upload,
} from "lucide-react";
import { cn } from "../../lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../ui/tooltip";
import { useAgentService } from "../../services/hooks";
import { useNow } from "../../hooks/useNow";
import { type ModelCatalogProviderKey } from "../../llm/modelCatalog";
import { useTranslation } from "@bitsentry-ce/i18n";
import type {
  AccessLevel,
  AgentSessionState,
  AgentThreadTokenUsage,
  ChatMessage,
  ComposerAttachment,
  InteractionMode,
  ThreadStatus,
} from "../../chat/types";
import { settleInterruptedAgentTurn } from "../../chat/runtimeProjection";
import { CustomerReportIntakeChatContext, useCustomerReportIntake } from "../../chat/useCustomerReportIntake";
import {
  canSendIncidentMessage,
  resolveIncidentTitle,
  sendIncidentAgentMessage,
} from "./incidentAgentRequest";
import {
  EditableTitle,
  PageShell,
  ProviderBanner,
  relativeTime,
  StatusPill,
  translateIncidentPreview,
} from "./IncidentChrome";
import {
  captureIncidentException,
  errorMessage,
  getRecoveredIncidentState,
  hasManagedDesktopLlmApi,
  isMissingAgentSessionError,
} from "./incidentDesktopApi";
import {
  getIncidentPreviewFromMessages,
  normalizeIncidentPreview,
  selectIncidentTokenUsage,
} from "./incidentNormalize";
import {
  loadIncidentTokenUsage,
  saveIncidentTokenUsage,
  saveProviderLock,
} from "./incidentStorage";
import { IncidentComposer } from "./IncidentComposer";
import { useIncidentDraftStore } from "./incidentDraftStore";
import { useIncidentListStore } from "./incidentListStore";
import { IncidentMessageList } from "./IncidentMessageList";
import { useIncidentAgentEvents } from "./useIncidentAgentEvents";
import { useIncidentComposerAttachments } from "./useIncidentComposerAttachments";
import { useIncidentPersistence } from "./useIncidentPersistence";
import { useIncidentProviderSelection } from "./useIncidentProviderSelection";

// ─── Main page ────────────────────────────────────────────────────────────────

export default function IncidentsPage() {
  const { t } = useTranslation();
  const now = useNow();
  const agent = useAgentService();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const activeId = searchParams.get("id");
  const {
    incidents,
    messagesMap,
    setMessagesMap,
    appendThreadMessages,
    desktopHydrated,
    isDesktopIncidents,
  } = useIncidentPersistence(activeId);

  const viewMode = searchParams.get("view");
  const urlPrompt = searchParams.get("prompt");
  const isHistoryContext = viewMode === "history";

  const {
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
  } = useIncidentProviderSelection(activeId);
  const [tokenUsageByIncident, setTokenUsageByIncident] = useState<
    Record<string, AgentThreadTokenUsage>
  >(() => loadIncidentTokenUsage());
  const [sessionTokenUsage, setSessionTokenUsage] = useState<
    | AgentThreadTokenUsage
    | undefined
  >();
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const integrationPorts = useDesktopIntegrationPorts();
  const closeRunbookRail = useCallback(() => { setArtifactsOpen(false); }, []);
  const integrationsRail = useIntegrationsRailState({
    incidentId: activeId,
    runbookRailOpen: artifactsOpen,
    closeRunbookRail,
  });
  const autoOpenedArtifactsThreadRef = useRef<string | null>(null);
  const reconciledSessionIdsRef = useRef<Set<string>>(new Set());
  const checkingSessionIdsRef = useRef<Set<string>>(new Set());

  // The id of the incident whose reader has scrolled up from the newest message, if any.
  const [scrolledUpIncidentId, setScrolledUpIncidentId] = useState<string | null>(null);
  const messageListRef = useRef<LegendListRef>(null);

  const activeIncident = incidents.find((i) => i.id === activeId) ?? null;
  const activeSessionId = activeIncident?.sessionId ?? null;
  const rawMessages = useMemo((): ChatMessage[] => {
    if (activeId === null) return [];
    return messagesMap[activeId] ?? [];
  }, [activeId, messagesMap]);
  const composerSupportsFiles = selectedModelCapability !== undefined;
  const composerFileAccept = useMemo(() => {
    if (selectedModelCapability === undefined) return "";

    return [
      ".csv", "text/csv", ".txt", "text/plain", ".md", ".markdown",
      "text/markdown", ".json", "application/json", ".yaml", ".yml",
      "text/yaml", "application/yaml",
    ].join(",");
  }, [selectedModelCapability]);
  const {
    composerImages,
    setComposerImages,
    imageInputRef,
    fileInputRef,
    handlePickImages,
    handlePickFiles,
    handleAttachmentFilesSelected,
    handleComposerPaste,
    handleRemoveComposerImage,
  } = useIncidentComposerAttachments(selectedModelCapability, composerSupportsFiles);

  // Desktop loads a thread's messages when it opens; until then there is nothing to explain.
  const activeMessagesLoaded = !isDesktopIncidents || (activeId !== null && messagesMap[activeId] !== undefined);
  // For past incidents with no in-memory messages, show the original prompt + a note
  const messages = useMemo((): ChatMessage[] => {
    if (
      activeIncident !== null &&
      activeMessagesLoaded &&
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
  }, [activeIncident, activeMessagesLoaded, rawMessages]);

  const detachIncidentSession = useCallback(
    (incidentId: string, sessionId: string, nextState: AgentSessionState) => {
      // The session is gone (app restart), so a turn it was running stops here. This is display
      // only: loading the thread without a session settles it again, and main settles on resume.
      const store = useIncidentListStore.getState();
      if (store.incidents.find((incident) => incident.id === incidentId)?.sessionId !== sessionId) return;
      setMessagesMap((prev) => {
        const messages = prev[incidentId];
        if (messages === undefined) return prev;
        const settled = settleInterruptedAgentTurn(messages, new Date().toISOString());
        return settled === messages ? prev : { ...prev, [incidentId]: settled };
      });
      store.patch(incidentId, { state: nextState, sessionId: undefined });
    },
    [setMessagesMap],
  );

  // Fills in a missing preview from loaded history; live turns set it when they settle.
  useEffect(() => {
    const store = useIncidentListStore.getState();
    for (const incident of store.incidents) {
      if (normalizeIncidentPreview(incident.lastMessagePreview) !== null) continue;
      const preview = getIncidentPreviewFromMessages(messagesMap[incident.id]) ?? normalizeIncidentPreview(incident.prompt);
      if (preview !== null) store.patch(incident.id, { lastMessagePreview: preview });
    }
  }, [messagesMap]);

  useEffect(() => {
    saveIncidentTokenUsage(tokenUsageByIncident);
  }, [tokenUsageByIncident]);

  // Access level is saved to the provider lock on handleSend and handleNewIncident.
  // No intermediate saves — changes before a send are in-memory only.
  useEffect(() => {
    if (activeId === null) {
      setSessionTokenUsage(undefined);
      return;
    }
    setSessionTokenUsage(selectIncidentTokenUsage(tokenUsageByIncident, activeId));
  }, [activeId, tokenUsageByIncident]);

  // Pre-populate prompt from ?prompt= URL param (e.g. launched from Runbook page)
  const applyUrlPrompt = useEffectEvent((prompt: string, incidentId: string) => {
    useIncidentDraftStore.getState().setDraft(incidentId, decodeURIComponent(prompt));
    void navigate(`/incidents?id=${incidentId}`, { replace: true });
  });
  useEffect(() => {
    if (urlPrompt === null || activeId === null) return;
    applyUrlPrompt(urlPrompt, activeId);
  }, [urlPrompt, activeId]);

  const { applySnapshotToIncident } = useIncidentAgentEvents({
    agent,
    activeId,
    setMessagesMap,
    setTokenUsageByIncident,
    setSessionTokenUsage,
  });

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
            applySnapshotToIncident(incident.id, snapshot, snapshot.sequence, true);
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
          applySnapshotToIncident(activeId, snapshot, snapshot.sequence, true);
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
    useIncidentListStore.getState().upsert({ id, title: "New Incident", createdAt: now, prompt: "", state: "IDLE" });
    // Pre-seed with current settings so new chats inherit the last used
    // provider/model/accessLevel rather than resetting to defaults.
    if (selectedProviderKey !== null) {
      saveProviderLock(id, selectedProviderKey, selectedModelId, selectedAccessLevel);
    }
    void navigate(`/incidents?id=${id}`);
  };

  const handleArchiveIncident = () => {
    if (activeId === null || activeIncident === null) return;

    const store = useIncidentListStore.getState();
    store.archive(activeId, new Date().toISOString());
    const nextIncidents = useIncidentListStore.getState().incidents;

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
      useIncidentListStore.getState().unarchive(incidentId);
      void navigate(`/incidents?id=${incidentId}`);
    },
    [navigate],
  );

  /** Sets the composer text and attachments, except for a customer report answer, which leaves the engineer's draft. */
  const setComposerUnlessIntake = (incidentId: string, fromIntake: boolean, text: string, images: ComposerAttachment[]) => {
    if (fromIntake) return;
    const drafts = useIncidentDraftStore.getState();
    if (text === "") drafts.clearDraft(incidentId);
    else drafts.setDraft(incidentId, text);
    setComposerImages(images);
  };

  /**
   * Sends the composer text, or `intakeText`: an answer to a customer report question, which leaves the engineer's
   * own draft and attachments in the composer.
   */
  const handleSend = async (options?: {
    accessLevel?: AccessLevel;
    interactionMode?: InteractionMode;
    traitValues?: Record<string, boolean | string>;
  }, intakeText?: string) => {
    const fromIntake = intakeText !== undefined;
    const draft = activeId === null ? "" : (useIncidentDraftStore.getState().drafts[activeId] ?? "");
    const text = intakeText ?? draft.trim();
    const ready = canSendIncidentMessage(text, fromIntake ? 0 : composerImages.length, activeId, selectedProviderKey, selectedModelId);
    // Sending waits for the thread's history so the reply never lands on a thread shown as empty.
    if (!ready || !activeMessagesLoaded || activeId === null || selectedProviderKey === null || activeIncident?.archived === true) return;
    // Jump to the end so the new message and its reply show even if the reader had scrolled up; the list then stays pinned.
    void messageListRef.current?.scrollToEnd({ animated: false });
    const wasRunning = activeIncident?.state === "RUNNING";
    const shouldContinueSession = activeSessionId !== null || wasRunning;
    const preview = normalizeIncidentPreview(text);
    const nextTitle = resolveIncidentTitle(activeIncident, text);
    const outgoingImages = fromIntake ? [] : composerImages;
    setComposerUnlessIntake(activeId, fromIntake, "", []);

    // Persist provider, model, and access level for this thread.
    if (selectedProviderKey !== null) {
      saveProviderLock(activeId, selectedProviderKey, selectedModelId, options?.accessLevel ?? selectedAccessLevel);
    }

    // The preview follows the user's prompt now, and the agent's reply once the turn settles.
    useIncidentListStore.getState().patch(activeId, {
      title: nextTitle,
      prompt: text,
      state: "RUNNING",
      ...(preview !== null && { lastMessagePreview: preview }),
    });

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
    const sendInput = {
      continueSession: shouldContinueSession,
      text,
      sessionId: activeSessionId,
      attachments: outgoingImages,
      llm,
      incidentThreadId: activeId,
      accessLevel: options?.accessLevel ?? selectedAccessLevel,
      interactionMode: options?.interactionMode,
      traitValues: options?.traitValues,
    };

    // Lives outside the try so the React Compiler can lower its conditionals.
    const handleStartFailure = (err: unknown) => {
      const message = errorMessage(err);
      const isBusyAgentError =
        message.includes("still responding") ||
        message.includes("already running for this incident");

      if (isBusyAgentError) {
        setComposerUnlessIntake(activeId, fromIntake, text, outgoingImages);
        useIncidentListStore.getState().patch(activeId, { state: "RUNNING" });
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
        promptLength: text.length,
        attachmentCount: outgoingImages.length,
      });
      const failedTurn: ChatMessage[] = [
        { id: crypto.randomUUID(), kind: "user", text, attachments: outgoingImages },
        {
          id: crypto.randomUUID(),
          kind: "agent",
          iterations: [],
          activeIterationId: null,
          toolCalls: [],
          finalText: message,
          status: "error",
          errorMsg: message,
        },
      ];
      appendThreadMessages(activeId, failedTurn);
      // Main stores the error bubble as the preview, so show the same.
      const failedPreview = getIncidentPreviewFromMessages(failedTurn);
      useIncidentListStore.getState().patch(activeId, {
        state: "FAILED",
        sessionId: undefined,
        ...(failedPreview !== null && { lastMessagePreview: failedPreview }),
      });
    };

    try {
      const result = await sendIncidentAgentMessage(agent, sendInput);
      useIncidentListStore.getState().patch(activeId, { sessionId: result.sessionId });
      try {
        const snapshot = await agent.getSnapshot(result.sessionId);
        if (snapshot !== null) {
          applySnapshotToIncident(activeId, snapshot, snapshot.sequence, true);
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
      handleStartFailure(err);
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
  const hasWaitingAgentBubble = messages.some(hasWaitingAgentIndicator);
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
    if (incidentState === "RUNNING") return "streaming";
    if (incidentState === "IDLE") return "ready";
    return incidentState.toLowerCase() as ThreadStatus;
  }, [activeIncident, incidentState]);
  const hasConfiguredProvider =
    providerConfigsLoaded &&
    selectedProviderKey !== null &&
    selectedModelId.length > 0;
  // ── Callbacks must be declared before early returns (React hooks rule) ──────

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
    !hasConfiguredProvider;
  const isActiveProcessing = threadStatus === "streaming";
  const customerReportIntake = useCustomerReportIntake({
    client: integrationPorts.customerReportIntake,
    threadId: activeIncident === null || isArchivedIncident ? null : activeId,
    busy: isActiveProcessing || activeIncident?.state === "RUNNING",
    send: (text) => handleSend({ accessLevel: selectedAccessLevel }, text),
  });
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
      {activeIncident !== null && (
        <IntegrationsRailTriggers state={integrationsRail} />
      )}
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
                            {relativeTime(inc.createdAt, now)}
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
  const messagesTopSpacerClass = isArchivedIncident ? "h-28" : "h-6";
  const showScrollIndicator =
    scrolledUpIncidentId !== null && scrolledUpIncidentId === activeId && rawMessages.length > 0;

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
                    if (isArchivedIncident || activeId === null) return;
                    useIncidentListStore.getState().patch(activeId, { title });
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
        {!isArchivedIncident &&
          providerConfigsLoaded &&
          !hasConfiguredProvider && (
            <ProviderBanner onNavigateToSettings={handleNavigateToSettings} />
          )}

        <div className="relative flex-1 overflow-hidden">
          <div
            className={cn(
              "flex h-full flex-col transition-[margin] duration-300",
              (artifactsOpen || integrationsRail.open) && "md:mr-[430px]",
            )}
          >
            {/* Messages container with floating scroll button */}
            <div className="relative flex-1 overflow-hidden">
              <div className="absolute inset-0">
                {activeIncident === null && (
                  <div className="page-enter flex h-full flex-col items-center justify-center gap-3 px-6 pb-6 pt-6 text-center text-muted-foreground">
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
                <CustomerReportIntakeChatContext.Provider value={customerReportIntake.chat}>
                  {activeIncident !== null && (
                    <IncidentMessageList
                      key={activeId}
                      messages={messages}
                      providerKey={selectedProviderKey}
                      listRef={messageListRef}
                      headerClassName={messagesTopSpacerClass}
                      onAtEndChange={(atEnd) => {
                        setScrolledUpIncidentId(atEnd ? null : activeId);
                      }}
                    />
                  )}
                </CustomerReportIntakeChatContext.Provider>
              </div>

              {activeIncident !== null && isArchivedIncident && (
                <div className="pointer-events-none absolute inset-x-6 top-6 z-10 rounded-lg border border-border bg-background/95 px-4 py-3 text-sm text-muted-foreground shadow-sm backdrop-blur">
                  {t("common.incidents.thisIncidentIsArchivedAnd")}
                </div>
              )}

              {/* Scroll button - OUTSIDE scroll container to avoid clipping */}
              {showScrollIndicator && (
                <button
                  type="button"
                  onClick={() => {
                    void messageListRef.current?.scrollToEnd({ animated: true });
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
              <IncidentComposer
                key={activeId}
                incidentId={activeId}
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
                  void handleAttachmentFilesSelected(files);
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
                showThreadWaitingIndicator={!hasWaitingAgentBubble}
                composerFileAccept={composerFileAccept}
                tokenUsage={sessionTokenUsage}
                accessLevel={selectedAccessLevel}
                onAccessLevelChange={setSelectedAccessLevel}
                customerReportIntake={customerReportIntake.composer}
              />
            )}
          </div>

          <IncidentArtifactsRail
            isOpen={artifactsOpen}
            onClose={() => { setArtifactsOpen(false); }}
            messages={messages}
            incidentId={activeId}
            sessionId={activeSessionId}
            onRevisionRequested={(text) => { useIncidentDraftStore.getState().setDraft(activeId, text); }}
          />
          {activeIncident !== null &&
            (integrationPorts.resources !== undefined ||
              integrationPorts.operations !== undefined) && (
            <IncidentIntegrationsRail
              key={activeIncident.id}
              threadId={activeIncident.id}
              disabled={isArchivedIncident}
              isOpen={integrationsRail.open}
              view={integrationsRail.view}
              focusOnOpen={integrationsRail.openedByUser}
              onViewChange={integrationsRail.setView}
              onClose={integrationsRail.close}
              resources={integrationPorts.resources}
              operations={integrationPorts.operations}
              onSummaryChange={integrationsRail.reportSummary}
            />
          )}
        </div>
      </div>
    </PageShell>
  );
}
