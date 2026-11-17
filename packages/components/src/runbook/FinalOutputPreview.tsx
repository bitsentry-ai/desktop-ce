import { useMemo } from "react";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";

import { runOutputPreview } from "./runOutputFormat";

/**
 * The Summary column's view of the final output: a three-line excerpt and a
 * button that opens the full output in the Output column, so the payload is
 * shown in full only once.
 */
export function FinalOutputPreview({
  output,
  emptyMessage,
  onViewOutput,
}: {
  output: string;
  emptyMessage: string;
  onViewOutput: () => void;
}) {
  const { t } = useTranslation();
  const preview = useMemo(() => runOutputPreview(output), [output]);

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        {t("common.results.finalOutput")}
      </div>
      {preview.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">{emptyMessage}</p>
      ) : (
        <>
          <p className="line-clamp-3 whitespace-pre-line break-words text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
            {preview}
          </p>
          <button
            type="button"
            onClick={onViewOutput}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {t("common.results.viewOutput")}
            <ArrowRight size={12} aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
}
