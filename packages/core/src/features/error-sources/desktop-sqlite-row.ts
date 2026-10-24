import { z } from "zod";

export type SqliteRow = Record<string, unknown>;

export const jsonRecordSchema = z.record(z.string(), z.unknown());
export const nullableJsonRecordSchema = jsonRecordSchema.nullable();
const jsonRecordArraySchema = z.array(jsonRecordSchema);
export const nullableJsonRecordArraySchema = jsonRecordArraySchema.nullable();
export const stringArraySchema = z.array(z.string());

function sqliteJsonValueText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return JSON.stringify(value);
}

export function sqliteJsonText(
  value: Record<string, unknown> | null | undefined,
): string | null {
  return sqliteJsonValueText(value);
}

export function sqliteJsonArrayText(
  value: Array<Record<string, unknown>> | null | undefined,
): string | null {
  return sqliteJsonValueText(value);
}

export function sqliteIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value !== "string" && typeof value !== "number") {
    return new Date(0).toISOString();
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return new Date(0).toISOString();
}

export function sqliteText(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return fallback;
}

export function sqliteNullableText(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return null;
}

export function sqliteNullableValue<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

export function sqliteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

export function sqliteNullableNumber(value: unknown): number | null {
  if (value == null) {
    return null;
  }

  return sqliteNumber(value);
}

export function sqliteBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

export function sqliteNullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }

  return sqliteBoolean(value);
}

export function sqliteEnum<T extends string>(
  value: unknown,
  schema: z.ZodType<T>,
  fallback: T,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  return fallback;
}

export function sqliteNullableEnum<T extends string>(
  value: unknown,
  schema: z.ZodType<T>,
): T | null {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  return null;
}

export function parseSqliteJson<T>(
  value: unknown,
  schema: z.ZodType<T>,
  fallback: T,
): T {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }

  try {
    const parsedJson: unknown = JSON.parse(value);
    const parsed = schema.safeParse(parsedJson);
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    return fallback;
  }

  return fallback;
}
