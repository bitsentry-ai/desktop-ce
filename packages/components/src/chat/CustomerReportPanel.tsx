import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Lock, MessageSquareText, X } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import { customerReportChannels } from "@bitsentry-ce/core/features/plugins";
import { cn } from "../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "../ui/select";
import {
  customerReportDraftIssues,
  nowInTimeZone,
  suggestedTimeZones,
  supportedTimeZones,
  timeZoneOffsetLabel,
  type CustomerReportDraft,
} from "./customerReport";

/** The shared "internal only" marker for a customer report: in the composer, the chat bubble and the approval card. */
export function CustomerReportInternalBadge({ label }: { label: string }) {
  return (
    <Badge variant="secondary" className="shrink-0 gap-1 whitespace-nowrap px-1.5 py-0 text-[10px] font-semibold">
      <Lock size={10} aria-hidden="true" />
      {label}
    </Badge>
  );
}

/** A labelled control in the style of the Settings and credential forms, with an optional required mark and error. */
function Field({ id, label, required, error, children, className }: {
  id: string; label: string; required?: boolean; error?: string; children: ReactNode; className?: string;
}) {
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <label htmlFor={id} className="block text-xs font-medium text-muted-foreground">
        {label}
        {required === true && <span aria-hidden="true" className="ml-0.5 text-destructive">*</span>}
      </label>
      {children}
      {error !== undefined && <p id={`${id}-error`} role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

const CONTROL_CLASS = "h-8 text-xs";

/** The source details of a pasted customer report. The report text itself is the composer text. */
export function CustomerReportPanel({
  draft,
  onChange,
  onRemove,
  disabled,
  defaultTimeZone,
}: {
  draft: CustomerReportDraft;
  onChange: (draft: CustomerReportDraft) => void;
  onRemove: () => void;
  disabled: boolean;
  defaultTimeZone?: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const senderRef = useRef<HTMLInputElement>(null);
  const channelRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [touched, setTouched] = useState<{ sender?: boolean; receivedAt?: boolean }>({});
  const suggested = useMemo(() => suggestedTimeZones(draft.timeZone, defaultTimeZone), [draft.timeZone, defaultTimeZone]);
  const others = useMemo(() => supportedTimeZones(draft.timeZone).filter((zone) => !suggested.includes(zone)), [draft.timeZone, suggested]);
  const issues = customerReportDraftIssues(draft);
  // A required field is flagged once the engineer has left it; a time in the future is flagged at once.
  const senderError = touched.sender === true && issues.sender !== undefined ? t("common.incidents.customerReport.senderRequired") : undefined;
  let receivedAtError: string | undefined;
  if (issues.receivedAt === "future") receivedAtError = t("common.incidents.customerReport.receivedAtFuture");
  else if (touched.receivedAt === true && issues.receivedAt !== undefined) receivedAtError = t("common.incidents.customerReport.receivedAtRequired");

  useEffect(() => { senderRef.current?.focus(); }, []);

  const selectChannel = (index: number) => {
    const channel = customerReportChannels[(index + customerReportChannels.length) % customerReportChannels.length];
    onChange({ ...draft, channel });
    channelRefs.current[customerReportChannels.indexOf(channel)]?.focus();
  };
  const onChannelKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); selectChannel(index + 1); }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); selectChannel(index - 1); }
  };
  const zoneLabel = (zone: string) => {
    const offset = timeZoneOffsetLabel(zone);
    return offset === "" ? zone : `${zone} (${offset})`;
  };

  return (
    <section
      role="group"
      aria-labelledby={`${id}-title`}
      className="mb-3 rounded-lg border border-border/80 bg-background"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <MessageSquareText size={14} aria-hidden="true" className="shrink-0 text-muted-foreground" />
        <h3 id={`${id}-title`} className="whitespace-nowrap text-xs font-medium text-foreground">{t("common.incidents.customerReport.title")}</h3>
        <CustomerReportInternalBadge label={t("common.incidents.customerReport.internalOnly")} />
        <span className="hidden min-w-0 truncate text-[11px] text-muted-foreground sm:inline">{t("common.incidents.customerReport.unverifiedShort")}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          disabled={disabled}
          className="ml-auto size-6 text-muted-foreground hover:text-foreground"
          aria-label={t("common.incidents.customerReport.remove")}
        >
          <X className="!size-3.5" />
        </Button>
      </div>
      {/* Columns follow the composer's own width, not the window: a narrow composer stacks the fields. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(17rem,1fr))] gap-3 p-3">
        <div className="min-w-0 space-y-1.5">
          <span id={`${id}-channel`} className="block text-xs font-medium text-muted-foreground">{t("common.incidents.customerReport.channelLabel")}</span>
          <div role="radiogroup" aria-labelledby={`${id}-channel`} className="flex flex-wrap gap-1 rounded-md border border-border p-0.5">
            {customerReportChannels.map((channel, index) => {
              const selected = channel === draft.channel;
              return (
                <button
                  key={channel}
                  ref={(element) => { channelRefs.current[index] = element; }}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  disabled={disabled}
                  onClick={() => { onChange({ ...draft, channel }); }}
                  onKeyDown={(event) => { onChannelKeyDown(event, index); }}
                  className={cn(
                    "h-7 min-w-fit flex-1 whitespace-nowrap rounded px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50",
                    selected ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`common.incidents.customerReport.channels.${channel}`)}
                </button>
              );
            })}
          </div>
        </div>
        <Field id={`${id}-sender`} label={t("common.incidents.customerReport.sender")} required error={senderError}>
          <Input
            ref={senderRef}
            id={`${id}-sender`}
            className={CONTROL_CLASS}
            value={draft.sender}
            maxLength={200}
            autoComplete="off"
            placeholder={t("common.incidents.customerReport.senderPlaceholder")}
            aria-required="true"
            aria-invalid={senderError !== undefined}
            aria-describedby={senderError === undefined ? undefined : `${id}-sender-error`}
            disabled={disabled}
            onBlur={() => { setTouched((current) => ({ ...current, sender: true })); }}
            onChange={(event) => { onChange({ ...draft, sender: event.target.value }); }}
          />
        </Field>
        <Field id={`${id}-received`} label={t("common.incidents.customerReport.receivedAt")} required error={receivedAtError}>
          <div className="flex gap-1.5">
            <Input
              id={`${id}-received`}
              type="datetime-local"
              className={cn(CONTROL_CLASS, "min-w-0 flex-1")}
              value={draft.receivedAtLocal}
              max={nowInTimeZone(draft.timeZone)}
              aria-required="true"
              aria-invalid={receivedAtError !== undefined}
              aria-describedby={receivedAtError === undefined ? undefined : `${id}-received-error`}
              disabled={disabled}
              onBlur={() => { setTouched((current) => ({ ...current, receivedAt: true })); }}
              onChange={(event) => { onChange({ ...draft, receivedAtLocal: event.target.value.slice(0, 16) }); }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              className="shrink-0"
              onClick={() => {
                onChange({ ...draft, receivedAtLocal: nowInTimeZone(draft.timeZone) });
                setTouched((current) => ({ ...current, receivedAt: true }));
              }}
            >
              {t("common.incidents.customerReport.now")}
            </Button>
          </div>
        </Field>
        <Field id={`${id}-zone`} label={t("common.incidents.customerReport.timeZone")}>
          <Select value={draft.timeZone} disabled={disabled} onValueChange={(timeZone) => { onChange({ ...draft, timeZone }); }}>
            <SelectTrigger id={`${id}-zone`} className={CONTROL_CLASS}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectGroup>
                <SelectLabel className="text-xs text-muted-foreground">{t("common.incidents.customerReport.suggestedTimeZones")}</SelectLabel>
                {suggested.map((zone) => <SelectItem key={zone} value={zone} className="text-xs">{zoneLabel(zone)}</SelectItem>)}
              </SelectGroup>
              {others.length > 0 && <SelectSeparator />}
              {others.length > 0 && (
                <SelectGroup>
                  <SelectLabel className="text-xs text-muted-foreground">{t("common.incidents.customerReport.allTimeZones")}</SelectLabel>
                  {others.map((zone) => <SelectItem key={zone} value={zone} className="text-xs">{zone}</SelectItem>)}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
        </Field>
      </div>
    </section>
  );
}
