import { useCallback, useId, useState, type ElementType, type ReactNode } from "react";
import { ChevronDown, ChevronRight, FileText, Ticket, Webhook } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { IntegrationOperation } from "@bitsentry-ce/core/features/plugins";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { OperationBody, StatusBadges, operationLabel, type IntegrationOperationsPort, type OperationDecisions } from "./IntegrationActionsView";
import { DeliveryRecoveryControls, DeliveryStateBadge, deliveryChannelLabel, needsReview, shortEvent, type IntegrationDelivery, type IntegrationDeliveriesPort } from "./IntegrationDeliveriesView";
import { relativeTime } from "./relative-time";

/** Which cards of the Artifacts panel are open. A card keeps its half-filled form while it is closed. */
export function useOpenCards() {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const isOpen = useCallback((id: string) => open.has(id), [open]);
  const toggle = useCallback((id: string) => {
    setOpen((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const show = useCallback((id: string) => { setOpen((previous) => (previous.has(id) ? previous : new Set(previous).add(id))); }, []);
  return { isOpen, toggle, show };
}

function CollapsibleCard({ label, ariaLabel = label, icon: Icon, open, onToggle, badges, subtitle, children }: {
  label: string; ariaLabel?: string; icon: ElementType; open: boolean; onToggle(): void; badges: ReactNode; subtitle: ReactNode; children: ReactNode;
}) {
  const bodyId = useId();
  return <article aria-label={ariaLabel} className={cn("min-w-0 rounded-2xl border bg-card transition-colors", open ? "border-primary/50" : "border-border")}>
    <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}
      className="flex w-full items-start gap-3 rounded-2xl p-3 text-left transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-background"><Icon size={15} className="text-muted-foreground" aria-hidden="true" /></div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{label}</span>
          {badges}
        </div>
        <div className="mt-1 truncate text-xs text-muted-foreground">{subtitle}</div>
      </div>
      <ChevronDown size={14} aria-hidden="true" className={cn("mt-1 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
    </button>
    <div id={bodyId} hidden={!open} className="border-t border-border pt-3">{children}</div>
  </article>;
}

const updatedAt = (value: string) => <time dateTime={value} title={new Date(value).toLocaleString()}>{relativeTime(value)}</time>;

/** One ticket action as a card: its status on the header, the exact proposal with approve, reject and recovery when opened. */
export function OperationCard({ row, open, onToggle, disabled, decisions, service, onRefresh }: {
  row: IntegrationOperation; open: boolean; onToggle(): void; disabled: boolean; decisions: OperationDecisions; service: IntegrationOperationsPort; onRefresh(): Promise<void>;
}) {
  const { t } = useTranslation();
  return <CollapsibleCard label={operationLabel(row, t)} icon={row.ticketOperation === undefined ? FileText : Ticket} open={open} onToggle={onToggle} badges={<StatusBadges row={row} />}
    subtitle={<>{row.connectionName} · {updatedAt(row.updatedAt)}</>}>
    <OperationBody className="space-y-3 px-3 pb-3" row={row} disabled={disabled} busy={decisions.busy} refusal={decisions.refusal(row.id)} closeRequested={decisions.closeRequested(row.id)}
      onCloseRequestedChange={(value) => { decisions.setCloseRequested(row.id, value); }}
      onApprove={() => { void decisions.decide(row, true); }} onReject={() => { void decisions.decide(row, false); }} service={service} onRefresh={onRefresh} />
  </CollapsibleCard>;
}

/** One webhook delivery as a card: its state on the header, the event and the recovery for one that needs review when opened. */
export function DeliveryItemCard({ row, open, onToggle, threadId, disabled, service, onRefresh }: {
  row: IntegrationDelivery; open: boolean; onToggle(): void; threadId: string; disabled: boolean; service: IntegrationDeliveriesPort; onRefresh(): Promise<void>;
}) {
  const { t } = useTranslation();
  const channel = deliveryChannelLabel(row, t);
  return <CollapsibleCard label={channel} ariaLabel={`${channel} ${shortEvent(row.eventId)}`} icon={Webhook} open={open} onToggle={onToggle} badges={<DeliveryStateBadge row={row} />}
    subtitle={<>{updatedAt(row.updatedAt)} · <span className="font-mono" title={row.eventId}>{shortEvent(row.eventId)}</span></>}>
    <div className="space-y-2 px-3 pb-3">
      <p className="break-all text-xs text-muted-foreground">{t("incidents.artifactsPanel.eventId")} <span className="font-mono">{row.eventId}</span></p>
      {row.externalId !== null && !needsReview(row) && <p className="text-sm">{t("incidents.deliveries.providerId", { id: row.externalId })}</p>}
      {/* The form is keyed by what it was built for, so a new status or a new ticket ID starts it from a clean state. */}
      {needsReview(row) && <DeliveryRecoveryControls key={`${row.state}:${row.externalId ?? ""}`} row={row} threadId={threadId} disabled={disabled} service={service} onRefresh={onRefresh} />}
    </div>
  </CollapsibleCard>;
}

/** Something that waits for the engineer and is decided elsewhere in the panel: the row says what, and its action goes there. */
export function AttentionRow({ icon: Icon, title, badge, subtitle, actionLabel, onAction }: {
  icon: ElementType; title: string; badge?: ReactNode; subtitle: string; actionLabel: string; onAction(): void;
}) {
  return <article aria-label={title} className="flex min-w-0 items-center gap-3 rounded-2xl border border-border bg-card p-3">
    <div className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-background"><Icon size={15} className="text-muted-foreground" aria-hidden="true" /></div>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="truncate text-sm font-medium">{title}</span>
        {badge}
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">{subtitle}</div>
    </div>
    <Button type="button" size="sm" variant="ghost" onClick={onAction} className="shrink-0 text-primary">
      {actionLabel}
      <ChevronRight aria-hidden="true" />
    </Button>
  </article>;
}
