import { useEffect, useState } from "react";

/**
 * The current time in milliseconds, moved on every `intervalMs`. Pass it to relative-time formatters so text like
 * "5m ago" keeps advancing in memoized subtrees between data changes.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => { setNow(Date.now()); }, intervalMs);
    return () => { clearInterval(id); };
  }, [intervalMs]);
  return now;
}
