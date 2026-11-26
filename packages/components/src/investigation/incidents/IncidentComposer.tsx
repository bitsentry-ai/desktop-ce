import { Composer, type ComposerProps } from "../../chat/Composer";
import { useIncidentCitations, useIncidentDraftStore } from "./incidentDraftStore";

/** The composer bound to one incident's draft and quotes; keystrokes stay inside this component. */
export function IncidentComposer({
  incidentId,
  ...props
}: Omit<ComposerProps, "prompt" | "onPromptChange" | "citations" | "onRemoveCitation" | "onCitationCommentChange" | "citationCommentEditor"> & { incidentId: string }) {
  const prompt = useIncidentDraftStore((state) => state.drafts[incidentId] ?? "");
  const setDraft = useIncidentDraftStore((state) => state.setDraft);
  const citations = useIncidentCitations(incidentId);
  const onPromptChange = (text: string) => { setDraft(incidentId, text); };
  return <Composer {...props} prompt={prompt} onPromptChange={onPromptChange} {...citations} />;
}
