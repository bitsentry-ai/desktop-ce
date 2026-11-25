import { create } from "zustand";
import type { CitationCommentEditorState } from "../../chat/CitationControls";
import type { CitationSourceAnchor } from "../../chat/citationDom";
import { joinCitations, separateCitations, withCitationComment, type AssistantCitation } from "../../chat/citations";

/** The citation whose comment editor is open in an incident's composer. */
interface OpenCitationComment {
  index: number;
  /** Set right after Cite: the editor opens under the quoted text, and Cancel drops the citation. */
  sourceAnchor?: CitationSourceAnchor;
}

interface IncidentDraftStore {
  /** The unsent composer text per incident. In memory only, like the composer state it replaces. */
  drafts: Record<string, string>;
  /** Quotes from the incident's agent answers, sent ahead of the draft. A quote belongs to its own incident. */
  citations: Record<string, AssistantCitation[]>;
  /** The open citation comment editor per incident. */
  openComments: Record<string, OpenCitationComment>;
  setDraft: (incidentId: string, text: string) => void;
  clearDraft: (incidentId: string) => void;
  setCitations: (incidentId: string, citations: AssistantCitation[]) => void;
  setOpenComment: (incidentId: string, openComment: OpenCitationComment | null) => void;
  /** Puts a whole message back in the composer: its citations as chips, and the rest as the draft. */
  setComposedDraft: (incidentId: string, text: string) => void;
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));
}

/** Keeps composer drafts out of the incidents page, so typing re-renders only the composer. */
export const useIncidentDraftStore = create<IncidentDraftStore>()((set) => ({
  drafts: {},
  citations: {},
  openComments: {},
  setDraft: (incidentId, text) => {
    set((state) => (state.drafts[incidentId] === text ? state : { drafts: { ...state.drafts, [incidentId]: text } }));
  },
  clearDraft: (incidentId) => {
    set((state) => {
      if (!(incidentId in state.drafts) && !(incidentId in state.citations) && !(incidentId in state.openComments)) return state;
      return {
        drafts: withoutKey(state.drafts, incidentId),
        citations: withoutKey(state.citations, incidentId),
        openComments: withoutKey(state.openComments, incidentId),
      };
    });
  },
  setCitations: (incidentId, citations) => {
    set((state) => {
      const openComment = state.openComments[incidentId] as OpenCitationComment | undefined;
      // An editor whose citation is gone closes.
      const keepsComment = openComment !== undefined && openComment.index < citations.length;
      return {
        citations: citations.length === 0 ? withoutKey(state.citations, incidentId) : { ...state.citations, [incidentId]: citations },
        openComments: keepsComment || openComment === undefined ? state.openComments : withoutKey(state.openComments, incidentId),
      };
    });
  },
  setOpenComment: (incidentId, openComment) => {
    set((state) => ({
      openComments: openComment === null ? withoutKey(state.openComments, incidentId) : { ...state.openComments, [incidentId]: openComment },
    }));
  },
  setComposedDraft: (incidentId, text) => {
    const separated = separateCitations(text);
    set((state) => ({
      drafts: separated.prompt === "" ? withoutKey(state.drafts, incidentId) : { ...state.drafts, [incidentId]: separated.prompt },
      citations: separated.citations.length === 0
        ? withoutKey(state.citations, incidentId)
        : { ...state.citations, [incidentId]: separated.citations },
      openComments: withoutKey(state.openComments, incidentId),
    }));
  },
}));

/** The message the composer would send for an incident: its citations, then the draft. */
export function readComposedDraft(incidentId: string): string {
  const state = useIncidentDraftStore.getState();
  return joinCitations(state.citations[incidentId] ?? [], state.drafts[incidentId] ?? "");
}

/**
 * Adds a quote to an incident's composer, after the ones already there, and opens its comment under the quote. Citing
 * the same text again opens the existing chip's comment instead of adding a copy.
 */
export function addIncidentCitation(incidentId: string, citation: AssistantCitation, sourceAnchor?: CitationSourceAnchor): void {
  const state = useIncidentDraftStore.getState();
  const existing = state.citations[incidentId] ?? [];
  const same = existing.findIndex((quote) =>
    quote.sourceId === citation.sourceId && quote.start === citation.start && quote.end === citation.end);
  if (same !== -1) {
    state.setOpenComment(incidentId, { index: same });
    return;
  }
  const citations = [...existing, citation];
  state.setCitations(incidentId, citations);
  state.setOpenComment(incidentId, { index: citations.length - 1, ...(sourceAnchor === undefined ? {} : { sourceAnchor }) });
}

const NO_CITATIONS: AssistantCitation[] = [];

/** An incident's quotes and the composer callbacks that remove one, change its comment, or open its comment editor. */
export function useIncidentCitations(incidentId: string): {
  citations: AssistantCitation[];
  onRemoveCitation: (index: number) => void;
  onCitationCommentChange: (index: number, comment: string | undefined) => void;
  citationCommentEditor: (index: number) => Omit<CitationCommentEditorState, "onSave" | "onSaveAndSend" | "restoreFocusRef">;
} {
  const citations = useIncidentDraftStore((state) => state.citations[incidentId] ?? NO_CITATIONS);
  const openComment = useIncidentDraftStore((state) => state.openComments[incidentId] as OpenCitationComment | undefined);
  const setCitations = useIncidentDraftStore((state) => state.setCitations);
  const setOpenComment = useIncidentDraftStore((state) => state.setOpenComment);
  const remove = (index: number) => {
    const current = useIncidentDraftStore.getState().citations[incidentId] ?? NO_CITATIONS;
    const open = useIncidentDraftStore.getState().openComments[incidentId] as OpenCitationComment | undefined;
    setCitations(incidentId, current.filter((_, position) => position !== index));
    // The open editor follows its citation to its new place, or closes with it.
    if (open !== undefined) setOpenComment(incidentId, open.index === index ? null : { ...open, index: open.index > index ? open.index - 1 : open.index });
  };
  return {
    citations,
    onRemoveCitation: remove,
    onCitationCommentChange: (index, comment) => {
      const current = useIncidentDraftStore.getState().citations[incidentId] ?? NO_CITATIONS;
      setCitations(incidentId, current.map((citation, position) => (position === index ? withCitationComment(citation, comment) : citation)));
    },
    citationCommentEditor: (index) => {
      const open = openComment?.index === index ? openComment : undefined;
      return {
        open: open !== undefined,
        ...(open?.sourceAnchor === undefined ? {} : { sourceAnchor: open.sourceAnchor }),
        onOpenChange: (next) => {
          const current = useIncidentDraftStore.getState().openComments[incidentId] as OpenCitationComment | undefined;
          if (next) setOpenComment(incidentId, { index });
          else if (current?.index === index) setOpenComment(incidentId, null);
        },
        onCancel: () => {
          const current = useIncidentDraftStore.getState().openComments[incidentId] as OpenCitationComment | undefined;
          // Cancel takes back a Cite pressed a moment ago, as in T3 Code.
          if (current?.index === index && current.sourceAnchor !== undefined) remove(index);
          else if (current?.index === index) setOpenComment(incidentId, null);
        },
      };
    },
  };
}
