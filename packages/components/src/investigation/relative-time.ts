/** "3 hours ago" style text for a timestamp; the exact time belongs in a `title` next to it. */
export function relativeTime(iso: string): string {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [["day", 86_400], ["hour", 3_600], ["minute", 60]];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(Math.round(seconds / 60), "minute");
}
