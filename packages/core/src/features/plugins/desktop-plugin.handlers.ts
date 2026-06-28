import type {
  DesktopPluginExecutionRequest,
} from "./plugins.types";
import {
  NOOP_DESKTOP_PLUGIN_STORED_AUTH_STORE,
  type DesktopPluginStoredAuthRecord,
  type DesktopPluginStoredAuthValue,
  type DesktopPluginStoredAuthStore,
} from "./desktop-plugin-auth-store";
import { type DesktopPluginRuntimeService } from "./desktop-plugin-registry";
import { createDesktopNodePluginRuntimeService } from "./desktop-plugin-runtime.node";

function normalizeStoredAuthValue(
  fieldType: "string" | "number" | "boolean" | "json" | "string_array",
  value: unknown,
): DesktopPluginStoredAuthValue | undefined {
  if (fieldType === "string") {
    if (typeof value !== "string" || value.trim().length === 0) {
      return undefined;
    }

    return value;
  }

  if (fieldType === "number") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return numeric;
      }
    }
    return undefined;
  }

  if (fieldType === "boolean") {
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

  if (fieldType === "string_array") {
    if (Array.isArray(value)) {
      const items = value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      return items.length > 0 ? items : undefined;
    }

    if (typeof value === "string" && value.trim().length > 0) {
      const items = value
        .split(/\r?\n|,/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      return items.length > 0 ? items : undefined;
    }

    return undefined;
  }

  try {
    return JSON.parse(JSON.stringify(value)) as DesktopPluginStoredAuthValue;
  } catch {
    return undefined;
  }
}

export function createDesktopPluginHandlers(
  service = createDesktopNodePluginRuntimeService(),
  storedAuthStore: DesktopPluginStoredAuthStore = NOOP_DESKTOP_PLUGIN_STORED_AUTH_STORE,
): Record<string, (payload: unknown) => Promise<unknown>> {
  return {
    "plugins:list": async () => ({
      data: service.listPlugins(),
    }),
    "plugins:get": async (payload) => {
      const pluginId =
        payload !== null &&
        typeof payload === "object" &&
        "pluginId" in payload &&
        typeof (payload as { pluginId?: unknown }).pluginId === "string"
          ? (payload as { pluginId: string }).pluginId
          : "";

      if (pluginId.trim().length === 0) {
        throw new Error("pluginId is required");
      }

      return service.getPlugin(pluginId.trim());
    },
    "plugins:getStoredAuth": async (payload) => {
      const pluginId =
        payload !== null &&
        typeof payload === "object" &&
        "pluginId" in payload &&
        typeof (payload as { pluginId?: unknown }).pluginId === "string"
          ? (payload as { pluginId: string }).pluginId
          : "";

      if (pluginId.trim().length === 0) {
        throw new Error("pluginId is required");
      }

      if (service.getPlugin(pluginId.trim()) === null) {
        throw new Error(`Unknown plugin: ${pluginId.trim()}`);
      }

      return storedAuthStore.get(pluginId.trim());
    },
    "plugins:updateStoredAuth": async (payload) => {
      const pluginId =
        payload !== null &&
        typeof payload === "object" &&
        "pluginId" in payload &&
        typeof (payload as { pluginId?: unknown }).pluginId === "string"
          ? (payload as { pluginId: string }).pluginId
          : "";

      if (pluginId.trim().length === 0) {
        throw new Error("pluginId is required");
      }

      const plugin = service.getPlugin(pluginId.trim());
      if (plugin === null) {
        throw new Error(`Unknown plugin: ${pluginId.trim()}`);
      }

      const auth =
        payload !== null &&
        typeof payload === "object" &&
        "auth" in payload &&
        (payload as { auth?: unknown }).auth !== null &&
        typeof (payload as { auth?: unknown }).auth === "object"
          ? (payload as { auth: Record<string, unknown> }).auth
          : {};

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

      return storedAuthStore.set(pluginId.trim(), normalized);
    },
    "plugins:clearStoredAuth": async (payload) => {
      const pluginId =
        payload !== null &&
        typeof payload === "object" &&
        "pluginId" in payload &&
        typeof (payload as { pluginId?: unknown }).pluginId === "string"
          ? (payload as { pluginId: string }).pluginId
          : "";

      if (pluginId.trim().length === 0) {
        throw new Error("pluginId is required");
      }

      await storedAuthStore.clear(pluginId.trim());
      return { success: true };
    },
    "plugins:execute": async (payload) =>
      service.executeAction(payload as DesktopPluginExecutionRequest),
  };
}
