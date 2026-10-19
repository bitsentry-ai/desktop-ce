import { useCallback, useEffect, useState } from "react";
import { Ban, Check, RefreshCw } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { ChatMessage, ToolCallCard } from "../../chat/types";
import type {
  AgentServicePort,
  RunbookAuthoringProposalReview,
} from "../../services/contracts";
import { errorMessage } from "./incidentDesktopApi";

export function parseRunbookAuthoringProposal(
  toolCall: ToolCallCard,
): RunbookAuthoringProposalReview | null {
  if (
    toolCall.state !== "done" ||
    (toolCall.toolName !== "propose_runbook_edit" &&
      toolCall.toolName !== "propose_runbook_create") ||
    typeof toolCall.output !== "string" ||
    toolCall.output.trim().length === 0
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(toolCall.output) as Partial<RunbookAuthoringProposalReview>;
    if (
      typeof parsed.proposalId !== "string" ||
      typeof parsed.status !== "string" ||
      typeof parsed.kind !== "string" ||
      parsed.proposedRunbook === undefined ||
      !Array.isArray(parsed.operationDiffs)
    ) {
      return null;
    }

    return parsed as RunbookAuthoringProposalReview;
  } catch {
    return null;
  }
}

export function getRunbookAuthoringProposalsFromMessage(
  message: ChatMessage,
): RunbookAuthoringProposalReview[] {
  if (message.kind !== "agent") return [];

  return message.toolCalls
    .map((toolCall) => parseRunbookAuthoringProposal(toolCall))
    .filter((proposal): proposal is RunbookAuthoringProposalReview => proposal !== null);
}

export function OperationDiffApprovalCheckbox({
  proposalId,
  operationIds,
  operationId,
  operationType,
  selected,
  onToggle,
}: {
  proposalId: string;
  operationIds: string[];
  operationId: string;
  operationType: string;
  selected: boolean;
  onToggle: (proposalId: string, operationIds: string[], operationId: string) => void;
}) {
  return (
    <input
      type="checkbox"
      checked={selected}
      onClick={(event) => event.stopPropagation()}
      onChange={() => onToggle(proposalId, operationIds, operationId)}
      aria-label={`Approve ${operationType}`}
      className="mr-2 align-middle"
    />
  );
}

function withSavedTitle(proposalId: string, title: string) {
  return (previous: Record<string, string>) => ({ ...previous, [proposalId]: title });
}

export function RunbookAuthoringProposalCards({
  agent,
  incidentId,
  sessionId,
  message,
  onRevisionRequested,
}: {
  agent: AgentServicePort;
  incidentId: string;
  sessionId: string | null;
  message: ChatMessage;
  onRevisionRequested: (requestedEdit: string) => void;
}) {
  const { t } = useTranslation();
  const proposals = getRunbookAuthoringProposalsFromMessage(message);
  const [decisionStateByProposalId, setDecisionStateByProposalId] = useState<
    Record<string, RunbookAuthoringProposalReview>
  >({});
  const [pendingProposalId, setPendingProposalId] = useState<string | null>(null);
  const [revisionDraftByProposalId, setRevisionDraftByProposalId] = useState<Record<string, string>>({});
  const [errorByProposalId, setErrorByProposalId] = useState<Record<string, string>>({});
  const [savedTitleByProposalId, setSavedTitleByProposalId] = useState<Record<string, string>>({});
  const [selectedOperationIdsByProposalId, setSelectedOperationIdsByProposalId] = useState<Record<string, string[]>>({});

  const toggleSelectedOperation = useCallback((proposalId: string, operationIds: string[], operationId: string) => {
    setSelectedOperationIdsByProposalId((previous) => {
      const current = previous[proposalId] ?? operationIds;
      const next = current.includes(operationId) ? current.filter((id) => id !== operationId) : [...current, operationId];
      return { ...previous, [proposalId]: next };
    });
  }, []);

  const canDecideProposals = sessionId !== null || incidentId.length > 0;
  const decisionSessionId = sessionId ?? undefined;

  const refreshLiveProposals = useCallback(async () => {
    if (!canDecideProposals) return undefined;

    try {
      const liveProposals = await agent.listRunbookAuthoringProposals({
        sessionId: decisionSessionId,
        incidentThreadId: incidentId,
      });
      setDecisionStateByProposalId((previous) => ({
        ...previous,
        ...Object.fromEntries(
          liveProposals.map((proposal) => [proposal.proposalId, proposal]),
        ),
      }));
      return liveProposals;
    } catch {
      return undefined;
    }
  }, [agent, canDecideProposals, decisionSessionId, incidentId]);

  useEffect(() => {
    void refreshLiveProposals();
  }, [refreshLiveProposals]);

  if (proposals.length === 0) return null;

  const setDecisionProposal = (proposal: RunbookAuthoringProposalReview) => {
    setDecisionStateByProposalId((prev) => ({
      ...prev,
      [proposal.proposalId]: proposal,
    }));
  };

  const setProposalError = (proposalId: string, error: unknown) => {
    setErrorByProposalId((prev) => ({
      ...prev,
      [proposalId]: errorMessage(error),
    }));
  };

  const recoverDecidedProposal = async (
    proposalId: string,
    error: unknown,
  ) => {
    const liveProposals = await refreshLiveProposals();
    const liveProposal = liveProposals?.find(
      (proposal) => proposal.proposalId === proposalId,
    );
    if (
      liveProposal !== undefined &&
      liveProposal.status !== "pending_approval"
    ) {
      setDecisionProposal(liveProposal);
      setErrorByProposalId((previous) => ({ ...previous, [proposalId]: "" }));
      return;
    }
    setProposalError(proposalId, error);
  };

  return (
    <div className="ml-10 space-y-3">
      {proposals.map((initialProposal) => {
        const proposal =
          decisionStateByProposalId[initialProposal.proposalId] ?? initialProposal;
        const isPending = proposal.status === "pending_approval";
        const isBusy = pendingProposalId === proposal.proposalId;
        const revisionDraft = revisionDraftByProposalId[proposal.proposalId] ?? "";
        const riskLabels = [
          ...new Set(
            proposal.operationDiffs.flatMap((diff) => diff.riskLabels),
          ),
        ];
        const error = errorByProposalId[proposal.proposalId];
        const allOperationIds = proposal.operationDiffs.map((diff) => diff.operationId);
        const selectedOperationIds = selectedOperationIdsByProposalId[proposal.proposalId] ?? allOperationIds;
        const statusKey = { approved: "common.incidents.statusApproved", pending_approval: "common.incidents.statusPendingApproval", rejected: "common.incidents.statusRejected", revision_requested: "common.incidents.statusRevisionRequested" }[proposal.status];

        const handleApprove = async () => {
          if (!canDecideProposals) return;
          setPendingProposalId(proposal.proposalId);
          setErrorByProposalId((prev) => ({ ...prev, [proposal.proposalId]: "" }));
          // Promise chains, not try/finally, which the React Compiler can't lower.
          const approveProposal = async () => {
            const result = await agent.approveRunbookAuthoringProposal({
              sessionId: decisionSessionId,
              incidentThreadId: incidentId,
              proposalId: proposal.proposalId,
              approvedOperationIds: proposal.kind === "edit_existing_runbook" ? selectedOperationIds : undefined,
            });
            setDecisionProposal(result.proposal);
            if (result.savedRunbook !== undefined) {
              setSavedTitleByProposalId(withSavedTitle(proposal.proposalId, result.savedRunbook.title));
              window.dispatchEvent(
                new CustomEvent("bitsentry:runbooks-updated", {
                  detail: { runbook: result.savedRunbook },
                }),
              );
            }
            await refreshLiveProposals();
          };
          await approveProposal()
            .catch((err: unknown) => recoverDecidedProposal(proposal.proposalId, err))
            .finally(() => { setPendingProposalId(null); });
        };

        const handleReject = async () => {
          if (!canDecideProposals) return;
          setPendingProposalId(proposal.proposalId);
          setErrorByProposalId((prev) => ({ ...prev, [proposal.proposalId]: "" }));
          // Promise chains, not try/finally, which the React Compiler can't lower.
          const rejectProposal = async () => {
            const result = await agent.rejectRunbookAuthoringProposal({
              sessionId: decisionSessionId,
              incidentThreadId: incidentId,
              proposalId: proposal.proposalId,
              reason: "Rejected from incident runbook authoring review.",
            });
            setDecisionProposal(result.proposal);
            await refreshLiveProposals();
          };
          await rejectProposal()
            .catch((err: unknown) => recoverDecidedProposal(proposal.proposalId, err))
            .finally(() => { setPendingProposalId(null); });
        };

        const handleRequestRevision = async () => {
          if (!canDecideProposals || revisionDraft.trim().length === 0) return;
          const requestedEdit = revisionDraft.trim();
          setPendingProposalId(proposal.proposalId);
          setErrorByProposalId((prev) => ({ ...prev, [proposal.proposalId]: "" }));
          // Promise chains, not try/finally, which the React Compiler can't lower.
          const requestRevision = async () => {
            const result = await agent.requestRunbookAuthoringRevision({
              sessionId: decisionSessionId,
              incidentThreadId: incidentId,
              proposalId: proposal.proposalId,
              requestedEdit,
            });
            setDecisionProposal(result.proposal);
            onRevisionRequested(
              t(
                proposal.kind === "create_new_runbook"
                  ? "common.incidents.reviseNewRunbookProposal"
                  : "common.incidents.reviseExistingRunbookProposal",
                {
                  proposalId: proposal.proposalId,
                  requestedEdit,
                  targetRunbookId: proposal.targetRunbookId ?? "",
                },
              ),
            );
            await refreshLiveProposals();
          };
          await requestRevision()
            .catch((err: unknown) => recoverDecidedProposal(proposal.proposalId, err))
            .finally(() => { setPendingProposalId(null); });
        };

        return (
          <div
            key={proposal.proposalId}
            className="w-full max-w-3xl rounded-lg border border-border bg-background px-4 py-3 text-sm shadow-sm"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">
                    {proposal.kind === "create_new_runbook"
                      ? t("common.incidents.newRunbookProposal")
                      : t("common.incidents.runbookEditProposal")}
                  </span>
                  <span className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {t(statusKey)}
                  </span>
                  {proposal.saved && (
                    <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">
                      {t("common.incidents.savedAs", {
                        title:
                          savedTitleByProposalId[proposal.proposalId] ??
                          proposal.proposedRunbook.title,
                      })}
                    </span>
                  )}
                </div>
                <p className="truncate text-muted-foreground">
                  {proposal.proposedRunbook.title}
                </p>
              </div>
              {isPending && (
                <div className="flex shrink-0 flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={handleApprove}
                    disabled={isBusy || !canDecideProposals || !proposal.validation.valid || (proposal.kind === "edit_existing_runbook" && selectedOperationIds.length === 0)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-50 dark:text-emerald-300"
                  >
                    <Check size={13} />
                    {t("common.incidents.approve")}
                  </button>
                  <button
                    type="button"
                    onClick={handleReject}
                    disabled={isBusy || !canDecideProposals}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Ban size={13} />
                    {t("common.incidents.deny")}
                  </button>
                </div>
              )}
            </div>

            {riskLabels.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {riskLabels.map((riskLabel) => (
                  <span
                    key={riskLabel}
                    className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300"
                  >
                    {riskLabel.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            )}

            {(proposal.validation.errors.length > 0 ||
              proposal.validation.warnings.length > 0) && (
              <div className="mt-3 space-y-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
                {proposal.validation.errors.map((validationError) => (
                  <p key={validationError} className="text-destructive">
                    {validationError}
                  </p>
                ))}
                {proposal.validation.warnings.map((warning) => (
                  <p key={warning} className="text-muted-foreground">
                    {warning}
                  </p>
                ))}
              </div>
            )}

            <div className="mt-3 space-y-2">
              {proposal.operationDiffs.map((diff) => (
                <details
                  key={diff.operationId}
                  className="rounded-md border border-border/70 bg-muted/30 px-3 py-2"
                >
                  <summary className="cursor-pointer text-xs font-medium text-foreground">
                    {isPending && proposal.kind === "edit_existing_runbook" && (
                      <OperationDiffApprovalCheckbox
                        proposalId={proposal.proposalId}
                        operationIds={allOperationIds}
                        operationId={diff.operationId}
                        operationType={diff.type}
                        selected={selectedOperationIds.includes(diff.operationId)}
                        onToggle={toggleSelectedOperation}
                      />
                    )}
                    {diff.type.replace(/_/g, " ")}: {diff.rationale}
                  </summary>
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    <pre className="max-h-48 overflow-auto rounded bg-background p-2 text-[11px] leading-relaxed text-muted-foreground">
                      {JSON.stringify(diff.before, null, 2)}
                    </pre>
                    <pre className="max-h-48 overflow-auto rounded bg-background p-2 text-[11px] leading-relaxed text-muted-foreground">
                      {JSON.stringify(diff.after, null, 2)}
                    </pre>
                  </div>
                </details>
              ))}
            </div>

            {isPending && (
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input
                  value={revisionDraft}
                  onChange={(event) => {
                    setRevisionDraftByProposalId((prev) => ({
                      ...prev,
                      [proposal.proposalId]: event.target.value,
                    }));
                  }}
                  className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/50"
                  placeholder={t("common.incidents.suggestDifferentEdit")}
                  disabled={isBusy || !canDecideProposals}
                />
                <button
                  type="button"
                  onClick={handleRequestRevision}
                  disabled={isBusy || !canDecideProposals || revisionDraft.trim().length === 0}
                  className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-muted/60 px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw size={13} />
                  {t("common.incidents.suggest")}
                </button>
              </div>
            )}

            {error !== undefined && error.length > 0 && (
              <p className="mt-2 text-xs text-destructive">{error}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
