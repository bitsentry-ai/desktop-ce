import { create } from "zustand";

interface IncidentDraftStore {
  /** The unsent composer text per incident. In memory only, like the composer state it replaces. */
  drafts: Record<string, string>;
  setDraft: (incidentId: string, text: string) => void;
  clearDraft: (incidentId: string) => void;
}

/** Keeps composer drafts out of the incidents page, so typing re-renders only the composer. */
export const useIncidentDraftStore = create<IncidentDraftStore>()((set) => ({
  drafts: {},
  setDraft: (incidentId, text) => {
    set((state) => (state.drafts[incidentId] === text ? state : { drafts: { ...state.drafts, [incidentId]: text } }));
  },
  clearDraft: (incidentId) => {
    set((state) => {
      if (!(incidentId in state.drafts)) return state;
      return { drafts: Object.fromEntries(Object.entries(state.drafts).filter(([id]) => id !== incidentId)) };
    });
  },
}));
