import { ZodError } from "zod";
import {
  DESKTOP_RPC_CHANNELS,
  type DesktopRpcChannel,
} from "./desktop-ipc-contract";

export interface DesktopIpcError {
  code: string;
  message: string;
  field?: string;
}

export type DesktopIpcHandler = (payload: unknown) => Promise<unknown>;

type RateLimitBucket = { windowStart: number; count: number };
type CoreError = Error & { code: string; field?: string };

interface DesktopIpcLogger {
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface DesktopIpcDispatcherOptions {
  logger: DesktopIpcLogger;
  captureException: (error: unknown, context: Record<string, unknown>) => void;
  validatePayload: (channel: DesktopRpcChannel, payload: unknown) => unknown;
}

export class DesktopIpcDispatchError
  extends Error
  implements DesktopIpcError
{
  readonly code: string;
  readonly field?: string;

  constructor({ code, message, field }: DesktopIpcError) {
    super(message);
    this.name = "IpcDispatchError";
    this.code = code;
    this.field = field;
  }
}

export class DesktopIpcDispatcher {
  private handlers = new Map<string, DesktopIpcHandler>();
  private readonly rateWindowMs = 60_000;
  private readonly maxRequestsPerWindow = 240;
  private readonly rateTracker = new Map<string, RateLimitBucket>();

  constructor(private readonly options: DesktopIpcDispatcherOptions) {}

  register(channel: string, handler: DesktopIpcHandler): void {
    if (this.handlers.has(channel)) {
      this.options.logger.warn(`[ipc] Overwriting handler for channel: ${channel}`);
    }
    this.handlers.set(channel, handler);
    this.options.logger.info(`[ipc] Registered handler: ${channel}`);
  }

  registerAll(handlers: Record<string, DesktopIpcHandler>): void {
    for (const [channel, handler] of Object.entries(handlers)) {
      this.register(channel, handler);
    }
  }

  async dispatch(channel: string, payload: unknown): Promise<unknown> {
    if (!isDesktopRpcChannel(channel)) {
      throw new DesktopIpcDispatchError({
        code: "forbidden",
        message: `Blocked RPC channel: ${channel}`,
      });
    }

    this.assertRateLimit(channel);
    const handler = this.handlers.get(channel);

    if (handler === undefined) {
      throw new DesktopIpcDispatchError({
        code: "not_found",
        message: `No handler registered for channel: ${channel}`,
      });
    }

    try {
      const validatedPayload = this.options.validatePayload(channel, payload);
      return await handler(validatedPayload);
    } catch (error: unknown) {
      throw this.normalizeDispatchError(error, channel, payload);
    }
  }

  getRegisteredChannels(): string[] {
    return Array.from(this.handlers.keys());
  }

  private assertRateLimit(channel: string): void {
    const now = Date.now();
    const bucket = this.rateTracker.get(channel);
    if (bucket === undefined || now - bucket.windowStart >= this.rateWindowMs) {
      this.rateTracker.set(channel, { windowStart: now, count: 1 });
      return;
    }

    bucket.count += 1;
    if (bucket.count > this.maxRequestsPerWindow) {
      throw new DesktopIpcDispatchError({
        code: "rate_limited",
        message: `Too many requests for channel: ${channel}`,
      });
    }
  }

  private normalizeDispatchError(
    error: unknown,
    channel: string,
    payload: unknown,
  ): Error {
    const knownError = normalizeKnownDispatchError(error);
    if (knownError !== null) {
      return knownError;
    }

    this.options.logger.error(`[ipc] Unhandled error on channel ${channel}:`, error);
    this.options.captureException(error, {
      channel,
      ...summarizePayloadForTelemetry(payload),
    });

    return new DesktopIpcDispatchError({
      code: "internal_error",
      message: getErrorMessage(error),
    });
  }
}

function normalizeKnownDispatchError(error: unknown): Error | null {
  if (error instanceof ZodError) {
    return createValidationError(error);
  }

  if (error instanceof DesktopIpcDispatchError) {
    return error;
  }

  if (isIpcError(error)) {
    return new DesktopIpcDispatchError(error);
  }

  if (isCoreError(error)) {
    return new DesktopIpcDispatchError({
      code: error.code.toLowerCase(),
      message: error.message,
      field: error.field,
    });
  }

  return null;
}

function createValidationError(error: ZodError): DesktopIpcDispatchError {
  return new DesktopIpcDispatchError({
    code: "validation_error",
    message: error.issues[0]?.message ?? "Invalid IPC payload",
    field: error.issues[0]?.path?.join("."),
  });
}

function isDesktopRpcChannel(channel: string): channel is DesktopRpcChannel {
  return DESKTOP_RPC_CHANNELS.some((knownChannel) => knownChannel === channel);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIpcError(error: unknown): error is DesktopIpcError {
  if (!isRecord(error)) return false;

  return typeof error.code === "string" && typeof error.message === "string";
}

function isCoreError(error: unknown): error is CoreError {
  if (!(error instanceof Error)) return false;
  if (!isRecord(error)) return false;

  return typeof error.code === "string";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}

const SENSITIVE_KEY_TERMS = [
  "password", "secret", "token", "apikey", "authorization", "cookie",
  "credential", "privatekey", "prompt", "content", "body", "text",
  "code", "script", "command", "stdout", "stderr", "input", "output",
];
const SAFE_SCALAR_KEY_NAMES = new Set([
  "id", "type", "mode", "format", "provider", "method", "status",
  "source", "enabled", "success", "count", "path", "name",
]);
const SAFE_SCALAR_KEY_SUFFIXES = ["Id", "Type", "Mode", "Format", "Provider", "Method", "Status", "Source", "Enabled", "Success", "Count", "Path", "Name"];

function isSensitiveTelemetryKey(key: string): boolean {
  const normalizedKey = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
  return SENSITIVE_KEY_TERMS.some((term) => normalizedKey.includes(term));
}

function isSafeTelemetryScalarKey(key: string): boolean {
  return SAFE_SCALAR_KEY_NAMES.has(key.toLowerCase()) ||
    SAFE_SCALAR_KEY_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

function summarizePayloadForTelemetry(payload: unknown): Record<string, unknown> {
  if (payload === null || payload === undefined) {
    return {};
  }

  if (Array.isArray(payload)) {
    return {
      payload_kind: "array",
      payload_count: payload.length,
    };
  }

  if (!isRecord(payload)) {
    return {
      payload_kind: typeof payload,
    };
  }

  const keys = Object.keys(payload);
  const summary: Record<string, unknown> = {
    payload_kind: "object",
    payload_key_count: keys.length,
  };

  for (const [key, value] of Object.entries(payload)) {
    const entry = summarizeTelemetryEntry(key, value);
    if (entry !== null) {
      summary[entry.key] = entry.value;
    }
  }

  return summary;
}

function summarizeTelemetryEntry(
  key: string,
  value: unknown,
): { key: string; value: unknown } | null {
  if (isSensitiveTelemetryKey(key)) return null;

  const telemetryKey = toTelemetryKey(key);
  if (typeof value === "boolean") {
    return { key: `payload_${telemetryKey}`, value };
  }

  if (Array.isArray(value)) {
    return { key: `payload_${telemetryKey}_count`, value: value.length };
  }

  if (!isSafeTelemetryScalarKey(key)) return null;

  if (typeof value === "number") {
    return { key: `payload_${telemetryKey}`, value };
  }

  if (typeof value === "string") {
    return { key: `payload_${telemetryKey}`, value: value.slice(0, 80) };
  }

  return null;
}

function toTelemetryKey(value: string): string {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();
  return trimCharacter(normalized, "_");
}

function trimCharacter(value: string, character: string): string {
  let start = 0;
  let end = value.length;
  while (value[start] === character) start += 1;
  while (end > start && value[end - 1] === character) end -= 1;
  return value.slice(start, end);
}
