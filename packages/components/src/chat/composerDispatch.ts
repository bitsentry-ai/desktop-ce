/**
 * How the composer sends while the agent runs. Adapted from T3 Code
 * (https://github.com/pingdotgg/t3code, MIT): Enter queues, Ctrl/⌘ sends the
 * other way, and a turn that cannot take a steer always queues.
 */

import { useEffect, useState } from "react";
import type { AgentMessageDelivery } from "../services/contracts";

export type ComposerDispatchMode = "auto" | AgentMessageDelivery;

/** The follow-up behavior while a turn runs. T3 Code's default, and ours. */
export const ACTIVE_TURN_DEFAULT: AgentMessageDelivery = "queue";

export function resolveComposerDispatchMode(input: {
  running: boolean;
  alternateModifier: boolean;
  canSteer: boolean;
}): ComposerDispatchMode {
  if (!input.running) return "auto";
  if (!input.canSteer) return "queue";
  if (input.alternateModifier) return ACTIVE_TURN_DEFAULT === "queue" ? "steer" : "queue";
  return ACTIVE_TURN_DEFAULT;
}

/** Whether Ctrl or ⌘ is held, so the send button can show what a click would do. */
export function useShortcutModifierState(): { metaKey: boolean; ctrlKey: boolean } {
  const [state, setState] = useState({ metaKey: false, ctrlKey: false });

  useEffect(() => {
    const update = (event: KeyboardEvent) => {
      setState((previous) =>
        previous.metaKey === event.metaKey && previous.ctrlKey === event.ctrlKey
          ? previous
          : { metaKey: event.metaKey, ctrlKey: event.ctrlKey },
      );
    };
    const reset = () => { setState({ metaKey: false, ctrlKey: false }); };
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("blur", reset);
    };
  }, []);

  return state;
}
