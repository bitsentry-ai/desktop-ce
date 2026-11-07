/**
 * QueuedMessagesPanel — the follow-ups waiting for the running turn, attached
 * above the composer. Adapted from T3 Code's queued runs control
 * (https://github.com/pingdotgg/t3code, MIT): drag or arrow-key reorder, edit
 * in the composer, steer into the running turn, remove.
 */

import { useId, useRef, useState } from "react";
import {
  ChevronDown,
  CornerUpRight,
  GripVertical,
  ListOrdered,
  Pencil,
  X,
} from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import { cn } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import type { AgentQueuedMessage } from "./types";

export interface ComposerQueue {
  messages: AgentQueuedMessage[];
  /** A stop, timeout or failure paused the queue; it waits for Resume. */
  held: boolean;
  canSteer: boolean;
  isRunning: boolean;
  editingId: string | null;
  onEdit: (message: AgentQueuedMessage) => void;
  onCancelEdit: () => void;
  onRemove: (id: string) => Promise<void>;
  onSteer: (id: string) => Promise<void>;
  onReorder: (id: string, beforeId: string | null) => Promise<void>;
}

const DRAG_TYPE = "application/x-bitsentry-queued-message";

const iconButtonClassName =
  "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5";

function QueueTooltip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-96 break-words text-xs">{label}</TooltipContent>
    </Tooltip>
  );
}

export function QueuedMessagesPanel({ queue }: { queue: ComposerQueue }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<{ id: string; insertIndex: number | null } | null>(null);
  // Drags start from the grip only, not from an accidental text drag on the row.
  const dragArmedIdRef = useRef<string | null>(null);
  const listId = useId();

  if (queue.messages.length === 0) return null;

  const steering = queue.messages.filter((message) => message.steer === true);
  const queued = queue.messages.filter((message) => message.steer !== true);
  const canReorder = queued.length > 1;

  const run = async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    try {
      await action();
    } finally {
      setBusyId(null);
    }
  };

  const move = (id: string, beforeId: string | null) => run(id, () => queue.onReorder(id, beforeId));

  const completeDrag = (id: string, insertIndex: number | null) => {
    setDragState(null);
    dragArmedIdRef.current = null;
    if (insertIndex === null || busyId !== null) return;
    const draggedIndex = queued.findIndex((message) => message.id === id);
    if (draggedIndex === -1 || insertIndex === draggedIndex || insertIndex === draggedIndex + 1) return;
    void move(id, queued[insertIndex]?.id ?? null);
  };

  let steerUnavailable = t("common.incidents.queue.cannotSteer");
  if (!queue.isRunning) steerUnavailable = t("common.incidents.queue.noActiveRun");

  return (
    <TooltipProvider delayDuration={300}>
      <div className="relative z-0 mx-auto -mb-4 w-[calc(100%-1.5rem)]">
        <div
          role="region"
          aria-label={t("common.incidents.queue.region", { count: queue.messages.length })}
          aria-live="polite"
          className="rounded-t-2xl border border-b-0 border-border/70 bg-card/95 px-1 pb-5 pt-1 text-xs leading-4 shadow-sm backdrop-blur"
        >
          <button
            type="button"
            aria-label={expanded ? t("common.incidents.queue.collapse") : t("common.incidents.queue.expand")}
            aria-expanded={expanded}
            aria-controls={listId}
            onPointerDown={(event) => { event.preventDefault(); }}
            onClick={() => { setExpanded((value) => !value); }}
            className="grid min-h-6 w-full grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-1 rounded-md text-start focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            <span aria-hidden className="flex items-center justify-center text-muted-foreground [&_svg]:size-3">
              <ListOrdered />
            </span>
            <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
              {t("common.incidents.queue.title")}
              {queue.held && (
                <>
                  <span aria-hidden className="text-muted-foreground/40">·</span>
                  <span className="text-amber-600 dark:text-amber-400">{t("common.incidents.queue.paused")}</span>
                </>
              )}
            </span>
            <span className="flex items-center gap-1">
              <span className="min-w-6 text-center font-medium tabular-nums text-muted-foreground">{queue.messages.length}</span>
              <span aria-hidden className="flex size-6 items-center justify-center text-muted-foreground">
                <ChevronDown className={cn("size-3.5 transition-transform", !expanded && "rotate-180")} />
              </span>
            </span>
          </button>
          <ol id={listId} className={cn("grid max-h-32 gap-px overflow-y-auto", !expanded && "hidden")}>
            {steering.map((message) => (
              <li key={message.id} className="grid min-h-6 grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-1">
                <span className="flex items-center justify-center text-violet-600 dark:text-violet-400 [&_svg]:size-3">
                  <CornerUpRight aria-label={t("common.incidents.queue.steering")} />
                </span>
                <QueuedRowText message={message} />
                <span className="flex items-center justify-end gap-1">
                  <QueueTooltip label={t("common.incidents.queue.removeTooltip")}>
                    <button
                      type="button"
                      aria-label={t("common.incidents.queue.remove")}
                      disabled={busyId !== null}
                      onClick={() => { void run(message.id, () => queue.onRemove(message.id)); }}
                      className={iconButtonClassName}
                    >
                      <X />
                    </button>
                  </QueueTooltip>
                </span>
              </li>
            ))}
            {queued.map((message, index) => {
              const isEditing = message.id === queue.editingId;
              return (
                <li
                  key={message.id}
                  aria-current={isEditing ? "true" : undefined}
                  draggable={canReorder && busyId === null}
                  onDragStart={(event) => {
                    if (dragArmedIdRef.current !== message.id) {
                      event.preventDefault();
                      return;
                    }
                    event.dataTransfer.setData(DRAG_TYPE, message.id);
                    event.dataTransfer.effectAllowed = "move";
                    setDragState({ id: message.id, insertIndex: null });
                  }}
                  onDragEnd={() => {
                    dragArmedIdRef.current = null;
                    setDragState(null);
                  }}
                  onDragOver={(event) => {
                    if (dragState === null) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const rect = event.currentTarget.getBoundingClientRect();
                    const insertIndex = event.clientY < rect.top + rect.height / 2 ? index : index + 1;
                    if (dragState.insertIndex !== insertIndex) setDragState({ id: dragState.id, insertIndex });
                  }}
                  onDrop={(event) => {
                    if (dragState === null) return;
                    event.preventDefault();
                    completeDrag(dragState.id, dragState.insertIndex);
                  }}
                  className={cn(
                    "relative grid min-h-6 grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-1 rounded-sm",
                    isEditing && "bg-accent text-accent-foreground",
                    dragState?.id === message.id && "opacity-50",
                  )}
                >
                  {dragState?.insertIndex === index && (
                    <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded bg-primary/70" />
                  )}
                  {index === queued.length - 1 && dragState?.insertIndex === queued.length && (
                    <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 rounded bg-primary/70" />
                  )}
                  <span className="flex items-center justify-center">
                    {canReorder && (
                      <button
                        type="button"
                        aria-label={t("common.incidents.queue.reorder")}
                        disabled={busyId !== null}
                        onPointerDown={() => { dragArmedIdRef.current = message.id; }}
                        onKeyDown={(event) => {
                          if (busyId !== null) return;
                          if (event.key === "ArrowUp" && index > 0) {
                            event.preventDefault();
                            void move(message.id, queued[index - 1]?.id ?? null);
                          }
                          if (event.key === "ArrowDown" && index < queued.length - 1) {
                            event.preventDefault();
                            void move(message.id, queued[index + 2]?.id ?? null);
                          }
                        }}
                        className={cn(iconButtonClassName, "cursor-grab active:cursor-grabbing")}
                      >
                        <GripVertical />
                      </button>
                    )}
                  </span>
                  <span className="flex min-w-0 items-center gap-1 text-foreground/80">
                    {isEditing && <span className="sr-only">{t("common.incidents.queue.editing")}</span>}
                    <QueuedRowText message={message} />
                  </span>
                  <span className="flex items-center justify-end gap-1">
                    {isEditing ? (
                      <button
                        type="button"
                        aria-label={t("common.incidents.queue.cancelEdit")}
                        onClick={queue.onCancelEdit}
                        className="h-6 rounded-md px-2 text-xs text-foreground transition-colors hover:bg-muted"
                      >
                        {t("common.actions.cancel")}
                      </button>
                    ) : (
                      <>
                        <QueueTooltip label={t("common.incidents.queue.editTooltip")}>
                          <button
                            type="button"
                            aria-label={t("common.incidents.queue.edit")}
                            disabled={busyId !== null}
                            onClick={() => { queue.onEdit(message); }}
                            className={iconButtonClassName}
                          >
                            <Pencil />
                          </button>
                        </QueueTooltip>
                        <QueueTooltip label={queue.canSteer ? t("common.incidents.queue.steerTooltip") : steerUnavailable}>
                          <span className="flex shrink-0">
                            <button
                              type="button"
                              disabled={busyId !== null || !queue.canSteer}
                              onClick={() => { void run(message.id, () => queue.onSteer(message.id)); }}
                              className="flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5"
                            >
                              <CornerUpRight />
                              {t("common.incidents.queue.steer")}
                            </button>
                          </span>
                        </QueueTooltip>
                        <QueueTooltip label={t("common.incidents.queue.removeTooltip")}>
                          <button
                            type="button"
                            aria-label={t("common.incidents.queue.remove")}
                            disabled={busyId !== null}
                            onClick={() => { void run(message.id, () => queue.onRemove(message.id)); }}
                            className={iconButtonClassName}
                          >
                            <X />
                          </button>
                        </QueueTooltip>
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </TooltipProvider>
  );
}

function QueuedRowText({ message }: { message: AgentQueuedMessage }) {
  const thumbnails = (message.attachments ?? []).filter((attachment) => attachment.type === "image");
  return (
    <>
      {thumbnails.length > 0 && (
        <span className="flex shrink-0 items-center gap-0.5">
          {thumbnails.map((attachment) => (
            <span key={attachment.id} className="size-4 overflow-hidden rounded border border-border/70 bg-background">
              {attachment.type === "image" && <img src={attachment.dataUrl} alt={attachment.name} className="size-full object-cover" />}
            </span>
          ))}
        </span>
      )}
      <QueueTooltip label={message.text}>
        <span className="min-w-0 flex-1 truncate">{message.text}</span>
      </QueueTooltip>
    </>
  );
}
