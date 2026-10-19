import type { AgentServicePort, PluginsServicePort } from "../services";

/** What an incident row in the sidebar tells the engineer, most urgent first. */
export type IncidentNavStatus = "working" | "needs-input" | "failed" | "completed";

/** How a run ended, kept until the engineer opens the incident. */
export type IncidentRunOutcome = "completed" | "failed";

/** Fired after the engineer decides something an incident was waiting on, so the sidebar checks it again. */
export const INCIDENT_ATTENTION_CHANGED_EVENT = "bitsentry:incident-attention-changed";

export function notifyIncidentAttentionChanged(): void {
  window.dispatchEvent(new CustomEvent(INCIDENT_ATTENTION_CHANGED_EVENT));
}

const UNSEEN_OUTCOMES_KEY = "bitsentry_incident_unseen_outcomes";

export function readUnseenIncidentOutcomes(): Record<string, IncidentRunOutcome> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(UNSEEN_OUTCOMES_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const outcomes: Record<string, IncidentRunOutcome> = {};
    for (const [incidentId, outcome] of Object.entries(parsed)) {
      if (outcome === "completed" || outcome === "failed") outcomes[incidentId] = outcome;
    }
    return outcomes;
  } catch {
    return {};
  }
}

function writeUnseenIncidentOutcomes(outcomes: Record<string, IncidentRunOutcome>): void {
  try {
    localStorage.setItem(UNSEEN_OUTCOMES_KEY, JSON.stringify(outcomes));
  } catch {}
}

export function recordUnseenIncidentOutcome(incidentId: string, outcome: IncidentRunOutcome): void {
  writeUnseenIncidentOutcomes({ ...readUnseenIncidentOutcomes(), [incidentId]: outcome });
}

/** Forgets the outcome of an incident the engineer opened. True when there was one. */
export function clearUnseenIncidentOutcome(incidentId: string): boolean {
  const outcomes = readUnseenIncidentOutcomes();
  if (outcomes[incidentId] === undefined) return false;
  writeUnseenIncidentOutcomes(
    Object.fromEntries(Object.entries(outcomes).filter(([id]) => id !== incidentId)),
  );
  return true;
}

/** The outcome of a state change that ends a run. A cancel is the engineer's own doing, so it has none. */
export function finishedRunOutcome(
  previousState: string | undefined,
  nextState: string | undefined,
): IncidentRunOutcome | null {
  if (previousState !== "RUNNING") return null;
  if (nextState === "COMPLETED") return "completed";
  if (nextState === "FAILED") return "failed";
  return null;
}

/**
 * A running agent comes first: unlike a run that waits on an approval, our agent ends its turn before it asks the
 * engineer anything, so a question or draft only matters once the run is over.
 */
export function resolveIncidentNavStatus(input: {
  state: string | undefined;
  needsInput: boolean;
  unseenOutcome: IncidentRunOutcome | undefined;
}): IncidentNavStatus | null {
  if (input.state === "RUNNING") return "working";
  if (input.needsInput) return "needs-input";
  return input.unseenOutcome ?? null;
}

/** The incidents with a runbook draft to approve or a customer report question to answer. */
export async function findIncidentsNeedingInput(
  incidentIds: string[],
  ports: {
    agent?: Pick<AgentServicePort, "listRunbookAuthoringProposals">;
    plugins?: Pick<PluginsServicePort, "getCustomerReportIntake">;
  },
): Promise<Set<string>> {
  const { agent, plugins } = ports;
  const needsInput = await Promise.all(
    incidentIds.map(async (incidentId) => {
      const [hasPendingDraft, hasOpenQuestion] = await Promise.all([
        agent === undefined
          ? false
          : agent
              .listRunbookAuthoringProposals({ incidentThreadId: incidentId })
              .then((proposals) =>
                proposals.some((proposal) => proposal.isLatest && proposal.status === "pending_approval"),
              )
              .catch(() => false),
        plugins?.getCustomerReportIntake === undefined
          ? false
          : plugins
              .getCustomerReportIntake(incidentId)
              .then((intake) => intake?.status === "open" && intake.question !== null)
              .catch(() => false),
      ]);
      return hasPendingDraft || hasOpenQuestion;
    }),
  );
  return new Set(incidentIds.filter((_, index) => needsInput[index]));
}
