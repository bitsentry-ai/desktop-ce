import { create } from "zustand";

interface DisclosureStore {
  /** Open state per disclosure key. In memory only, so it lasts for the session. */
  open: Record<string, boolean>;
  set: (key: string, value: boolean) => void;
}

/**
 * Keeps chat disclosure state outside the rows. The message list is virtualized, so a row unmounts when it scrolls
 * out of the render window; its expanded sections must survive that.
 */
const useDisclosureStore = create<DisclosureStore>()((set) => ({
  open: {},
  set: (key, value) => {
    set((state) => (state.open[key] === value ? state : { open: { ...state.open, [key]: value } }));
  },
}));

/** The open state of one disclosure, keyed by a stable id such as `${messageId}:${toolCallId}:details`. */
export function useDisclosure(key: string, defaultOpen: boolean): [boolean, (next: boolean) => void] {
  const isOpen = useDisclosureStore((state) => state.open[key] ?? defaultOpen);
  const setOpen = useDisclosureStore((state) => state.set);
  return [isOpen, (next: boolean) => { setOpen(key, next); }];
}
