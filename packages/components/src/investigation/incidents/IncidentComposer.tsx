import { useCallback } from "react";
import { Composer, type ComposerProps } from "../../chat/Composer";
import { withCitationComment, type AssistantCitation } from "../../chat/citations";
import { useIncidentDraftStore } from "./incidentDraftStore";

const NO_CITATIONS: AssistantCitation[] = [];

/** The composer bound to one incident's draft and quotes; keystrokes stay inside this component. */
export function IncidentComposer({
  incidentId,
  ...props
}: Omit<ComposerProps, "prompt" | "onPromptChange" | "citations" | "onRemoveCitation" | "onCitationCommentChange"> & { incidentId: string }) {
  const prompt = useIncidentDraftStore((state) => state.drafts[incidentId] ?? "");
  const citations = useIncidentDraftStore((state) => state.citations[incidentId] ?? NO_CITATIONS);
  const setDraft = useIncidentDraftStore((state) => state.setDraft);
  const setCitations = useIncidentDraftStore((state) => state.setCitations);
  const onPromptChange = useCallback((text: string) => { setDraft(incidentId, text); }, [incidentId, setDraft]);
  const onRemoveCitation = useCallback((index: number) => {
    setCitations(incidentId, citations.filter((_, position) => position !== index));
  }, [citations, incidentId, setCitations]);
  const onCitationCommentChange = useCallback((index: number, comment: string | undefined) => {
    setCitations(incidentId, citations.map((citation, position) => (position === index ? withCitationComment(citation, comment) : citation)));
  }, [citations, incidentId, setCitations]);
  return (
    <Composer
      {...props}
      prompt={prompt}
      onPromptChange={onPromptChange}
      citations={citations}
      onRemoveCitation={onRemoveCitation}
      onCitationCommentChange={onCitationCommentChange}
    />
  );
}
