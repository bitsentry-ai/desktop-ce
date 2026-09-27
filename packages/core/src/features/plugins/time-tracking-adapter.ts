import { z } from "zod";

export const timerActionSchema = z.enum(["read", "start", "pause", "resume", "stop", "add_entry"]);
export const timerRequestSchema = z.object({ connectionId: z.uuid(), ticketId: z.string().min(1).max(200), action: timerActionSchema, fields: z.record(z.string(), z.unknown()).default({}) }).strict();
export type TimerRequest = z.infer<typeof timerRequestSchema>;
export const timerCapabilitiesSchema = z.object({
  connectionId: z.uuid(), adapterId: z.string().optional(),
  availability: z.enum(["configured", "not_connected", "unavailable"]),
  actions: z.array(timerActionSchema),
  remoteIdempotency: z.enum(["supported", "unsupported", "unknown"]),
});
export type TimerCapabilities = z.infer<typeof timerCapabilitiesSchema>;
export const timerResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("succeeded"), remoteId: z.string().min(1), state: z.enum(["running", "paused", "stopped", "not_running", "unknown"]), elapsedSeconds: z.number().finite().nonnegative().optional(), observedAt: z.iso.datetime(), remoteResult: z.unknown() }).strict(),
  z.object({ outcome: z.enum(["rejected", "uncertain", "unavailable"]), message: z.string().min(1), remoteId: z.string().optional() }).strict(),
]);
export type TimerResult = z.infer<typeof timerResultSchema>;
export type TimerPreparation =
  | { kind: "clarification"; requiredFields: string[]; message: string }
  | { kind: "preview"; target: string; content: Record<string, unknown>; summary: string };
export interface TimerExecutionContext {
  /** Durable application operation identity; the adapter must not invent a new retry identity. */
  operationId: string;
  idempotencyKey: string;
  signal: AbortSignal;
  deadlineAt: number;
}
/** Runtime-owned adapter. Credentials stay inside the implementation, never in requests or capabilities. */
export interface TimeTrackingAdapter {
  readonly id: string;
  capabilities(connectionId: string): Promise<TimerCapabilities>;
  read(request: TimerRequest & { action: "read" }, context: Pick<TimerExecutionContext, "signal" | "deadlineAt">): Promise<TimerResult>;
  prepare(request: TimerRequest): Promise<TimerPreparation>;
  /** Called only by the application after durable approval of the exact prepared request. */
  executeApproved(request: TimerRequest, context: TimerExecutionContext): Promise<TimerResult>;
}
/** Instantiate independently in Desktop and Dashboard; there is no shared/global runtime registry. */
export class TimeTrackingAdapterRegistry {
  private readonly adapters = new Map<string, TimeTrackingAdapter>();
  register(connectionId: string, adapter: TimeTrackingAdapter): void {
    z.uuid().parse(connectionId);
    if (this.adapters.has(connectionId)) throw new Error("A timer adapter is already registered for this connection.");
    this.adapters.set(connectionId, adapter);
  }
  async capabilities(connectionId: string): Promise<TimerCapabilities> {
    const adapter = this.adapters.get(connectionId);
    if (!adapter) return { connectionId, availability: "not_connected", actions: [], remoteIdempotency: "unknown" };
    const result = timerCapabilitiesSchema.parse(await adapter.capabilities(connectionId));
    if (result.connectionId !== connectionId || result.adapterId !== adapter.id) throw new Error("Timer adapter returned a mismatched connection identity.");
    return result;
  }
  /** Host-only lookup; no chat tool exposes executeApproved before a custom implementation is connected. */
  resolve(connectionId: string): TimeTrackingAdapter | undefined { return this.adapters.get(connectionId); }
}
