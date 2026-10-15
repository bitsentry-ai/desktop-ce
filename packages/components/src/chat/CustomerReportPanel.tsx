import { useMemo } from "react";
import { Lock, MessageSquareText, X } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import { customerReportChannels } from "@bitsentry-ce/core/features/plugins";
import { supportedTimeZones, type CustomerReportDraft } from "./customerReport";

const FIELD_CLASS = "h-8 w-full rounded-lg border border-border bg-background px-2.5 text-[13px] text-foreground outline-none focus:border-ring/45 disabled:cursor-not-allowed disabled:opacity-60";
const LABEL_CLASS = "mb-1 block text-[11px] font-medium text-muted-foreground";

export function CustomerReportInternalBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border bg-background px-1.5 py-px text-[10px] font-semibold text-muted-foreground">
      <Lock size={10} aria-hidden="true" />
      {label}
    </span>
  );
}

/** The source details of a pasted customer report. The report text itself is the composer text. */
export function CustomerReportPanel({
  draft,
  onChange,
  onRemove,
  disabled,
}: {
  draft: CustomerReportDraft;
  onChange: (draft: CustomerReportDraft) => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const zones = useMemo(() => supportedTimeZones(draft.timeZone), [draft.timeZone]);
  return (
    <section aria-label={t("common.incidents.customerReport.title")} className="mb-3 rounded-xl border border-border/80 bg-background p-3">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <MessageSquareText size={13} aria-hidden="true" />
        </span>
        <span className="text-xs font-medium">{t("common.incidents.customerReport.title")}</span>
        <CustomerReportInternalBadge label={t("common.incidents.customerReport.internalOnly")} />
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          className="ml-auto flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label={t("common.incidents.customerReport.remove")}
        >
          <X size={12} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <label>
          <span className={LABEL_CLASS}>{t("common.incidents.customerReport.channelLabel")}</span>
          <select
            className={FIELD_CLASS}
            value={draft.channel}
            disabled={disabled}
            onChange={(event) => { onChange({ ...draft, channel: event.target.value as CustomerReportDraft["channel"] }); }}
          >
            {customerReportChannels.map((channel) => (
              <option key={channel} value={channel}>{t(`common.incidents.customerReport.channels.${channel}`)}</option>
            ))}
          </select>
        </label>
        <label>
          <span className={LABEL_CLASS}>{t("common.incidents.customerReport.sender")} *</span>
          <input
            className={FIELD_CLASS}
            value={draft.sender}
            maxLength={200}
            required
            disabled={disabled}
            onChange={(event) => { onChange({ ...draft, sender: event.target.value }); }}
          />
        </label>
        <label>
          <span className={LABEL_CLASS}>{t("common.incidents.customerReport.receivedAt")} *</span>
          <input
            type="datetime-local"
            className={FIELD_CLASS}
            value={draft.receivedAtLocal}
            required
            disabled={disabled}
            onChange={(event) => { onChange({ ...draft, receivedAtLocal: event.target.value.slice(0, 16) }); }}
          />
        </label>
        <label>
          <span className={LABEL_CLASS}>{t("common.incidents.customerReport.timeZone")}</span>
          <select
            className={FIELD_CLASS}
            value={draft.timeZone}
            disabled={disabled}
            onChange={(event) => { onChange({ ...draft, timeZone: event.target.value }); }}
          >
            {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
          </select>
        </label>
      </div>
    </section>
  );
}
