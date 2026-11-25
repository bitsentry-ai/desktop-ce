import IncidentIntegrationsRail, {
  IntegrationsRailTriggers,
  useDesktopIntegrationPorts,
  useIntegrationsRailState,
} from "../IncidentIntegrationsRail";
import {
  type ReactNode,
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
import { isLastAgentTurnInterrupted, settleInterruptedAgentTurn } from "../../chat/runtimeProjection";
import { CustomerReportIntakeChatContext, useCustomerReportIntake } from "../../chat/useCustomerReportIntake";
import {
  EMPTY_SESSION_QUEUE,
  useComposerQueue,
  type SessionQueueState,
} from "../../chat/useComposerQueue";
import type { AgentMessageDelivery } from "../../services/contracts";
import { CitationSelectionToolbar } from "../../chat/CitationControls";
import {
  canSendIncidentMessage,
  resolveIncidentTitle,
  sendIncidentAgentMessage,
} from "./incidentAgentRequest";
import {
  EditableTitle,
  PageShell,
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
import { ComposerBlockedNotice } from "../../chat/ComposerBlockedNotice";
import { ResponseStalledBadge } from "../../chat/ResponseStalledBadge";
import { TurnStopContext } from "../../chat/turnStop";
import { addIncidentCitation, readComposedDraft, useIncidentDraftStore } from "./incidentDraftStore";
import { useIncidentListStore } from "./incidentListStore";
import { IncidentMessageList } from "./IncidentMessageList";
import { useIncidentAgentEvents } from "./useIncidentAgentEvents";
import { useIncidentComposerAttachments } from "./useIncidentComposerAttachments";
import { useIncidentPersistence } from "./useIncidentPersistence";
import { useIncidentProviderSelection } from "./useIncidentProviderSelection";
import { Button } from "../../ui/button";
import { EmptyState } from "../../ui/empty-state";

/**
 * Stops the running turn through its session; null while there is no session to cancel. A hook rather than a plain
 * helper, so the React Compiler keeps treating the handler as immutable and still compiles the page.
 */
function useTurnStop(sessionId: string | null, cancel: () => Promise<void>): (() => void) | null {
  if (sessionId === null) return null;
  return () => {
    void cancel();
  };
}

/** The composer's notice while no provider is configured, once the provider settings have loaded. */
function useProviderNotice(loaded: boolean, openSettings: () => void): ReactNode {
  const { t } = useTranslation();
  if (!loaded) return undefined;
  return (
    <ComposerBlockedNotice
      title={t("common.incidents.noChatModelIsConfigured")}
      description={t("common.incidents.addAnApiKeyIn")}
      actionLabel={t("common.incidents.openSettings")}
      onAction={openSettings}
    />
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const NEW_INCIDENT_HEADER_BASE =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 max-sm:h-11";

/** On the incident list the header's New incident is the page's primary action. */
const NEW_INCIDENT_HEADER_CLASS = `${NEW_INCIDENT_HEADER_BASE} bg-primary text-primary-foreground hover:bg-[hsl(var(--primary-hover))]`;

/**
 * Outlined inside an incident, where recovering or continuing that incident comes first, and while the list is empty,
 * where the empty state's New incident is the primary action.
 */
const NEW_INCIDENT_HEADER_QUIET_CLASS = `${NEW_INCIDENT_HEADER_BASE} border border-border bg-background text-foreground hover:bg-muted`;

function newIncidentHeaderClass(activeId: string | null, incidentCount: number): string {
  const onList = activeId === null || activeId.length === 0;
  return onList && incidentCount > 0 ? NEW_INCIDENT_HEADER_CLASS : NEW_INCIDENT_HEADER_QUIET_CLASS;
}

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
    loadOlderMessages,
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
  const closeRunbookRail = () => { setArtifactsOpen(false); };
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
  /** Resumes following the newest output and scrolls to it. */
  const scrollMessagesToEndRef = useRef<((options: { animated: boolean }) => void) | null>(null);

  const activeIncident = incidents.find((i) => i.id === activeId) ?? null;
  const activeSessionId = activeIncident?.sessionId ?? null;
  const rawMessages = useMemo((): ChatMessage[] => {
    if (activeId === null) return [];
    return messagesMap[activeId] ?? [];
  }, [activeId, messagesMap]);
  const composerSupportsFiles = selectedModelCapability !== undefined;
  const composerFileAccept = composerSupportsFiles
    ? [
        ".csv", "text/csv", ".txt", "text/plain", ".md", ".markdown",
        "text/markdown", ".json", "application/json", ".yaml", ".yml",
        "text/yaml", "application/yaml",
      ].join(",")
    : "";
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

  const [queueByIncident, setQueueByIncident] = useState<Record<string, SessionQueueState>>({});
  // The composer's whole message: its citations, then the draft.
  const setActiveDraft = (text: string) => {
    if (activeId === null) return;
    useIncidentDraftStore.getState().setComposedDraft(activeId, text);
  };
  const getActiveDraft = () => (activeId === null ? "" : readComposedDraft(activeId));
  const getMessageViewport = () => messageListRef.current?.getScrollableNode() ?? null;
  const {
    composerQueue,
    editingId: queueEditingId,
    saveEdit: saveQueuedEdit,
    resume: resumeQueue,
  } = useComposerQueue({
    agent,
    sessionId: activeSessionId,
    queue: (activeId === null ? undefined : queueByIncident[activeId]) ?? EMPTY_SESSION_QUEUE,
    isRunning: activeIncident?.state === "RUNNING",
    getPrompt: getActiveDraft,
    images: composerImages,
    setPrompt: setActiveDraft,
    setImages: setComposerImages,
  });

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
    setQueueByIncident,
  });

  // A queue saved before the app last quit comes back paused, in a session rebuilt from the thread, when its
  // incident opens. Asked once per incident and app run.
  const restoredQueueIncidentIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (activeId === null || agent.restoreQueue === undefined) return;
    if (isDesktopIncidents && !desktopHydrated) return;
    if (restoredQueueIncidentIdsRef.current.has(activeId)) return;
    restoredQueueIncidentIdsRef.current.add(activeId);
    const incidentId = activeId;
    agent.restoreQueue(incidentId).then((restored) => {
      if (restored === null) return;
      const store = useIncidentListStore.getState();
      const incident = store.incidents.find((item) => item.id === incidentId);
      if (incident === undefined) return;
      if (incident.sessionId !== restored.sessionId) store.patch(incidentId, { sessionId: restored.sessionId });
      applySnapshotToIncident(incidentId, restored.snapshot, restored.snapshot.sequence, true);
    }).catch((error: unknown) => {
      captureIncidentException(error, { operation: "restoreQueue", incidentId });
    });
  }, [activeId, agent, applySnapshotToIncident, desktopHydrated, isDesktopIncidents]);

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

  const handleUnarchiveIncident = (incidentId: string) => {
    useIncidentListStore.getState().unarchive(incidentId);
    void navigate(`/incidents?id=${incidentId}`);
  };

  /** Sets the composer text and attachments, except for a customer report answer, which leaves the engineer's draft. */
  const setComposerUnlessIntake = (incidentId: string, fromIntake: boolean, text: string, images: ComposerAttachment[]) => {
    if (fromIntake) return;
    useIncidentDraftStore.getState().setComposedDraft(incidentId, text);
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
    const draft = activeId === null ? "" : readComposedDraft(activeId);
    const text = intakeText ?? draft.trim();
    const ready = canSendIncidentMessage(text, fromIntake ? 0 : composerImages.length, activeId, selectedProviderKey, selectedModelId);
    // Sending waits for the thread's history so the reply never lands on a thread shown as empty.
    if (!ready || !activeMessagesLoaded || activeId === null || selectedProviderKey === null || activeIncident?.archived === true) return;
    // Jump to the end and follow again, so the new message and its reply show even if the reader had scrolled up.
    scrollMessagesToEndRef.current?.({ animated: false });
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

  /**
   * Queues the message after the running turn, or steers the turn with it. The runtime decides which: a turn that
   * cannot take a steer queues it. Nothing changes in the thread until the runtime's snapshot shows the message.
   */
  const handleSendWhileRunning = async (
    text: string,
    sessionId: string,
    options: { accessLevel?: AccessLevel; interactionMode?: InteractionMode; traitValues?: Record<string, boolean | string>; delivery?: AgentMessageDelivery } | undefined,
  ) => {
    if (activeId === null || selectedProviderKey === null) return;
    const incidentId = activeId;
    const outgoingImages = composerImages;
    const delivery = options?.delivery ?? "queue";
    setComposerUnlessIntake(incidentId, false, "", []);
    const llm: { providerKey: ModelCatalogProviderKey; model: string; thinkingEnabled?: boolean } = {
      providerKey: selectedProviderKey,
      model: selectedModelId,
    };
    if (selectedModelCapability?.supportsThinking === true) {
      llm.thinkingEnabled = thinkingEnabled;
    }
    // Lives outside the try so the React Compiler can lower its conditionals.
    const handleQueueFailure = (err: unknown) => {
      // Nothing was queued: give the engineer their message back.
      setComposerUnlessIntake(incidentId, false, text, outgoingImages);
      captureIncidentException(err, {
        operation: "agent.send",
        source: "handleSendWhileRunning",
        incidentId,
        providerKey: selectedProviderKey,
        modelId: selectedModelId,
        delivery,
      });
    };
    const sendInput = {
      continueSession: true,
      text,
      delivery,
      sessionId,
      attachments: outgoingImages,
      llm,
      incidentThreadId: incidentId,
      accessLevel: options?.accessLevel ?? selectedAccessLevel,
      interactionMode: options?.interactionMode,
      traitValues: options?.traitValues,
    };
    try {
      await sendIncidentAgentMessage(agent, sendInput);
      const snapshot = await agent.getSnapshot(sessionId);
      if (snapshot !== null) applySnapshotToIncident(incidentId, snapshot, snapshot.sequence, true);
    } catch (err: unknown) {
      handleQueueFailure(err);
    }
  };

  /** The composer's send: saves a queued message being edited, queues or steers while the agent runs, else sends. */
  const handleComposerSend = async (options?: Parameters<typeof handleSend>[0] & { delivery?: AgentMessageDelivery }) => {
    const text = getActiveDraft().trim();
    const ready = canSendIncidentMessage(text, composerImages.length, activeId, selectedProviderKey, selectedModelId);
    if (ready && queueEditingId !== null) {
      await saveQueuedEdit(text, composerImages);
      return;
    }
    if (ready && activeIncident?.state === "RUNNING" && activeSessionId !== null && activeIncident.archived !== true) {
      await handleSendWhileRunning(text, activeSessionId, options);
      return;
    }
    await handleSend(options);
  };

  const handleCancel = async () => {
    if (activeSessionId === null) return;
    await agent.cancel(activeSessionId);
  };
  const stopActiveTurn = useTurnStop(activeSessionId, handleCancel);

  const incidentState: AgentSessionState = activeIncident?.state ?? "IDLE";
  const isArchivedIncident = activeIncident?.archived === true;
  const artifactCount = countIncidentArtifacts(messages, activeId);
  const hasWaitingAgentBubble = messages.some(hasWaitingAgentIndicator);
  const visibleIncidents = isHistoryContext
    ? incidents
    : incidents.filter((incident) => incident.archived !== true);

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

  const handleNavigateToSettings = () => {
    let hash = "#coding-agents";
    if (hasManagedDesktopLlmApi()) {
      hash = "#llm-providers";
    }

    void navigate({
      pathname: "/app-settings",
      hash,
    });
  };
  const providerNotice = useProviderNotice(providerConfigsLoaded, handleNavigateToSettings);


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
                "flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-[13px] max-sm:h-11 transition-colors",
                artifactsButtonClassName,
              )}
            >
              <FileText size={14} />
              {t("common.incidents.runbookResults")}
              {artifactCount > 0 && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs">
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
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-[13px] max-sm:h-11 hover:bg-muted transition-colors"
            >
              <X size={14} />
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
            className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border max-sm:size-11 hover:bg-muted transition-colors"
          >
            <History size={14} />
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
              className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border max-sm:size-11 text-muted-foreground hover:bg-muted transition-colors"
            >
              <Upload size={14} />
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
              className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border max-sm:size-11 text-muted-foreground hover:bg-muted transition-colors disabled:opacity-50"
            >
              <Archive size={14} />
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
            className={newIncidentHeaderClass(activeId, visibleIncidents.length)}
            onClick={handleNewIncident}
            disabled={isActiveProcessing}
          >
            <SquarePen size={14} />
            {t("common.incidents.newIncident")}
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
          <div className="bs-page-header flex min-h-[3.25rem] shrink-0 items-center gap-2 border-b border-border px-4 py-2 sm:px-6">
            <span className="flex-1 truncate text-lg font-semibold tracking-[-0.015em] text-foreground">
              {t("common.incidents.allIncidents")}
            </span>
            {topBarActions}
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-6 page-enter">
            {visibleIncidents.length === 0 && (
              <EmptyState
                className="py-20"
                icon={ShieldAlert}
                title={t("common.incidents.emptyTitle")}
                description={t("common.incidents.emptyDescription")}
                action={
                  <Button onClick={handleNewIncident}>
                    <SquarePen />
                    {t("common.incidents.newIncident")}
                  </Button>
                }
              />
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
                          <div className="truncate text-sm font-semibold leading-5 text-foreground">
                            {inc.title}
                          </div>
                          {preview !== null && (
                            <div className="truncate text-[13px] leading-[18px] text-muted-foreground">
                              {translateIncidentPreview(preview, t)}
                            </div>
                          )}
                          <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                            {relativeTime(inc.createdAt, now)}
                          </div>
                        </div>
                        <StatusPill state={inc.state} quiet />
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
                              <Upload size={14} />
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
        {/* Below 640px the title takes the first row, up to two lines, and the status and actions move below it. */}
        <div className="bs-page-header flex min-h-[3.25rem] shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border px-4 py-2 sm:flex-nowrap">
          {activeIncident !== null && (
            <>
              <div data-tour="incidents-title" className="min-w-0 basis-full sm:basis-auto">
                <EditableTitle
                  value={activeIncident.title}
                  disabled={isArchivedIncident}
                  onChange={(title) => {
                    if (isArchivedIncident || activeId === null) return;
                    useIncidentListStore.getState().patch(activeId, { title });
                  }}
                />
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <div className="flex items-center" title={t("common.incidentDetail.incidentStatus")}>
                  <div data-tour="incidents-status">
                    <ResponseStalledBadge messages={rawMessages}>
                      <StatusPill state={incidentState} interrupted={isLastAgentTurnInterrupted(rawMessages)} scoped />
                    </ResponseStalledBadge>
                  </div>
                </div>
              </div>
            </>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {topBarActions}
          </div>
        </div>

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
                      <SquarePen size={14} />
                      {t("common.incidents.newIncident")}
                    </button>
                  </div>
                )}
                <TurnStopContext value={stopActiveTurn}>
                <CustomerReportIntakeChatContext.Provider value={customerReportIntake.chat}>
                  {activeIncident !== null && (
                    <CitationSelectionToolbar
                      getViewport={getMessageViewport}
                      threadId={activeIncident.id}
                      onCite={(citation, anchor) => { addIncidentCitation(activeIncident.id, citation, anchor); }}
                    />
                  )}
                  {activeIncident !== null && (
                    <IncidentMessageList
                      key={activeId}
                      threadId={activeIncident.id}
                      messages={messages}
                      providerKey={selectedProviderKey}
                      listRef={messageListRef}
                      headerClassName={messagesTopSpacerClass}
                      onAtEndChange={(atEnd) => {
                        setScrolledUpIncidentId(atEnd ? null : activeId);
                      }}
                      scrollToEndRef={scrollMessagesToEndRef}
                      onStartReached={() => { loadOlderMessages(activeIncident.id); }}
                    />
                  )}
                </CustomerReportIntakeChatContext.Provider>
                </TurnStopContext>
              </div>

              {activeIncident !== null && isArchivedIncident && (
                <div className="pointer-events-none absolute inset-x-6 top-6 z-10 rounded-lg border border-border bg-background/95 px-4 py-3 text-sm text-muted-foreground shadow-sm backdrop-blur">
                  {t("common.incidents.thisIncidentIsArchivedAnd")}
                </div>
              )}

              {/* Outside the scroll container so it is not clipped; in the corner above the composer, clear of the
                  left-aligned answer controls. */}
              {showScrollIndicator && (
                <button
                  type="button"
                  onClick={() => {
                    scrollMessagesToEndRef.current?.({ animated: true });
                  }}
                  className="absolute bottom-3 right-4 z-10 flex size-9 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-md transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                  aria-label={t("common.incidents.scrollToBottom")}
                >
                  <ArrowDown className="size-4" />
                </button>
              )}
            </div>

            {/* Composer */}
            {activeIncident !== null && (
              <IncidentComposer
                key={activeId}
                incidentId={activeId}
                onSend={(options) => {
                  void handleComposerSend(options);
                }}
                onCancel={() => {
                  void handleCancel();
                }}
                isProcessing={isActiveProcessing}
                isBlocked={isBlocked}
                blockedNotice={providerNotice}
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
                queue={composerQueue}
                onResumeQueue={() => { void resumeQueue(); }}
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
