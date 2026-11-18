import type { StreamDeltaRecord } from "./types";
import { cn } from "../lib/utils";
import { useTranslation } from "@bitsentry-ce/i18n";

function formatDeltaTime(timestamp: string): string {
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return timestamp;
  return value.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  });
}

function renderDeltaText(text: string): string {
  return JSON.stringify(text);
}

export function StreamDeltaInspector({
  deltas,
  className,
}: {
  deltas?: StreamDeltaRecord[];
  className?: string;
}) {
  const { t } = useTranslation();

  if (deltas === undefined || deltas.length === 0) return null;

  return (
    <details
      className={cn(
        "rounded-xl border border-border/70 bg-muted/10",
        className,
      )}
    >
      <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
        {t("common.streamDeltaInspector.rawDeltas", { count: deltas.length })}
      </summary>
      <div className="border-t border-border/70 px-3 py-2">
        <div className="max-h-48 space-y-1 overflow-y-auto font-mono text-[11px] leading-relaxed text-muted-foreground">
          {deltas.map((delta, index) => (
            <div
              key={`${delta.timestamp}-${String(index)}`}
              className="rounded-md bg-background/70 px-2 py-1"
            >
              <div className="mb-0.5 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                <span>{formatDeltaTime(delta.timestamp)}</span>
                <span>{delta.kind ?? "text"}</span>
                <span>
                  {t("common.streamDeltaInspector.charCount", {
                    count: delta.text.length,
                  })}
                </span>
              </div>
              <div className="whitespace-pre-wrap break-words text-foreground/80">
                {renderDeltaText(delta.text)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}
