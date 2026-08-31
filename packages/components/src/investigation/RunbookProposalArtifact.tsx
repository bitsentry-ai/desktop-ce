import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, RotateCcw, X } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";

import type {
  AgentServicePort,
  RunbookAuthoringProposalReview,
} from "../services/contracts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

function messageForError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusLabel(status: RunbookAuthoringProposalReview["status"]): string {
  return status.replaceAll("_", " ");
}

function RunbookProposalOperation({
  diff,
  checked,
  disabled,
  onToggle,
}: {
  diff: RunbookAuthoringProposalReview["operationDiffs"][number];
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();

  return (
    <label className="flex gap-2 rounded-xl border border-border px-3 py-2">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        aria-label={t("common.incidentArtifactsRail.proposal.approveOperation", {
          type: diff.type,
        })}
        className="mt-1"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{diff.rationale}</span>
        <span className="block text-xs text-muted-foreground">{diff.type}</span>
      </span>
    </label>
  );
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
  const { t } = useTranslation();

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
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">
            {proposal.proposedRunbook.title}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("common.incidentArtifactsRail.proposal.versionSummary", {
              version: proposal.artifactVersion,
            })}
            {proposal.isLatest
              ? t("common.incidentArtifactsRail.proposal.latestSuffix")
              : ""}
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-center text-[10px] capitalize text-muted-foreground">
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
  const { t } = useTranslation();
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
  const supportsOperationApproval =
    selectedProposal.supportsOperationApproval ??
    (selectedProposal.kind === "edit_existing_runbook" ||
      selectedProposal.parentProposalId !== undefined);
  const toggleOperation = (operationId: string) => {
    setSelectedOperationIds((current) =>
      current.includes(operationId)
        ? current.filter((id) => id !== operationId)
        : [...current, operationId],
    );
  };
  const riskLabels = [
    ...new Set(
      selectedProposal.operationDiffs.flatMap((diff) => diff.riskLabels),
    ),
  ];

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-background">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Select
          value={selectedProposal.proposalId}
          onValueChange={onSelect}
        >
          <SelectTrigger
            aria-label={t("common.incidentArtifactsRail.proposal.artifactVersion")}
            className="h-8 w-auto max-w-full shrink-0 rounded-lg border-border bg-muted/30 px-2 py-1 text-xs font-medium"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {history.map((proposal) => (
              <SelectItem key={proposal.proposalId} value={proposal.proposalId}>
                {t("common.incidentArtifactsRail.proposal.versionOption", {
                  version: proposal.artifactVersion,
                })}
                {proposal.isLatest
                  ? t("common.incidentArtifactsRail.proposal.latestSuffix")
                  : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {selectedProposal.kind === "create_new_runbook"
            ? t("common.incidentArtifactsRail.proposal.newRunbook")
            : t("common.incidentArtifactsRail.proposal.runbookUpdate")}
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
            <RotateCcw size={12} />
            {t("common.incidentArtifactsRail.proposal.restore")}
          </button>
        )}
      </div>

      <div className="min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <div>
          <div className="text-lg font-semibold text-foreground">
            {selectedProposal.proposedRunbook.title}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {selectedProposal.proposedRunbook.description ||
              t("common.incidentArtifactsRail.proposal.noDescription")}
          </p>
        </div>

        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {t("common.incidentArtifactsRail.proposal.steps")}
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
            {t("common.incidentArtifactsRail.proposal.proposedChanges")}
          </div>
          <div className="space-y-2">
            {selectedProposal.operationDiffs.map((diff) => (
              <RunbookProposalOperation
                key={diff.operationId}
                diff={diff}
                checked={selectedOperationIds.includes(diff.operationId)}
                disabled={!canDecide || !supportsOperationApproval}
                onToggle={() => toggleOperation(diff.operationId)}
              />
            ))}
          </div>
        </div>

        {(riskLabels.length > 0 || !selectedProposal.validation.valid) && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
            <div className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-300">
              <AlertCircle size={13} />
              {t("common.incidentArtifactsRail.proposal.reviewNotes")}
            </div>
            {riskLabels.length > 0 && (
              <div className="mt-1">
                {t("common.incidentArtifactsRail.proposal.risks", {
                  risks: riskLabels.join(", "),
                })}
              </div>
            )}
            {selectedProposal.validation.errors.map((validationError) => (
              <div key={validationError} className="mt-1">{validationError}</div>
            ))}
          </div>
        )}

        <details className="min-w-0 w-full rounded-xl border border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
            {t("common.incidentArtifactsRail.proposal.rawJson")}
          </summary>
          <pre className="min-w-0 max-w-full max-h-72 overflow-x-hidden overflow-y-auto border-t border-border p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-all">
            {JSON.stringify(selectedProposal, null, 2)}
          </pre>
        </details>

        {canDecide && (
          <div className="space-y-2 border-t border-border pt-4">
            <textarea
              value={revisionDraft}
              onChange={(event) => setRevisionDraft(event.target.value)}
              placeholder={t(
                "common.incidentArtifactsRail.proposal.revisionPlaceholder",
              )}
              className="min-h-20 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || (supportsOperationApproval && selectedOperationIds.length === 0)}
                onClick={() => void runDecision(async () => {
                  await agent.approveRunbookAuthoringProposal({
                    sessionId,
                    incidentThreadId: incidentId,
                    proposalId: selectedProposal.proposalId,
                    approvedOperationIds: supportsOperationApproval
                      ? selectedOperationIds
                      : undefined,
                  });
                })}
                className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                <Check size={13} />
                {t("common.incidentArtifactsRail.proposal.approve")}
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
                {t("common.incidentArtifactsRail.proposal.reviseInChat")}
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
                <X size={13} />
                {t("common.incidentArtifactsRail.proposal.reject")}
              </button>
            </div>
          </div>
        )}

        {error.length > 0 && <div className="text-xs text-red-600">{error}</div>}
      </div>
    </div>
  );
}
