import * as Sentry from "@sentry/react";
import { getDesktopApi } from "../../services/desktop-api";
import type { AgentSessionState, ChatMessage } from "../../chat/types";
import {
  asRecord,
  getString,
  normalizeIncidentMessagesMap,
  normalizeIncidents,
} from "./incidentNormalize";
import { loadIncidents } from "./incidentStorage";
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
    message.includes("No handler registered for 'incidents:list'") ||
    message.includes("No handler registered for 'incidents:saveThread'")
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

export async function loadDesktopIncidents(): Promise<IncidentThread[]> {
  const incidentsApi = getDesktopApi()?.incidents;
  if (incidentsApi === undefined) return loadIncidents();
  return normalizeIncidents(await incidentsApi.list());
}

export async function loadDesktopIncidentMessages(threadId: string): Promise<ChatMessage[]> {
  const incidentsApi = getDesktopApi()?.incidents;
  if (incidentsApi === undefined) return [];
  const messages = await incidentsApi.getThreadMessages(threadId);
  return normalizeIncidentMessagesMap({ [threadId]: messages })[threadId] ?? [];
}

/** Saves only the fields in `patch`; `archivedAt: null` unarchives. */
export async function saveDesktopIncidentThread(patch: { id: string } & Record<string, unknown>): Promise<void> {
  await getDesktopApi()?.incidents?.saveThread(patch);
}

export async function appendDesktopIncidentMessages(threadId: string, messages: ChatMessage[]): Promise<void> {
  await getDesktopApi()?.incidents?.appendThreadMessages(threadId, messages);
}
