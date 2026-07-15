import { randomUUID } from "crypto";
import type {
  CreateErrorSourceInput,
  ErrorSource,
  SyncStatus,
  UpdateErrorSourceInput,
} from "./desktop-error-sources.types";
import {
  errorSourceTypeSchema,
  logLevelThresholdSchema,
  syncStatusSchema,
} from "./desktop-error-sources.types";
import {
  jsonRecordSchema,
  nullableJsonRecordSchema,
  parseSqliteJson,
  sqliteBoolean,
  sqliteEnum,
  sqliteIso,
  sqliteJsonText,
  sqliteNullableEnum,
  sqliteNullableText,
  sqliteNullableValue,
  sqliteText,
  stringArraySchema,
  type SqliteRow,
} from "./desktop-sqlite-row";

export interface ErrorSourceDatabase {
  errorSource: {
    create(args: { data: Record<string, unknown> }): Promise<SqliteRow>;
    delete(args: { where: { id: string } }): Promise<unknown>;
    findMany(args?: Record<string, unknown>): Promise<SqliteRow[]>;
    findUnique(args: { where: { id: string } }): Promise<SqliteRow | null>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<SqliteRow>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
}

export class SqliteErrorSourcesRepositoryAdapter {
  constructor(private readonly db: ErrorSourceDatabase) {}

  async create(input: CreateErrorSourceInput): Promise<ErrorSource> {
    const row = await this.db.errorSource.create({
      data: this.toCreateData(input),
    });
    return this.toDomain(row);
  }

  async findById(id: string): Promise<ErrorSource | null> {
    const row = await this.db.errorSource.findUnique({ where: { id } });
    if (row === null) {
      return null;
    }

    return this.toDomain(row);
  }

  async findMany(): Promise<ErrorSource[]> {
    const rows = await this.db.errorSource.findMany({
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => this.toDomain(row));
  }

  async findSyncEnabled(): Promise<ErrorSource[]> {
    const rows = await this.db.errorSource.findMany({
      where: { syncEnabled: true },
      orderBy: { updatedAt: "asc" },
    });
    return rows.map((row) => this.toDomain(row));
  }

  async update(input: UpdateErrorSourceInput): Promise<ErrorSource | null> {
    const { id, ...changes } = input;

    const data = this.toUpdateData(changes);

    try {
      const row = await this.db.errorSource.update({
        where: { id },
        data,
      });
      return this.toDomain(row);
    } catch {
      return null;
    }
  }

  async updateSyncStatus(
    id: string,
    status: SyncStatus,
    error?: string | null,
  ): Promise<void> {
    await this.db.errorSource.update({
      where: { id },
      data: {
        lastSyncStatus: status,
        lastSyncError: error ?? null,
        lastSyncAt: this.getLastSyncAt(status),
      },
    });
  }

  async markInterruptedSyncsFailed(message: string): Promise<number> {
    const result = await this.db.errorSource.updateMany({
      where: { lastSyncStatus: "in_progress" },
      data: {
        lastSyncStatus: "failed",
        lastSyncError: message,
      },
    });
    return result.count;
  }

  async remove(id: string): Promise<void> {
    await this.db.errorSource.delete({ where: { id } });
  }

  private toCreateData(input: CreateErrorSourceInput): Record<string, unknown> {
    return {
      id: randomUUID(),
      sourceType: input.sourceType,
      name: input.name,
      accessTokenRef: sqliteNullableValue(input.accessTokenRef),
      refreshTokenRef: sqliteNullableValue(input.refreshTokenRef),
      expiresAt: sqliteNullableValue(input.expiresAt),
      grantedScopes: JSON.stringify(input.grantedScopes ?? []),
      configuration: JSON.stringify(input.configuration ?? {}),
      logLevelThreshold: input.logLevelThreshold ?? "error",
      additionalMetadata: sqliteJsonText(input.additionalMetadata),
      syncEnabled: input.syncEnabled ?? true,
      autoDiagnosisEnabled: input.autoDiagnosisEnabled ?? false,
    };
  }

  private toUpdateData(
    changes: Omit<UpdateErrorSourceInput, "id">,
  ): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    this.addDefinedUpdateValue(data, "name", changes.name);
    this.addDefinedUpdateValue(data, "accessTokenRef", changes.accessTokenRef);
    this.addDefinedUpdateValue(
      data,
      "refreshTokenRef",
      changes.refreshTokenRef,
    );
    this.addDefinedUpdateValue(data, "expiresAt", changes.expiresAt);
    if (changes.grantedScopes !== undefined) {
      data.grantedScopes = JSON.stringify(changes.grantedScopes);
    }
    if (changes.configuration !== undefined) {
      data.configuration = JSON.stringify(changes.configuration);
    }
    if (changes.logLevelThreshold !== undefined) {
      data.logLevelThreshold = changes.logLevelThreshold;
    }
    if (changes.additionalMetadata !== undefined) {
      data.additionalMetadata = sqliteJsonText(changes.additionalMetadata);
    }
    this.addDefinedUpdateValue(data, "syncEnabled", changes.syncEnabled);
    if (changes.autoDiagnosisEnabled !== undefined) {
      data.autoDiagnosisEnabled = changes.autoDiagnosisEnabled;
    }
    this.addDefinedUpdateValue(data, "lastSyncAt", changes.lastSyncAt);
    this.addDefinedUpdateValue(data, "lastSyncStatus", changes.lastSyncStatus);
    this.addDefinedUpdateValue(data, "lastSyncError", changes.lastSyncError);

    return data;
  }

  private addDefinedUpdateValue(
    data: Record<string, unknown>,
    key: string,
    value: unknown,
  ): void {
    if (value === undefined) {
      return;
    }

    data[key] = value;
  }

  private getLastSyncAt(status: SyncStatus): string | undefined {
    if (status === "success") {
      return new Date().toISOString();
    }

    return undefined;
  }

  private toDomain(row: SqliteRow): ErrorSource {
    return {
      id: sqliteText(row.id),
      sourceType: sqliteEnum(row.sourceType, errorSourceTypeSchema, "unknown"),
      name: sqliteText(row.name),
      accessTokenRef: sqliteNullableText(row.accessTokenRef),
      refreshTokenRef: sqliteNullableText(row.refreshTokenRef),
      expiresAt: this.toOptionalIso(row.expiresAt),
      grantedScopes: parseSqliteJson(row.grantedScopes, stringArraySchema, []),
      configuration: parseSqliteJson(row.configuration, jsonRecordSchema, {}),
      logLevelThreshold: sqliteEnum(
        row.logLevelThreshold,
        logLevelThresholdSchema,
        "error",
      ),
      additionalMetadata: parseSqliteJson(
        row.additionalMetadata,
        nullableJsonRecordSchema,
        null,
      ),
      syncEnabled: sqliteBoolean(row.syncEnabled),
      autoDiagnosisEnabled: sqliteBoolean(row.autoDiagnosisEnabled),
      lastSyncAt: this.toOptionalIso(row.lastSyncAt),
      lastSyncStatus: sqliteNullableEnum(row.lastSyncStatus, syncStatusSchema),
      lastSyncError: sqliteNullableText(row.lastSyncError),
      createdAt: sqliteIso(row.createdAt),
      updatedAt: sqliteIso(row.updatedAt),
    };
  }

  private toOptionalIso(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }

    return sqliteIso(value);
  }
}
