import type {
  DesktopPluginExecutionRequest,
  DesktopPluginFieldType,
  DesktopPluginInstallFromArtifactRequest,
} from "./plugins.types";
import {
  NOOP_DESKTOP_PLUGIN_STORED_AUTH_STORE,
  type DesktopPluginStoredAuthRecord,
  type DesktopPluginStoredAuthValue,
  type DesktopPluginStoredAuthStore,
} from "./desktop-plugin-auth-store";
import { createDesktopNodePluginRuntimeService } from "./desktop-plugin-runtime.node";

function asPayloadRecord(payload: unknown): Record<string, unknown> {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }

  return {};
}

function readRequiredPluginId(payload: unknown): string {
  const pluginId = asPayloadRecord(payload).pluginId;
  if (typeof pluginId !== "string") {
    throw new Error("pluginId is required");
  }

  const normalized = pluginId.trim();
  if (normalized.length === 0) {
    throw new Error("pluginId is required");
  }

  return normalized;
}

function readAuthRecord(payload: unknown): Record<string, unknown> {
  const auth = asPayloadRecord(payload).auth;
  if (auth !== null && typeof auth === "object" && !Array.isArray(auth)) {
    return auth as Record<string, unknown>;
  }

  return {};
}

function normalizeStringAuthValue(
  value: unknown,
): DesktopPluginStoredAuthValue | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  return value;
}

function normalizeNumberAuthValue(
  value: unknown,
): DesktopPluginStoredAuthValue | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  return undefined;
}

function normalizeBooleanAuthValue(
  value: unknown,
): DesktopPluginStoredAuthValue | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return undefined;
}

function normalizeStringArrayItems(items: string[]): string[] | undefined {
  if (items.length === 0) {
    return undefined;
  }

  return items;
}

function normalizeStringArrayAuthValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return normalizeStringArrayItems(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    );
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  return normalizeStringArrayItems(
    value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
}

function normalizeJsonAuthValue(
  value: unknown,
): DesktopPluginStoredAuthValue | undefined {
  try {
    return JSON.parse(JSON.stringify(value)) as DesktopPluginStoredAuthValue;
  } catch {
    return undefined;
  }
}

function normalizeStoredAuthValue(
  fieldType: DesktopPluginFieldType,
  value: unknown,
): DesktopPluginStoredAuthValue | undefined {
  switch (fieldType) {
    case "string":
      return normalizeStringAuthValue(value);
    case "number":
      return normalizeNumberAuthValue(value);
    case "boolean":
      return normalizeBooleanAuthValue(value);
    case "string_array":
      return normalizeStringArrayAuthValue(value);
    case "json":
      return normalizeJsonAuthValue(value);
  }
}

export function createDesktopPluginHandlers(
  service = createDesktopNodePluginRuntimeService(),
  storedAuthStore: DesktopPluginStoredAuthStore = NOOP_DESKTOP_PLUGIN_STORED_AUTH_STORE,
): Record<string, (payload: unknown) => Promise<unknown>> {
  return {
    "plugins:list": () => Promise.resolve({
      data: service.listPlugins(),
    }),
    "plugins:get": (payload) => {
      const pluginId = readRequiredPluginId(payload);

      return Promise.resolve(service.getPlugin(pluginId));
    },
    "plugins:getStoredAuth": (payload) => {
      const pluginId = readRequiredPluginId(payload);

      if (service.getPlugin(pluginId) === null) {
        throw new Error(`Unknown plugin: ${pluginId}`);
      }

      return storedAuthStore.get(pluginId);
    },
    "plugins:updateStoredAuth": (payload) => {
      const pluginId = readRequiredPluginId(payload);

      const plugin = service.getPlugin(pluginId);
      if (plugin === null) {
        throw new Error(`Unknown plugin: ${pluginId}`);
      }

      const auth = readAuthRecord(payload);
      const allowedKeys = new Set(plugin.auth.fields.map((field) => field.key));
      const normalized: DesktopPluginStoredAuthRecord = {};
      for (const [key, value] of Object.entries(auth)) {
        if (!allowedKeys.has(key)) {
          continue;
        }

        const field = plugin.auth.fields.find((entry) => entry.key === key);
        if (field === undefined) {
          continue;
        }

        const normalizedValue = normalizeStoredAuthValue(field.type, value);
        if (normalizedValue !== undefined) {
          normalized[key] = normalizedValue;
        }
      }

      return storedAuthStore.set(pluginId, normalized);
    },
    "plugins:clearStoredAuth": async (payload) => {
      const pluginId = readRequiredPluginId(payload);

      await storedAuthStore.clear(pluginId);
      return { success: true };
    },
    "plugins:installFromArtifact": (payload) =>
      service.installFromArtifact(
        payload as DesktopPluginInstallFromArtifactRequest,
      ),
    "plugins:execute": (payload) =>
      service.executeAction(payload as DesktopPluginExecutionRequest),
  };
}
