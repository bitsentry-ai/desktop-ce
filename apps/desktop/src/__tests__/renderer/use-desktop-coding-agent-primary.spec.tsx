// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useDesktopPrimaryAgentSelection,
  withPrimarySavedProvider,
} from "@bitsentry-ce/components/desktop/useDesktopCodingAgentPrimary";
import * as desktopApiModule from "@bitsentry-ce/components/services/desktop-api";
import type { DesktopBitsentryApi } from "@bitsentry-ce/components/services/desktop-api";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@bitsentry-ce/components/hooks/use-toast", () => ({
  useToast: () => ({
    toast: vi.fn(),
  }),
}));

type DeferredPromise<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferredPromise<T>(): DeferredPromise<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useDesktopPrimaryAgentSelection", () => {
  it("marks exactly one cached provider as primary", () => {
    expect(
      withPrimarySavedProvider(
        {
          codex: {
            hasApiKey: true,
            baseUrl: "",
            model: "gpt-5.4",
            availableModels: ["gpt-5.4"],
            isSelectable: true,
            isPrimary: true,
          },
          openai: {
            hasApiKey: true,
            baseUrl: "",
            model: "gpt-5.1",
            availableModels: ["gpt-5.1"],
            isSelectable: true,
            isPrimary: false,
          },
        },
        "openai",
      ),
    ).toMatchObject({
      codex: { isPrimary: false },
      openai: { isPrimary: true },
    });
  });

  it("returns the in-flight saved provider load to concurrent callers", async () => {
    const deferred = createDeferredPromise<{
      codex: {
        hasApiKey: boolean;
        baseUrl: string;
        model: string;
        availableModels: string[];
        isSelectable: boolean;
        isPrimary: boolean;
      };
    }>();

    const getProviders = vi.fn(() => deferred.promise);
    const desktopApi: DesktopBitsentryApi = {
      llm: {
        getProviders,
        saveProvider: vi.fn(),
      },
    };
    vi.spyOn(desktopApiModule, "getDesktopApi").mockReturnValue(desktopApi);

    const { result } = renderHook(() =>
      useDesktopPrimaryAgentSelection({
        captureDesktopAnalyticsEvent: () => {},
      }),
    );

    await waitFor(() => {
      expect(getProviders).toHaveBeenCalledTimes(1);
    });

    const secondLoadPromise = result.current.loadSavedProvidersOnce();

    await act(async () => {
      deferred.resolve({
        codex: {
          hasApiKey: true,
          baseUrl: "",
          model: "gpt-5.4",
          availableModels: ["gpt-5.4"],
          isSelectable: true,
          isPrimary: true,
        },
      });
      await deferred.promise;
    });

    await expect(secondLoadPromise).resolves.toEqual({
      codex: {
        hasApiKey: true,
        baseUrl: "",
        model: "gpt-5.4",
        availableModels: ["gpt-5.4"],
        isSelectable: true,
        isPrimary: true,
      },
    });
    expect(result.current.primaryAgent).toBe("codex");
    expect(getProviders).toHaveBeenCalledTimes(1);
  });

  it("keeps an optimistic primary agent when a stale provider load resolves late", async () => {
    const deferred = createDeferredPromise<{
      codex: {
        hasApiKey: boolean;
        baseUrl: string;
        model: string;
        availableModels: string[];
        isSelectable: boolean;
        isPrimary: boolean;
      };
      cursor: {
        hasApiKey: boolean;
        baseUrl: string;
        model: string;
        availableModels: string[];
        isSelectable: boolean;
        isPrimary: boolean;
      };
    }>();

    const getProviders = vi.fn(() => deferred.promise);
    const saveProvider = vi.fn().mockResolvedValue({ ok: true });
    const desktopApi: DesktopBitsentryApi = {
      llm: {
        getProviders,
        saveProvider,
      },
    };
    vi.spyOn(desktopApiModule, "getDesktopApi").mockReturnValue(desktopApi);

    const { result } = renderHook(() =>
      useDesktopPrimaryAgentSelection({
        captureDesktopAnalyticsEvent: () => {},
      }),
    );

    await waitFor(() => {
      expect(getProviders).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.handleSetPrimaryAgent("cursor");
    });

    await waitFor(() => {
      expect(saveProvider).toHaveBeenCalledWith("cursor", { isPrimary: true });
    });

    await act(async () => {
      deferred.resolve({
        codex: {
          hasApiKey: true,
          baseUrl: "",
          model: "gpt-5.4",
          availableModels: ["gpt-5.4"],
          isSelectable: true,
          isPrimary: true,
        },
        cursor: {
          hasApiKey: true,
          baseUrl: "",
          model: "composer-2.5",
          availableModels: ["composer-2.5"],
          isSelectable: true,
          isPrimary: false,
        },
      });
      await deferred.promise;
    });

    expect(result.current.primaryAgent).toBe("cursor");
  });
});
