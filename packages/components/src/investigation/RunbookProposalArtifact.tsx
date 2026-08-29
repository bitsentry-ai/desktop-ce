import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, RotateCcw, X } from "lucide-react";

import type {
  AgentServicePort,
  RunbookAuthoringProposalReview,
} from "../services/contracts";

function messageForError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusLabel(status: RunbookAuthoringProposalReview["status"]): string {
  return status.replaceAll("_", " ");
}

export function RunbookProposalListItem({
  proposal,
  isSelected,
  onSelect,
}: {
  proposal: RunbookAuthoringProposalReview;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-2xl border px-3 py-3 text-left transition-colors ${
        isSelected
          ? "border-sky-400 bg-sky-500/5"
          : "border-border bg-background hover:bg-muted/40"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">
            {proposal.proposedRunbook.title}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Runbook proposal · v{proposal.artifactVersion}
            {proposal.isLatest ? " · Latest" : ""}
          </div>
        </div>
        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] capitalize text-muted-foreground">
          {statusLabel(proposal.status)}
        </span>
      </div>
    </button>
  );
}

export default function RunbookProposalArtifact({
  agent,
  incidentId,
  sessionId,
  proposals,
  selectedProposal,
  onSelect,
  onRefresh,
  onRevisionRequested,
}: {
  agent: AgentServicePort;
  incidentId: string;
  sessionId?: string;
  proposals: RunbookAuthoringProposalReview[];
  selectedProposal: RunbookAuthoringProposalReview;
  onSelect: (proposalId: string) => void;
  onRefresh: () => Promise<void>;
  onRevisionRequested?: (requestedEdit: string) => void;
}) {
  const [selectedOperationIds, setSelectedOperationIds] = useState<string[]>([]);
  const [revisionDraft, setRevisionDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const history = useMemo(
    () => proposals
      .filter((proposal) => proposal.artifactId === selectedProposal.artifactId)
      .sort((left, right) => right.artifactVersion - left.artifactVersion),
    [proposals, selectedProposal.artifactId],
  );
  const allOperationIds = useMemo(
    () => selectedProposal.operationDiffs.map((diff) => diff.operationId),
    [selectedProposal],
  );

  useEffect(() => {
    setSelectedOperationIds(allOperationIds);
    setRevisionDraft("");
    setError("");
  }, [allOperationIds, selectedProposal.proposalId]);

  const runDecision = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      await onRefresh();
    } catch (decisionError) {
      setError(messageForError(decisionError));
    } finally {
      setBusy(false);
    }
  };

  const canDecide =
    selectedProposal.isLatest &&
    selectedProposal.status === "pending_approval";
  const riskLabels = [
    ...new Set(
      selectedProposal.operationDiffs.flatMap((diff) => diff.riskLabels),
    ),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-background">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <select
          aria-label="Artifact version"
          value={selectedProposal.proposalId}
          onChange={(event) => onSelect(event.target.value)}
          className="rounded-lg border border-border bg-muted/30 px-2 py-1 text-xs font-medium"
        >
          {history.map((proposal) => (
            <option key={proposal.proposalId} value={proposal.proposalId}>
              v{proposal.artifactVersion}{proposal.isLatest ? " · Latest" : ""}
            </option>
          ))}
        </select>
        <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {selectedProposal.kind === "create_new_runbook"
            ? "New runbook"
            : "Runbook update"}
        </div>
        {!selectedProposal.isLatest && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void runDecision(async () => {
              const result = await agent.restoreRunbookAuthoringProposal({
                sessionId,
                incidentThreadId: incidentId,
                proposalId: selectedProposal.proposalId,
              });
              onSelect(result.proposal.proposalId);
            })}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            <RotateCcw size={12} /> Restore
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <div>
          <div className="text-lg font-semibold text-foreground">
            {selectedProposal.proposedRunbook.title}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {selectedProposal.proposedRunbook.description || "No description."}
          </p>
        </div>

        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Steps
          </div>
          <div className="space-y-2">
            {selectedProposal.proposedRunbook.actions.map((action, index) => (
              <div key={action.id} className="rounded-xl border border-border px-3 py-2">
                <div className="text-xs text-muted-foreground">{index + 1} · {action.type}</div>
                <div className="mt-0.5 text-sm font-medium">{action.title}</div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Proposed changes
          </div>
          <div className="space-y-2">
            {selectedProposal.operationDiffs.map((diff) => {
              const checked = selectedOperationIds.includes(diff.operationId);
              return (
                <label key={diff.operationId} className="flex gap-2 rounded-xl border border-border px-3 py-2">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!canDecide || selectedProposal.kind === "create_new_runbook"}
                    onChange={() => setSelectedOperationIds((current) =>
                      checked
                        ? current.filter((id) => id !== diff.operationId)
                        : [...current, diff.operationId],
                    )}
                    aria-label={`Approve ${diff.type}`}
                    className="mt-1"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{diff.rationale}</span>
                    <span className="block text-xs text-muted-foreground">{diff.type}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        {(riskLabels.length > 0 || !selectedProposal.validation.valid) && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
            <div className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-300">
              <AlertCircle size={13} /> Review notes
            </div>
            {riskLabels.length > 0 && <div className="mt-1">Risks: {riskLabels.join(", ")}</div>}
            {selectedProposal.validation.errors.map((validationError) => (
              <div key={validationError} className="mt-1">{validationError}</div>
            ))}
          </div>
        )}

        <details className="rounded-xl border border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium">Raw JSON</summary>
          <pre className="max-h-72 overflow-auto border-t border-border p-3 text-[11px] leading-relaxed">
            {JSON.stringify(selectedProposal, null, 2)}
          </pre>
        </details>

        {canDecide && (
          <div className="space-y-2 border-t border-border pt-4">
            <textarea
              value={revisionDraft}
              onChange={(event) => setRevisionDraft(event.target.value)}
              placeholder="Describe what the agent should revise…"
              className="min-h-20 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || (selectedProposal.kind === "edit_existing_runbook" && selectedOperationIds.length === 0)}
                onClick={() => void runDecision(async () => {
                  await agent.approveRunbookAuthoringProposal({
                    sessionId,
                    incidentThreadId: incidentId,
                    proposalId: selectedProposal.proposalId,
                    approvedOperationIds: selectedProposal.kind === "edit_existing_runbook"
                      ? selectedOperationIds
                      : undefined,
                  });
                })}
                className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                <Check size={13} /> Approve
              </button>
              <button
                type="button"
                disabled={busy || revisionDraft.trim().length === 0}
                onClick={() => void runDecision(async () => {
                  const requestedEdit = revisionDraft.trim();
                  await agent.requestRunbookAuthoringRevision({
                    sessionId,
                    incidentThreadId: incidentId,
                    proposalId: selectedProposal.proposalId,
                    requestedEdit,
                  });
                  onRevisionRequested?.(
                    `Revise runbook artifact ${selectedProposal.artifactId} from proposal ${selectedProposal.proposalId}: ${requestedEdit}. Use parentProposalId ${selectedProposal.proposalId} for the next proposal.`,
                  );
                })}
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
              >
                Revise in chat
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void runDecision(async () => {
                  await agent.rejectRunbookAuthoringProposal({
                    sessionId,
                    incidentThreadId: incidentId,
                    proposalId: selectedProposal.proposalId,
                    reason: "Rejected from the runbook artifact sidebar.",
                  });
                })}
                className="inline-flex items-center gap-1 rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-500/5 disabled:opacity-50"
              >
                <X size={13} /> Reject
              </button>
            </div>
          </div>
        )}

        {error.length > 0 && <div className="text-xs text-red-600">{error}</div>}
      </div>
    </div>
  );
}
