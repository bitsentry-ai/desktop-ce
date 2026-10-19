/**
 * Citing the agent's earlier answers, adapted from T3 Code
 * (https://github.com/pingdotgg/t3code, MIT): select text in an answer, press
 * Cite, add an optional comment, and the quote joins the composer as a chip.
 * In a sent message the chip shows the quote and goes back to its source.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Pencil, Quote, X } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import { cn } from "../lib/utils";
import {
  CITATION_MAX_COMMENT_LENGTH,
  CITATION_MAX_TEXT_LENGTH,
  citationLabel,
  type AssistantCitation,
} from "./citations";
import { captureSelectionCitation, revealCitation } from "./citationDom";

function CitationCommentEditor({
  initialComment,
  onSave,
  onCancel,
}: {
  initialComment?: string;
  onSave: (comment: string | undefined) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [comment, setComment] = useState(initialComment ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { textareaRef.current?.focus(); }, []);
  const save = () => {
    const trimmed = comment.trim();
    onSave(trimmed.length > 0 ? trimmed : undefined);
  };

  return (
    <div className="w-72 space-y-2 rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-lg">
      <textarea
        ref={textareaRef}
        value={comment}
        maxLength={CITATION_MAX_COMMENT_LENGTH}
        rows={3}
        placeholder={t("common.chat.citations.commentPlaceholder")}
        onChange={(event) => { setComment(event.target.value); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            save();
          }
        }}
        className="w-full resize-none rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus:border-ring/45"
      />
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={onCancel} className="h-7 rounded-md border border-border px-3 text-xs hover:bg-muted">
          {t("common.actions.cancel")}
        </button>
        <button type="button" onClick={save} className="h-7 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-primary/90">
          {t("common.actions.save")}
        </button>
      </div>
    </div>
  );
}

/** Where a floating control sits: below the selection's end, kept inside the window. */
function floatingPosition(rect: DOMRect, width: number, height: number): { left: number; top: number } {
  const left = Math.min(Math.max(8, rect.right - width / 2), window.innerWidth - width - 8);
  const below = rect.bottom + 6;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below;
  return { left, top };
}

/** Shows Cite next to a selection inside the agent's text, and the comment editor once pressed. */
export function CitationSelectionToolbar({
  viewportRef,
  threadId,
  onCite,
}: {
  viewportRef: RefObject<HTMLElement | null>;
  threadId: string;
  onCite: (citation: AssistantCitation) => void;
}) {
  const { t } = useTranslation();
  const [captured, setCaptured] = useState<{ citation: AssistantCitation; rect: DOMRect } | null>(null);
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(false);
  editingRef.current = editing;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pointerDown = false;
    const read = () => {
      if (editingRef.current) return;
      const viewport = viewportRef.current;
      setCaptured(viewport === null ? null : captureSelectionCitation(viewport, threadId));
    };
    const schedule = (delayMs: number) => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(read, delayMs);
    };
    const onPointerDown = () => { pointerDown = true; };
    // A double or triple click is still settling the selection; wait for it.
    const onMouseUp = (event: MouseEvent) => {
      pointerDown = false;
      schedule(event.detail >= 2 ? 300 : 0);
    };
    const onSelectionChange = () => { if (!pointerDown) schedule(50); };
    const dismiss = () => { if (!editingRef.current) setCaptured(null); };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("resize", dismiss);
    viewportRef.current?.addEventListener("scroll", dismiss, { passive: true });
    const viewport = viewportRef.current;
    return () => {
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("resize", dismiss);
      viewport?.removeEventListener("scroll", dismiss);
    };
  }, [threadId, viewportRef]);

  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const floatingRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (captured === null) {
      setPosition(null);
      return;
    }
    const element = floatingRef.current;
    setPosition(floatingPosition(captured.rect, element?.offsetWidth ?? 80, element?.offsetHeight ?? 32));
  }, [captured, editing]);

  if (captured === null) return null;
  const tooLong = captured.citation.text.length > CITATION_MAX_TEXT_LENGTH;
  const close = () => {
    setEditing(false);
    setCaptured(null);
  };

  return createPortal(
    <div
      ref={floatingRef}
      className="fixed z-50"
      style={{ left: position?.left ?? -9999, top: position?.top ?? -9999 }}
      onPointerDown={(event) => { if (!editing) event.preventDefault(); }}
    >
      {editing ? (
        <CitationCommentEditor
          onCancel={close}
          onSave={(comment) => {
            onCite({ ...captured.citation, ...(comment === undefined ? {} : { comment }) });
            document.getSelection()?.removeAllRanges();
            close();
          }}
        />
      ) : (
        <button
          type="button"
          disabled={tooLong}
          onClick={() => { setEditing(true); }}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-popover px-2 text-xs text-popover-foreground shadow-md transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Quote className="size-3.5" aria-hidden />
          {tooLong ? t("common.chat.citations.shortenSelection") : t("common.chat.citations.cite")}
        </button>
      )}
    </div>,
    document.body,
  );
}

/** A citation as a chip: in the composer it can be removed and its comment edited; in a message it shows the quote. */
export function CitationChip({
  citation,
  onRemove,
  onCommentChange,
}: {
  citation: AssistantCitation;
  onRemove?: () => void;
  onCommentChange?: (comment: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = citationLabel(citation);
  const inComposer = onCommentChange !== undefined;
  let commentLabel = t("common.chat.citations.addComment");
  if (citation.comment !== undefined) commentLabel = t("common.chat.citations.editComment");

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <span className="inline-flex max-w-full items-center gap-0.5 rounded-md border border-border/80 bg-background/70 align-middle text-xs">
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            aria-label={inComposer ? commentLabel : t("common.chat.citations.viewQuote", { label })}
            className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-left hover:bg-muted"
          >
            <Quote className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="max-w-64 truncate">{label}</span>
            {inComposer && <Pencil className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
          </button>
        </PopoverPrimitive.Trigger>
        {onRemove !== undefined && (
          <button
            type="button"
            aria-label={t("common.chat.citations.remove")}
            onClick={onRemove}
            className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        )}
      </span>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content side="top" align="start" sideOffset={6} className="z-50 outline-none">
          {inComposer ? (
            <CitationCommentEditor
              initialComment={citation.comment}
              onCancel={() => { setOpen(false); }}
              onSave={(comment) => {
                onCommentChange(comment);
                setOpen(false);
              }}
            />
          ) : (
            <div className="w-80 space-y-2 rounded-xl border border-border bg-popover p-3 text-sm text-popover-foreground shadow-lg">
              <blockquote className="max-h-40 overflow-auto whitespace-pre-wrap border-l-2 border-border pl-2 text-muted-foreground">
                {citation.text}
              </blockquote>
              {citation.comment !== undefined && <p className="whitespace-pre-wrap">{citation.comment}</p>}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  revealCitation(document, citation);
                }}
                className={cn("h-7 rounded-md border border-border px-2 text-xs hover:bg-muted")}
              >
                {t("common.chat.citations.goToSource")}
              </button>
            </div>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
