import { useCallback } from "react";
import { Composer, type ComposerProps } from "../../chat/Composer";
import { useIncidentDraftStore } from "./incidentDraftStore";

/** The composer bound to one incident's draft; keystrokes stay inside this component. */
export function IncidentComposer({
  incidentId,
  ...props
}: Omit<ComposerProps, "prompt" | "onPromptChange"> & { incidentId: string }) {
  const prompt = useIncidentDraftStore((state) => state.drafts[incidentId] ?? "");
  const setDraft = useIncidentDraftStore((state) => state.setDraft);
  const onPromptChange = useCallback((text: string) => { setDraft(incidentId, text); }, [incidentId, setDraft]);
  return <Composer {...props} prompt={prompt} onPromptChange={onPromptChange} />;
}
