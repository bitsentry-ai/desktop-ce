import { z } from "zod";
import { isIanaTimeZone, zonedLocalToIso } from "./customer-reports";

const attribute = z.string().regex(/^[A-Za-z]\w*$/).max(100);
const stateName = z.string().trim().min(1).max(100);
const MAX_TARGET_MINUTES = 43_200;

/**
 * One deadline: it starts at a ticket timestamp and is met at another timestamp or once the ticket reaches a state.
 * Targets are minutes per priority value as iTop stores it. A priority without a target has no deadline; nothing is guessed.
 */
const deadlineLevelSchema = z.object({
  startField: attribute,
  metField: attribute.optional(),
  metStates: z.array(stateName).max(50).default([]),
  targets: z.record(z.string().trim().min(1).max(50), z.number().int().min(1).max(MAX_TARGET_MINUTES)),
}).strict().refine((level) => level.metField !== undefined || level.metStates.length > 0, { message: "Set metField or metStates" });

/** L1 response and L2 acknowledgement deadlines of a connection. Only calendar time is counted. */
export const ticketDeadlinesSchema = z.object({
  /** The iTop server zone: iTop returns its timestamps as local wall-clock time without an offset. */
  timeZone: z.string().refine(isIanaTimeZone, { message: "Unknown IANA time zone" }),
  priorityField: attribute.default("priority"),
  l1: deadlineLevelSchema,
  l2: deadlineLevelSchema,
}).strict();
export type TicketDeadlines = z.infer<typeof ticketDeadlinesSchema>;
export const DEADLINE_LEVELS = ["l1", "l2"] as const;
export type DeadlineLevel = (typeof DEADLINE_LEVELS)[number];

/** What a ticket read records for one deadline. The status is worked out again whenever it is shown. */
const observedLevelSchema = z.object({
  target: z.number().nullable(),
  startedAt: z.string().nullable(),
  dueAt: z.string().nullable(),
  metAt: z.string().nullable(),
  met: z.boolean(),
});
const observedDeadlinesSchema = z.object({ priority: z.string().nullable(), l1: observedLevelSchema, l2: observedLevelSchema });
export type ObservedTicketDeadlines = z.infer<typeof observedDeadlinesSchema>;

/** An iTop timestamp (`2026-10-15 09:12:30`, server wall-clock time) as an ISO instant, or null when it is not set. */
export function itopTimestampToIso(value: unknown, timeZone: string): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (match === null || match[1] === "0000-00-00") return null;
  const minute = zonedLocalToIso(`${match[1]}T${match[2]}`, timeZone);
  if (minute === null) return null;
  return new Date(Date.parse(minute) + Number(match[3] ?? 0) * 1000).toISOString();
}

function scalar(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

/** Records the deadlines of a ticket from the fields iTop returned. */
export function observeTicketDeadlines(fields: Record<string, unknown>, status: string, config: TicketDeadlines): ObservedTicketDeadlines {
  const priority = scalar(fields[config.priorityField]) || null;
  const level = (key: DeadlineLevel) => {
    const rule = config[key];
    const startedAt = itopTimestampToIso(fields[rule.startField], config.timeZone);
    const metAt = rule.metField === undefined ? null : itopTimestampToIso(fields[rule.metField], config.timeZone);
    const target = priority === null ? null : rule.targets[priority] ?? null;
    const dueAt = startedAt === null || target === null ? null : new Date(Date.parse(startedAt) + target * 60_000).toISOString();
    return { target, startedAt, dueAt, metAt, met: metAt !== null || rule.metStates.includes(status) };
  };
  return { priority, l1: level("l1"), l2: level("l2") };
}

export type DeadlineStatus =
  | { kind: "not_started" }
  | { kind: "no_target"; priority: string | null }
  | { kind: "met"; dueAt: string | null; metAt: string | null; late: boolean }
  | { kind: "pending"; dueAt: string; minutes: number }
  | { kind: "overdue"; dueAt: string; minutes: number };

function levelStatus(level: ObservedTicketDeadlines["l1"], priority: string | null, now: number): DeadlineStatus {
  if (level.met) {
    const late = level.dueAt !== null && level.metAt !== null && Date.parse(level.metAt) > Date.parse(level.dueAt);
    return { kind: "met", dueAt: level.dueAt, metAt: level.metAt, late };
  }
  if (level.startedAt === null) return { kind: "not_started" };
  if (level.dueAt === null) return { kind: "no_target", priority };
  // Time left rounds up and time overdue rounds down, so neither claims a minute that has not passed.
  const left = Date.parse(level.dueAt) - now;
  return left >= 0
    ? { kind: "pending", dueAt: level.dueAt, minutes: Math.ceil(left / 60_000) }
    : { kind: "overdue", dueAt: level.dueAt, minutes: Math.max(1, Math.floor(-left / 60_000)) };
}

/** Where a ticket stands against its deadlines now, or null when its connection tracks no deadlines. */
export function ticketDeadlineStatus(state: Record<string, unknown>, now: number = Date.now()): { priority: string | null; l1: DeadlineStatus; l2: DeadlineStatus } | null {
  const parsed = observedDeadlinesSchema.safeParse(state.deadlines);
  if (!parsed.success) return null;
  const { priority, l1, l2 } = parsed.data;
  return { priority, l1: levelStatus(l1, priority, now), l2: levelStatus(l2, priority, now) };
}

/** A deadline the engineer has to act on: its clock runs and it is not met yet. */
export const needsAction = (status: DeadlineStatus) => status.kind === "pending" || status.kind === "overdue";
