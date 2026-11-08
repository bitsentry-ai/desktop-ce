// @vitest-environment jsdom

import { renderHook, act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebouncedAutoSave } from "@bitsentry-ce/components/hooks/useDebouncedAutoSave";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
});

describe("useDebouncedAutoSave", () => {
  it("debounces saves until the delay elapses", async () => {
    const onSave = vi.fn();
    const { rerender } = renderHook(
      ({ value }) => useDebouncedAutoSave(value, onSave, { delay: 100 }),
      { initialProps: { value: "initial" } },
    );

    rerender({ value: "changed" });

    await act(async () => {
      vi.advanceTimersByTime(99);
      await Promise.resolve();
    });
    expect(onSave).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("changed");
  });

  it("blocks saves and exposes validation errors", async () => {
    const onSave = vi.fn();
    const { result, rerender } = renderHook(
      ({ value }) =>
        useDebouncedAutoSave(value, onSave, {
          delay: 50,
          validate: (next) => {
            if (next === "") {
              return "Required";
            }

            return null;
          },
        }),
      { initialProps: { value: "ok" } },
    );

    rerender({ value: "" });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("Required");

    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
    });

    expect(onSave).not.toHaveBeenCalled();
  });

  it("uses the latest save callback without restarting the pending timer", async () => {
    const firstSave = vi.fn();
    const secondSave = vi.fn();
    const { rerender } = renderHook(
      ({ value, onSave }) =>
        useDebouncedAutoSave(value, onSave, { delay: 100 }),
      { initialProps: { value: "initial", onSave: firstSave } },
    );

    rerender({ value: "changed", onSave: firstSave });
    await act(async () => {
      vi.advanceTimersByTime(40);
      await Promise.resolve();
    });

    rerender({ value: "changed", onSave: secondSave });
    await act(async () => {
      vi.advanceTimersByTime(60);
      await Promise.resolve();
    });

    expect(firstSave).not.toHaveBeenCalled();
    expect(secondSave).toHaveBeenCalledTimes(1);
    expect(secondSave).toHaveBeenCalledWith("changed");
  });

  it("reports failed saves as errors", async () => {
    const onSave = vi.fn(() => Promise.reject(new Error("save exploded")));
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedAutoSave(value, onSave, { delay: 10 }),
      { initialProps: { value: "initial" } },
    );

    rerender({ value: "changed" });

    await act(async () => {
      vi.advanceTimersByTime(10);
      await Promise.resolve();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("save exploded");
  });

  it("treats a baseline key change as already saved", async () => {
    const onSave = vi.fn();
    const { rerender } = renderHook(
      ({ baselineKey, value }) =>
        useDebouncedAutoSave(value, onSave, { baselineKey, delay: 25 }),
      { initialProps: { baselineKey: 0, value: "initial" } },
    );

    rerender({ baselineKey: 1, value: "hydrated" });
    await act(async () => {
      vi.advanceTimersByTime(25);
      await Promise.resolve();
    });
    expect(onSave).not.toHaveBeenCalled();

    rerender({ baselineKey: 1, value: "edited" });
    await act(async () => {
      vi.advanceTimersByTime(25);
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("edited");
  });
});
