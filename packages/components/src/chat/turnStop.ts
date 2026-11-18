import { createContext } from "react";

/**
 * Stops the thread's running turn, when the host can. A turn that looks stalled offers it next to its label. Only that
 * row reads it, so a host passing a new function does not re-render the message list.
 */
export const TurnStopContext = createContext<(() => void) | null>(null);
