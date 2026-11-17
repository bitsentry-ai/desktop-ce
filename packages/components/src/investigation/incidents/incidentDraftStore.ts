import { create } from "zustand";
import { joinCitations, separateCitations, withCitationComment, type AssistantCitation } from "../../chat/citations";

interface IncidentDraftStore {
  /** The unsent composer text per incident. In memory only, like the composer state it replaces. */
  drafts: Record<string, string>;
  /** Quotes from the incident's agent answers, sent ahead of the draft. A quote belongs to its own incident. */
  citations: Record<string, AssistantCitation[]>;
  setDraft: (incidentId: string, text: string) => void;
  clearDraft: (incidentId: string) => void;
  setCitations: (incidentId: string, citations: AssistantCitation[]) => void;
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
  setDraft: (incidentId, text) => {
    set((state) => (state.drafts[incidentId] === text ? state : { drafts: { ...state.drafts, [incidentId]: text } }));
  },
  clearDraft: (incidentId) => {
    set((state) => {
      if (!(incidentId in state.drafts) && !(incidentId in state.citations)) return state;
      return { drafts: withoutKey(state.drafts, incidentId), citations: withoutKey(state.citations, incidentId) };
    });
  },
  setCitations: (incidentId, citations) => {
    set((state) => ({
      citations: citations.length === 0 ? withoutKey(state.citations, incidentId) : { ...state.citations, [incidentId]: citations },
    }));
  },
  setComposedDraft: (incidentId, text) => {
    const separated = separateCitations(text);
    set((state) => ({
      drafts: separated.prompt === "" ? withoutKey(state.drafts, incidentId) : { ...state.drafts, [incidentId]: separated.prompt },
      citations: separated.citations.length === 0
        ? withoutKey(state.citations, incidentId)
        : { ...state.citations, [incidentId]: separated.citations },
    }));
  },
}));

/** The message the composer would send for an incident: its citations, then the draft. */
export function readComposedDraft(incidentId: string): string {
  const state = useIncidentDraftStore.getState();
  return joinCitations(state.citations[incidentId] ?? [], state.drafts[incidentId] ?? "");
}

/** Adds a quote to an incident's composer, after the ones already there. */
export function addIncidentCitation(incidentId: string, citation: AssistantCitation): void {
  const state = useIncidentDraftStore.getState();
  state.setCitations(incidentId, [...(state.citations[incidentId] ?? []), citation]);
}

const NO_CITATIONS: AssistantCitation[] = [];

/** An incident's quotes and the composer callbacks that remove one or change its comment. */
export function useIncidentCitations(incidentId: string): {
  citations: AssistantCitation[];
  onRemoveCitation: (index: number) => void;
  onCitationCommentChange: (index: number, comment: string | undefined) => void;
} {
  const citations = useIncidentDraftStore((state) => state.citations[incidentId] ?? NO_CITATIONS);
  const setCitations = useIncidentDraftStore((state) => state.setCitations);
  return {
    citations,
    onRemoveCitation: (index) => {
      setCitations(incidentId, citations.filter((_, position) => position !== index));
    },
    onCitationCommentChange: (index, comment) => {
      setCitations(incidentId, citations.map((citation, position) => (position === index ? withCitationComment(citation, comment) : citation)));
    },
  };
}
