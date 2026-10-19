import * as Sentry from "@sentry/react";
import { getDesktopApi } from "../../services/desktop-api";
import type { AgentSessionState, ChatMessage } from "../../chat/types";
import {
  asRecord,
  getString,
  normalizeIncidentMessagesMap,
  normalizeIncidents,
} from "./incidentNormalize";
import { loadIncidentMessages, loadIncidents } from "./incidentStorage";
import type { DesktopIpcError, IncidentThread } from "./types";

export function hasDesktopIncidentsApi(): boolean {
  if (typeof window === "undefined") return false;
  return getDesktopApi()?.incidents !== undefined;
}

export function hasDesktopLlmApi(): boolean {
  if (typeof window === "undefined") return false;
  return getDesktopApi()?.llm?.getProviders !== undefined;
}

export function hasManagedDesktopLlmApi(): boolean {
  if (typeof window === "undefined") return false;
  return typeof getDesktopApi()?.llm?.ping === "function";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

export function isMissingIncidentsHandlerError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes("No handler registered for 'incidents:getState'") ||
    message.includes("No handler registered for 'incidents:replaceState'")
  );
}

export function isMissingAgentSessionError(error: unknown): boolean {
  const record = asRecord(error);
  if (record !== null) {
    const ipcError: DesktopIpcError = {
      code: getString(record, "code"),
      message: getString(record, "message"),
    };
    if (
      ipcError.code === "not_found" &&
      typeof ipcError.message === "string" &&
      ipcError.message.includes("Session not found:")
    ) {
      return true;
    }
  }

  const message = errorMessage(error);
  return message.includes("Session not found:");
}

export function getRecoveredIncidentState(
  state: AgentSessionState,
): AgentSessionState {
  if (state === "RUNNING") return "FAILED";
  return state;
}

export function captureIncidentException(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  try {
    if (context === undefined) {
      Sentry.captureException(error);
    } else {
      Sentry.captureException(error, { extra: context });
    }
  } catch {}
}

export async function loadDesktopIncidentState(): Promise<{
  incidents: IncidentThread[];
  messagesMap: Record<string, ChatMessage[]>;
}> {
  const incidentsApi = getDesktopApi()?.incidents;
  if (incidentsApi === undefined) {
    return {
      incidents: loadIncidents(),
      messagesMap: loadIncidentMessages(),
    };
  }

  const snapshot = await incidentsApi.getState();
  const incidents = normalizeIncidents(snapshot.incidents);
  const messagesMap = normalizeIncidentMessagesMap(snapshot.incidentMessages);

  if (incidents.length > 0 || Object.keys(messagesMap).length > 0) {
    return { incidents, messagesMap };
  }

  return {
    incidents: loadIncidents(),
    messagesMap: loadIncidentMessages(),
  };
}

export async function saveDesktopIncidentState(
  incidents: IncidentThread[],
  messagesMap: Record<string, ChatMessage[]>,
): Promise<void> {
  const incidentsApi = getDesktopApi()?.incidents;
  if (incidentsApi === undefined) return;

  await incidentsApi.replaceState({
    incidents,
    incidentMessages: messagesMap,
  });
}
