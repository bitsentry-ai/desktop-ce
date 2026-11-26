/**
 * Citing the agent's earlier answers, adapted from T3 Code
 * (https://github.com/pingdotgg/t3code, MIT): select text in an answer and
 * press Cite. The quote joins the composer as a chip, and its comment editor
 * opens under the quoted text. In a sent message the quote shows as a card that
 * goes back to its source, where the quote pulses.
 */

import { useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Pencil, Quote, X } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import { toast } from "../hooks/use-toast";
import {
  CITATION_MAX_COMMENT_LENGTH,
  CITATION_MAX_TEXT_LENGTH,
  citationLabel,
  type AssistantCitation,
} from "./citations";
import {
  captureSelectionCitation,
  findCitationSource,
  isSelectionRectVisibleInViewport,
  observeCitationCommentSource,
  resolveCitationRange,
  revealCitationInList,
  type CitationRevealOutcome,
  type CitationSourceAnchor,
} from "./citationDom";
import { observeSelectionActions, resolveSelectionActionPosition, type SelectionActionPoint } from "./selectionActions";

/** The last line box of a selection or quote, where its floating controls sit. */
function lastRect(rects: DOMRectList): DOMRect | undefined {
  return rects.length > 0 ? Array.from(rects)[rects.length - 1] : undefined;
}

type CitationReveal = (citation: AssistantCitation, onSettled: (outcome: CitationRevealOutcome) => void) => void;

// The message list of each thread registers how to go to a quote in it, so a chip anywhere on the page can.
const revealers = new Map<string, CitationReveal>();

/** Registers how to go to a quote in this thread's message list, for as long as the list is mounted. */
export function useCitationRevealer(threadId: string, reveal: CitationReveal): void {
  const revealRef = useRef(reveal);
  useLayoutEffect(() => {
    revealRef.current = reveal;
  });
  useEffect(() => {
    const registered: CitationReveal = (citation, onSettled) => { revealRef.current(citation, onSettled); };
    revealers.set(threadId, registered);
    return () => {
      if (revealers.get(threadId) === registered) revealers.delete(threadId);
    };
  }, [threadId]);
}

/** Goes to a citation's source, and says so when the quote changed or its answer is not on screen. */
function useRevealCitation(): (citation: AssistantCitation) => void {
  const { t } = useTranslation();
  return (citation) => {
    const onSettled = (outcome: CitationRevealOutcome) => {
      if (outcome === "changed") {
        toast({ title: t("common.chat.citations.quoteChanged"), description: t("common.chat.citations.quoteChangedDescription") });
      } else if (outcome === "missing") {
        toast({ title: t("common.chat.citations.sourceUnavailable"), description: t("common.chat.citations.sourceUnavailableDescription") });
      }
    };
    const reveal = revealers.get(citation.threadId);
    if (reveal !== undefined) reveal(citation, onSettled);
    else revealCitationInList({ citation, messages: [], list: null, onSettled });
  };
}

/** Writes a citation's comment. Enter saves, Command/Ctrl+Enter saves and sends, Shift+Enter adds a line, Escape cancels. */
function CitationCommentEditor({
  initialComment,
  onDraftChange,
  onSave,
  onSaveAndSend,
  onCancel,
}: {
  initialComment?: string;
  onDraftChange: (comment: string) => void;
  onSave: (comment: string) => void;
  onSaveAndSend?: (comment: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [comment, setComment] = useState(initialComment ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const tooLong = comment.length > CITATION_MAX_COMMENT_LENGTH;
  useEffect(() => {
    const input = textareaRef.current;
    if (input === null) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    // Moving the caret doesn't scroll a long comment to it.
    input.scrollTop = input.scrollHeight;
  }, []);

  return (
    <div
      data-citation-comment-editor="true"
      onKeyDown={(event) => {
        event.stopPropagation();
        // WebKit ends an input method's candidates with keyCode 229 and isComposing false.
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <textarea
        ref={textareaRef}
        value={comment}
        rows={2}
        aria-label={t("common.chat.citations.commentLabel")}
        aria-description={t("common.chat.citations.commentHint")}
        aria-invalid={tooLong || undefined}
        placeholder={t("common.chat.citations.commentPlaceholder")}
        dir="auto"
        onChange={(event) => {
          setComment(event.target.value);
          onDraftChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          if (tooLong) return;
          if ((event.metaKey || event.ctrlKey) && onSaveAndSend !== undefined) onSaveAndSend(comment);
          else onSave(comment);
        }}
        className="block max-h-40 min-h-16 w-full resize-none bg-transparent px-1 py-1.5 text-base outline-none [field-sizing:content] placeholder:text-muted-foreground sm:text-sm"
      />
      {tooLong && (
        <p role="status" className="pt-1 text-xs text-destructive">
          {t("common.chat.citations.commentTooLong", { count: CITATION_MAX_COMMENT_LENGTH })}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          // Escape cancels; keep Tab from the comment on Save so Enter cannot discard a new citation.
          tabIndex={-1}
          onPointerDown={(event) => { event.preventDefault(); }}
          onClick={onCancel}
          className="inline-flex h-6 items-center rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          {t("common.actions.cancel")}
        </button>
        <button
          type="button"
          disabled={tooLong}
          onPointerDown={(event) => { event.preventDefault(); }}
          onClick={() => { onSave(comment); }}
          className="inline-flex h-6 items-center rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-[hsl(var(--primary-hover))] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {tooLong ? t("common.chat.citations.shortenComment") : t("common.actions.save")}
        </button>
      </div>
    </div>
  );
}

/**
 * Shows Cite where a selection inside the agent's text ends: at the pointer after a drag, under the selection after a
 * double click or keyboard selection. Tab moves to it, Escape hides it, and scrolling brings it back once settled.
 */
export function CitationSelectionToolbar({
  getViewport,
  threadId,
  onCite,
}: {
  /** The scroll container that holds the agent's answers. */
  getViewport: () => HTMLElement | null;
  threadId: string;
  onCite: (citation: AssistantCitation, anchor: CitationSourceAnchor) => void;
}) {
  const { t } = useTranslation();
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const [selection, setSelection] = useState<{
    citation: AssistantCitation;
    anchor: CitationSourceAnchor;
    position: SelectionActionPoint;
  } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);

  // The scroll container can mount after the toolbar or be replaced when the list remounts (a thread switch, or the
  // list appearing once messages load), so it is looked up after every render; until it exists, every frame.
  const readViewport = useEffectEvent(getViewport);
  useEffect(() => {
    const found = readViewport();
    if (found !== null) {
      setViewport((current) => (current === found ? current : found));
      return;
    }
    let frame = 0;
    const check = () => {
      const next = readViewport();
      if (next !== null) setViewport(next);
      else frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => { cancelAnimationFrame(frame); };
  });

  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (button === null || selection === null) return;
    const rect = button.getBoundingClientRect();
    button.style.left = `${String(Math.max(8, Math.min(selection.position.x, window.innerWidth - rect.width - 8)))}px`;
    button.style.top = `${String(Math.max(8, Math.min(selection.position.y, window.innerHeight - rect.height - 8)))}px`;
  }, [selection]);

  useEffect(() => {
    if (viewport === null) return;
    const clear = () => { setSelection(null); };
    const update = (pointer: SelectionActionPoint | null) => {
      const captured = captureSelectionCitation(viewport, threadId);
      if (captured === null || !isSelectionRectVisibleInViewport(captured.anchor)) {
        clear();
        return;
      }
      const rects = captured.anchor.range.getClientRects();
      const pointerOnText = pointer !== null && Array.from(rects).some((line) =>
        pointer.x >= line.left - 8 && pointer.x <= line.right + 8 && pointer.y >= line.top - 8 && pointer.y <= line.bottom + 8);
      setSelection({
        ...captured,
        position: resolveSelectionActionPosition({
          bounds: viewport.getBoundingClientRect(),
          selectionRect: lastRect(rects) ?? captured.anchor.range.getBoundingClientRect(),
          pointer: pointerOnText ? pointer : null,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      });
    };
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => buttonRef.current,
      onSelection: update,
      onDismiss: clear,
    });
    actionsRef.current = actions;
    // Tab from the selection goes to Cite.
    const focusAction = (event: KeyboardEvent) => {
      const button = buttonRef.current;
      if (
        event.key !== "Tab" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing
        || event.defaultPrevented || button === null || button.disabled
        || (event.target instanceof Node && button.contains(event.target))
      ) return;
      event.preventDefault();
      event.stopPropagation();
      button.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", focusAction, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      document.removeEventListener("keydown", focusAction, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
      // A pill for the previous thread's selection must not outlive it.
      setSelection(null);
    };
  }, [threadId, viewport]);

  if (selection === null) return null;
  const tooLong = selection.citation.text.length > CITATION_MAX_TEXT_LENGTH;
  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  const cite = () => {
    if (tooLong) return;
    onCite(selection.citation, selection.anchor);
    document.getSelection()?.removeAllRanges();
    dismiss();
  };

  return createPortal(
    <button
      ref={buttonRef}
      type="button"
      disabled={tooLong}
      aria-label={tooLong ? t("common.chat.citations.selectionTooLong") : t("common.chat.citations.citeSelection")}
      // Like T3 Code's glass button: a frosted pill that floats over the answer.
      className="fixed z-50 inline-flex h-7 max-w-[calc(100vw-1rem)] items-center gap-1 rounded-full border border-border/60 bg-background/75 px-2 text-sm font-medium text-foreground shadow-sm backdrop-blur-md backdrop-saturate-150 transition-colors hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:cursor-not-allowed disabled:opacity-60 sm:h-6 sm:text-xs"
      style={{ left: selection.position.x, top: selection.position.y }}
      onPointerDown={(event) => { event.preventDefault(); }}
      onClick={cite}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      <Quote aria-hidden className="size-3.5 shrink-0" />
      {tooLong ? t("common.chat.citations.shortenSelection") : t("common.chat.citations.cite")}
    </button>,
    document.body,
  );
}

/** The composer's open comment editor for one citation. */
export interface CitationCommentEditorState {
  open: boolean;
  /** Set right after Cite: the editor opens under the quoted text instead of the chip. */
  sourceAnchor?: CitationSourceAnchor;
  onOpenChange: (open: boolean) => void;
  /** Cancel, or Escape. A citation added a moment ago is dropped; an earlier one keeps its comment. */
  onCancel: () => void;
  onSave: (comment: string | undefined) => void;
  /** Saves and sends; false when the message cannot be sent, which keeps the editor open. */
  onSaveAndSend?: (comment: string | undefined) => boolean;
  /** Where the focus goes once the editor closes. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

const trimmedComment = (comment: string): string | undefined => {
  const trimmed = comment.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** Where the comment editor points: under the end of the quoted text right after Cite, else the chip. */
function commentEditorAnchor(
  chipId: string,
  target: CitationSourceAnchor | undefined,
): RefObject<{ getBoundingClientRect: () => DOMRect; contextElement?: Element }> {
  const chip = () => Array.from(document.querySelectorAll("[data-citation-chip-id]"))
    .find((element) => element.getAttribute("data-citation-chip-id") === chipId);
  if (target === undefined) {
    const measurable = { getBoundingClientRect: () => chip()?.getBoundingClientRect() ?? new DOMRect() };
    // Read when the popover opens, after the chip has mounted.
    Object.defineProperty(measurable, "contextElement", { get: chip });
    return { current: measurable };
  }
  return {
    current: {
      getBoundingClientRect: () => {
        const rect = lastRect(target.range.getClientRects()) ?? target.range.getBoundingClientRect();
        // Code blocks and tables scroll sideways inside the answer, so the quote can end in their hidden overflow.
        const bounds = target.source.getBoundingClientRect();
        const left = Math.min(Math.max(rect.left, bounds.left), bounds.right);
        const right = Math.max(Math.min(rect.right, bounds.right), left);
        return new DOMRect(left, rect.top, right - left, rect.height);
      },
      // Lets the popover follow the quote as the messages scroll.
      contextElement: target.source,
    },
  };
}

/** A citation in the composer: the quote goes back to its source, the pencil edits the comment, the cross removes it. */
export function CitationChip({
  citation,
  onRemove,
  commentEditor,
}: {
  citation: AssistantCitation;
  onRemove?: () => void;
  commentEditor?: CitationCommentEditorState;
}) {
  const { t } = useTranslation();
  const reveal = useRevealCitation();
  const label = citationLabel(citation);
  const draftRef = useRef<string | null>(null);
  // The fresh-Cite anchor whose quoted text left the screen; the editor then sits by the chip.
  const [lostAnchor, setLostAnchor] = useState<CitationSourceAnchor | null>(null);
  const open = commentEditor?.open === true;
  const sourceAnchor = commentEditor?.sourceAnchor === lostAnchor ? undefined : commentEditor?.sourceAnchor;
  // The editor's only anchor; a Radix trigger would register a second one and strand the editor in a corner.
  const chipId = useId();
  const pencilRef = useRef<HTMLButtonElement>(null);
  // Set when a click or focus outside closes the editor: the focus then stays where the engineer put it.
  const interactedOutsideRef = useRef(false);
  const virtualAnchor = useMemo(() => commentEditorAnchor(chipId, sourceAnchor), [chipId, sourceAnchor]);

  // A fresh editor starts from the saved comment.
  useEffect(() => {
    if (!open) draftRef.current = null;
  }, [open]);

  // Closing by clicking away keeps a changed comment, unless it is too long to keep.
  const settleDraft = (): boolean => {
    const draft = draftRef.current;
    if (draft === null || draft.trim() === (citation.comment ?? "").trim()) return true;
    if (draft.length > CITATION_MAX_COMMENT_LENGTH) return false;
    commentEditor?.onSave(trimmedComment(draft));
    return true;
  };

  // The quoted text is marked while its comment is written.
  const currentCitation = useEffectEvent(() => citation);
  // Only an editor under the quote depends on it; one opened from the pencil sits by the chip.
  const onSourceUnavailable = useEffectEvent(() => {
    if (sourceAnchor === undefined) return;
    if (settleDraft()) commentEditor?.onOpenChange(false);
    else setLostAnchor(sourceAnchor);
  });
  useEffect(() => {
    if (!open) return;
    const cited = currentCitation();
    let anchor = sourceAnchor;
    if (anchor === undefined) {
      const source = findCitationSource(document, cited);
      const range = source === null ? null : resolveCitationRange(source, cited);
      if (source === null || range === null) return;
      anchor = { source, range, viewport: document.body };
    }
    return observeCitationCommentSource({ anchor, citation: cited, onUnavailable: onSourceUnavailable });
  }, [open, sourceAnchor]);

  const commentLabel = citation.comment === undefined
    ? t("common.chat.citations.addComment")
    : t("common.chat.citations.editComment");

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        // Closing by clicking away or on the pencil again keeps a changed comment.
        if (next) commentEditor?.onOpenChange(true);
        else if (settleDraft()) commentEditor?.onOpenChange(false);
      }}
    >
      <PopoverPrimitive.Anchor virtualRef={virtualAnchor} />
      {/* Like T3 Code's citation chip: brand ink, the label underlined on hover, small actions beside it. */}
      <span
        data-citation-chip="true"
        data-citation-chip-id={chipId}
        className="inline-flex max-w-full items-center gap-0.5 rounded-md border border-[hsl(var(--brand-emphasis-border))] bg-[hsl(var(--brand-emphasis-surface))] py-0.5 pl-1.5 pr-0.5 align-middle text-xs font-medium leading-normal text-[hsl(var(--brand-emphasis))]"
      >
        <button
          type="button"
          onClick={() => { reveal(citation); }}
          aria-label={t("common.chat.citations.viewQuote", { label })}
          className="group/citation inline-flex min-w-0 items-center gap-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Quote className="size-3 shrink-0" aria-hidden />
          <span className="max-w-64 truncate underline decoration-transparent underline-offset-[0.2em] transition-colors group-hover/citation:decoration-current motion-reduce:transition-none">
            {label}
          </span>
        </button>
        {commentEditor !== undefined && (
          // A plain button, not a Radix trigger: a trigger would register itself as a second anchor.
          <button
            ref={pencilRef}
            type="button"
            aria-label={commentLabel}
            aria-haspopup="dialog"
            aria-expanded={open}
            data-citation-comment-trigger="true"
            onClick={() => {
              if (!open) commentEditor.onOpenChange(true);
              else if (settleDraft()) commentEditor.onOpenChange(false);
            }}
            className="ml-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm opacity-80 transition-colors hover:bg-[hsl(var(--brand-emphasis)/0.17)] hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <Pencil className="size-3" aria-hidden />
          </button>
        )}
        {onRemove !== undefined && (
          <button
            type="button"
            aria-label={t("common.chat.citations.remove")}
            onClick={onRemove}
            className="flex size-4 shrink-0 items-center justify-center rounded-sm opacity-80 transition-colors hover:bg-[hsl(var(--brand-emphasis)/0.17)] hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <X className="size-3" aria-hidden />
          </button>
        )}
      </span>
      {commentEditor !== undefined && (
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            side={sourceAnchor === undefined ? "top" : "bottom"}
            align="end"
            sideOffset={6}
            collisionPadding={8}
            aria-label={t("common.chat.citations.editComment")}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              interactedOutsideRef.current = false;
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              // Back to the composer, unless the engineer already moved on: clicked away (perhaps starting a new
              // selection in an answer) or focused something else.
              if (interactedOutsideRef.current) {
                interactedOutsideRef.current = false;
                return;
              }
              const active = document.activeElement;
              if (active !== null && active !== document.body) return;
              commentEditor.restoreFocusRef?.current?.focus({ preventScroll: true });
            }}
            onEscapeKeyDown={(event) => {
              event.preventDefault();
              // Escape that closes an input method's candidates is not meant for the editor.
              if (event.isComposing || event.keyCode === 229) return;
              commentEditor.onCancel();
            }}
            onInteractOutside={(event) => {
              // The pencil toggles the editor itself; a comment too long to keep holds the editor open.
              const target = event.target instanceof Node ? event.target : null;
              const onPencil = target !== null && pencilRef.current?.contains(target) === true;
              if (onPencil || (draftRef.current?.length ?? 0) > CITATION_MAX_COMMENT_LENGTH) event.preventDefault();
              else interactedOutsideRef.current = true;
            }}
            className="z-50 w-[min(26rem,calc(100vw-1rem))] rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-lg outline-none"
          >
            <CitationCommentEditor
              initialComment={citation.comment}
              onDraftChange={(comment) => { draftRef.current = comment; }}
              onCancel={commentEditor.onCancel}
              onSave={(comment) => {
                commentEditor.onSave(trimmedComment(comment));
                commentEditor.onOpenChange(false);
              }}
              {...(commentEditor.onSaveAndSend === undefined
                ? {}
                : {
                    onSaveAndSend: (comment: string) => {
                      if (commentEditor.onSaveAndSend?.(trimmedComment(comment)) === true) commentEditor.onOpenChange(false);
                    },
                  })}
            />
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      )}
    </PopoverPrimitive.Root>
  );
}

const flat = (text: string) => text.replace(/\s+/g, " ");

/**
 * A citation in a sent message, as in T3 Code: a card with the quote marked inside the text around it, clamped to two
 * lines. Clicking it goes to the source. The comment follows as text.
 */
export function CitationCard({ citation, leading, trailing }: { citation: AssistantCitation; leading: boolean; trailing: boolean }) {
  const { t } = useTranslation();
  const reveal = useRevealCitation();
  const wholeAnswer = citation.prefix === "" && citation.suffix === "";
  return (
    <span className={`block whitespace-normal ${leading ? "" : "mt-[0.65rem]"} ${trailing ? "" : "mb-[0.65rem]"}`}>
      <button
        type="button"
        onClick={() => { reveal(citation); }}
        aria-label={t("common.chat.citations.goToQuote", { label: citationLabel({ ...citation, comment: undefined }) })}
        className="block w-full min-w-0 break-words rounded-lg bg-black/10 px-2.5 py-1.5 text-start text-sm text-muted-foreground transition-colors hover:bg-black/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 dark:bg-black/35 dark:hover:bg-black/50"
      >
        <span className="line-clamp-2" dir="auto">
          {wholeAnswer ? flat(citation.text) : (
            <>
              {citation.prefix.length > 0 ? `…${flat(citation.prefix)}` : null}
              <mark className="rounded-sm bg-foreground/[0.12] px-0.5 text-foreground">{flat(citation.text)}</mark>
              {citation.suffix.length > 0 ? `${flat(citation.suffix)}…` : null}
            </>
          )}
        </span>
      </button>
      {citation.comment !== undefined && (
        <span className="mt-1.5 block whitespace-pre-wrap" dir="auto">{citation.comment}</span>
      )}
    </span>
  );
}
