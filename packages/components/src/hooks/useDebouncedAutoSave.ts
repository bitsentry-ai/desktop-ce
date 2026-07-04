import { useEffect, useRef, useState } from "react";

export type AutoSaveStatus = "idle" | "saving" | "saved" | "error";

interface Options<T> {
  /** Debounce delay in ms. Defaults to 600. */
  delay?: number;
  /** When false, no save is scheduled. */
  enabled?: boolean;
  /**
   * Compare the value to the last *saved* value to decide whether a save is needed.
   * Defaults to `Object.is` shallow equality on JSON.stringify.
   */
  isEqual?: (a: T, b: T) => boolean;
  /** Validation predicate. If returns a string, save is skipped and the message is exposed as `error`. */
  validate?: (value: T) => string | null;
  /** Re-run validation when external validation inputs change. */
  validationKey?: unknown;
  /** Treat the current value as already persisted when this key changes. */
  baselineKey?: unknown;
}

/**
 * Auto-saves `value` via `onSave` when it changes, with a debounce.
 *
 * Why: debounce avoids one save per keystroke. Equality check avoids re-saving
 * when the value resets to what was just persisted. Validation gating prevents
 * saving partially-typed input that would error out server-side anyway.
 */
export function useDebouncedAutoSave<T>(
  value: T,
  onSave: (value: T) => Promise<void> | void,
  options: Options<T> = {},
) {
  const {
    delay = 600,
    enabled = true,
    isEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b),
    validate,
    validationKey,
    baselineKey,
  } = options;

  const [status, setStatus] = useState<AutoSaveStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const lastSavedRef = useRef<T>(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const valueRef = useRef(value);
  const onSaveRef = useRef(onSave);
  const validateRef = useRef(validate);
  const isEqualRef = useRef(isEqual);
  const delayRef = useRef(delay);
  const baselineKeyRef = useRef(baselineKey);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    validateRef.current = validate;
  }, [validate]);

  useEffect(() => {
    isEqualRef.current = isEqual;
  }, [isEqual]);

  useEffect(() => {
    delayRef.current = delay;
  }, [delay]);

  useEffect(() => {
    const clearPendingSave = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    if (!enabled) {
      clearPendingSave();
      return;
    }

    if (!Object.is(baselineKeyRef.current, baselineKey)) {
      clearPendingSave();
      baselineKeyRef.current = baselineKey;
      lastSavedRef.current = value;
      setErrorMessage(null);
      setStatus("idle");
      return;
    }

    const validationError = validateRef.current?.(value) ?? null;
    if (validationError !== null && validationError.length > 0) {
      clearPendingSave();
      setErrorMessage(validationError);
      setStatus("error");
      return;
    }

    if (isEqualRef.current(value, lastSavedRef.current)) {
      setErrorMessage(null);
      setStatus((current) => {
        if (current === "error") {
          return "saved";
        }

        return current;
      });
      return;
    }

    setErrorMessage(null);

    clearPendingSave();

    timerRef.current = setTimeout(() => {
      if (inFlightRef.current) {
        // Re-arm: a save is already running; we'll save again after it lands.
        timerRef.current = setTimeout(() => {
          void run();
        }, delayRef.current);
        return;
      }
      void run();
    }, delayRef.current);

    async function run() {
      const nextValue = valueRef.current;
      inFlightRef.current = true;
      setStatus("saving");
      try {
        await onSaveRef.current(nextValue);
        lastSavedRef.current = nextValue;
        setStatus("saved");
      } catch (err) {
        let message = String(err);
        if (err instanceof Error) {
          message = err.message;
        }
        setErrorMessage(message);
        setStatus("error");
      } finally {
        inFlightRef.current = false;
      }
    }

    return clearPendingSave;
  }, [value, enabled, validationKey, baselineKey]);

  return { status, error: errorMessage } as const;
}
