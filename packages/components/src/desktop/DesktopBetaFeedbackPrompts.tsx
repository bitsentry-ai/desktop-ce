import { useEffect, useState } from "react";
import { Button } from "@bitsentry-ce/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bitsentry-ce/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bitsentry-ce/components/ui/select";
import { Label } from "@bitsentry-ce/components/ui/label";
import { Textarea } from "@bitsentry-ce/components/ui/textarea";
import { useTranslation } from "@bitsentry-ce/i18n";

const FEEDBACK_STATE_KEY = "bitsentry.analytics.betaFeedbackState";

type CaptureDesktopAnalyticsEvent = (
  event: string,
  properties?: Record<string, unknown>,
) => void;

type PromptKind = "first_investigation" | "product_market_fit";

type FeedbackState = {
  terminalRunCount: number;
  seenExecutionIds: string[];
  firstInvestigationPromptResolved: boolean;
  productMarketFitPromptResolved: boolean;
};

type RunbookTerminalAnalyticsDetail = {
  execution_id?: string;
  runbook_id?: string;
  status?: string;
  runbook_action_count?: number;
  has_shell_step?: boolean;
  has_ai_step?: boolean;
  has_http_step?: boolean;
  has_plugin_step?: boolean;
  has_external_source_step?: boolean;
  run_duration_ms?: number;
};

type FeedbackPromptProperties = {
  feedback_prompt: PromptKind;
  execution_id?: string;
  runbook_id?: string;
  runbook_action_count?: number;
  run_duration_ms?: number;
  has_shell_step?: boolean;
  has_ai_step?: boolean;
  has_http_step?: boolean;
  has_plugin_step?: boolean;
  has_external_source_step?: boolean;
};

type FeedbackSubmissionProperties = FeedbackPromptProperties & {
  diagnosis_use_case?: string;
  outcome?: string;
  disappointment?: string;
  missing_feedback?: string;
  missing_feedback_length?: number;
};

const DEFAULT_FEEDBACK_STATE: FeedbackState = {
  terminalRunCount: 0,
  seenExecutionIds: [],
  firstInvestigationPromptResolved: false,
  productMarketFitPromptResolved: false,
};

const DIAGNOSIS_OPTIONS = [
  {
    value: "production_incident",
    labelKey: "common.desktopBetaFeedbackPrompts.diagnosisProductionIncident",
  },
  {
    value: "local_dev_issue",
    labelKey: "common.desktopBetaFeedbackPrompts.diagnosisLocalDevIssue",
  },
  {
    value: "server_health_check",
    labelKey: "common.desktopBetaFeedbackPrompts.diagnosisServerHealthCheck",
  },
  {
    value: "log_investigation",
    labelKey: "common.desktopBetaFeedbackPrompts.diagnosisLogInvestigation",
  },
  {
    value: "deployment_issue",
    labelKey: "common.desktopBetaFeedbackPrompts.diagnosisDeploymentIssue",
  },
  {
    value: "database_issue",
    labelKey: "common.desktopBetaFeedbackPrompts.diagnosisDatabaseIssue",
  },
  {
    value: "queue_job_issue",
    labelKey: "common.desktopBetaFeedbackPrompts.diagnosisQueueJobIssue",
  },
  {
    value: "just_testing",
    labelKey: "common.desktopBetaFeedbackPrompts.diagnosisJustTesting",
  },
] as const;

const OUTCOME_OPTIONS = [
  {
    value: "found_issue",
    labelKey: "common.desktopBetaFeedbackPrompts.outcomeFoundIssue",
  },
  {
    value: "somewhat",
    labelKey: "common.desktopBetaFeedbackPrompts.outcomeSomewhat",
  },
  { value: "no", labelKey: "common.desktopBetaFeedbackPrompts.outcomeNo" },
  {
    value: "just_testing",
    labelKey: "common.desktopBetaFeedbackPrompts.outcomeJustTesting",
  },
] as const;

const DISAPPOINTMENT_OPTIONS = [
  {
    value: "very_disappointed",
    labelKey: "common.desktopBetaFeedbackPrompts.disappointmentVery",
  },
  {
    value: "somewhat_disappointed",
    labelKey: "common.desktopBetaFeedbackPrompts.disappointmentSomewhat",
  },
  {
    value: "not_disappointed",
    labelKey: "common.desktopBetaFeedbackPrompts.disappointmentNot",
  },
  {
    value: "dont_know_yet",
    labelKey: "common.desktopBetaFeedbackPrompts.disappointmentDontKnowYet",
  },
] as const;

function readString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readBooleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function readFeedbackStateFromJson(value: unknown): FeedbackState {
  const record = readRecord(value);
  if (record === undefined) return DEFAULT_FEEDBACK_STATE;

  return {
    terminalRunCount:
      readNumber(record.terminalRunCount) ??
      DEFAULT_FEEDBACK_STATE.terminalRunCount,
    seenExecutionIds: readStringArray(record.seenExecutionIds),
    firstInvestigationPromptResolved: readBooleanValue(
      record.firstInvestigationPromptResolved,
      DEFAULT_FEEDBACK_STATE.firstInvestigationPromptResolved,
    ),
    productMarketFitPromptResolved: readBooleanValue(
      record.productMarketFitPromptResolved,
      DEFAULT_FEEDBACK_STATE.productMarketFitPromptResolved,
    ),
  };
}

function readFeedbackState(): FeedbackState {
  try {
    const raw = window.localStorage.getItem(FEEDBACK_STATE_KEY);
    if (raw === null || raw.length === 0) return DEFAULT_FEEDBACK_STATE;
    return readFeedbackStateFromJson(JSON.parse(raw));
  } catch {
    return DEFAULT_FEEDBACK_STATE;
  }
}

function writeFeedbackState(state: FeedbackState): void {
  try {
    window.localStorage.setItem(FEEDBACK_STATE_KEY, JSON.stringify(state));
  } catch {}
}

function markPromptResolved(kind: PromptKind): void {
  const state = readFeedbackState();
  writeFeedbackState({
    ...state,
    firstInvestigationPromptResolved:
      state.firstInvestigationPromptResolved || kind === "first_investigation",
    productMarketFitPromptResolved:
      state.productMarketFitPromptResolved || kind === "product_market_fit",
  });
}

function updateStateForExecution(detail: RunbookTerminalAnalyticsDetail): FeedbackState {
  const state = readFeedbackState();
  const executionId = detail.execution_id;
  if (
    executionId !== undefined &&
    state.seenExecutionIds.includes(executionId)
  ) {
    return state;
  }

  let seenExecutionIds = state.seenExecutionIds;
  if (executionId !== undefined) {
    seenExecutionIds = [executionId, ...state.seenExecutionIds].slice(0, 50);
  }

  const nextState = {
    ...state,
    terminalRunCount: state.terminalRunCount + 1,
    seenExecutionIds,
  };
  writeFeedbackState(nextState);
  return nextState;
}

function sharedPromptProperties(
  kind: PromptKind,
  detail: RunbookTerminalAnalyticsDetail | null,
): FeedbackPromptProperties {
  const properties: FeedbackPromptProperties = {
    feedback_prompt: kind,
  };
  if (detail === null) return properties;
  properties.execution_id = detail.execution_id;
  properties.runbook_id = detail.runbook_id;
  properties.runbook_action_count = detail.runbook_action_count;
  properties.run_duration_ms = detail.run_duration_ms;
  properties.has_shell_step = detail.has_shell_step;
  properties.has_ai_step = detail.has_ai_step;
  properties.has_http_step = detail.has_http_step;
  properties.has_plugin_step = detail.has_plugin_step;
  properties.has_external_source_step = detail.has_external_source_step;
  return properties;
}

function readTerminalAnalyticsDetail(event: Event): RunbookTerminalAnalyticsDetail | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail = readRecord(event.detail);
  if (detail === undefined) return null;
  return {
    execution_id: readString(detail.execution_id),
    runbook_id: readString(detail.runbook_id),
    status: readString(detail.status),
    runbook_action_count: readNumber(detail.runbook_action_count),
    has_shell_step: readBoolean(detail.has_shell_step),
    has_ai_step: readBoolean(detail.has_ai_step),
    has_http_step: readBoolean(detail.has_http_step),
    has_plugin_step: readBoolean(detail.has_plugin_step),
    has_external_source_step: readBoolean(detail.has_external_source_step),
    run_duration_ms: readNumber(detail.run_duration_ms),
  };
}

export interface DesktopBetaFeedbackPromptsProps {
  captureDesktopAnalyticsEvent?: CaptureDesktopAnalyticsEvent;
}

export function DesktopBetaFeedbackPrompts({
  captureDesktopAnalyticsEvent = () => {},
}: DesktopBetaFeedbackPromptsProps) {
  const { t } = useTranslation();
  const [promptKind, setPromptKind] = useState<PromptKind | null>(null);
  const [promptDetail, setPromptDetail] =
    useState<RunbookTerminalAnalyticsDetail | null>(null);
  const [diagnosisUseCase, setDiagnosisUseCase] = useState("");
  const [outcome, setOutcome] = useState("");
  const [disappointment, setDisappointment] = useState("");
  const [missingFeedback, setMissingFeedback] = useState("");

  useEffect(() => {
    const handleTerminalAnalytics = (event: Event) => {
      const detail = readTerminalAnalyticsDetail(event);
      if (detail === null || detail.status !== "completed") return;

      const nextState = updateStateForExecution(detail);
      if (
        !nextState.firstInvestigationPromptResolved &&
        promptKind === null
      ) {
        setPromptKind("first_investigation");
        setPromptDetail(detail);
        captureDesktopAnalyticsEvent("feedback_prompt_shown", {
          ...sharedPromptProperties("first_investigation", detail),
        });
        return;
      }

      if (
        nextState.terminalRunCount >= 3 &&
        !nextState.productMarketFitPromptResolved &&
        promptKind === null
      ) {
        setPromptKind("product_market_fit");
        setPromptDetail(detail);
        captureDesktopAnalyticsEvent("feedback_prompt_shown", {
          ...sharedPromptProperties("product_market_fit", detail),
        });
      }
    };

    window.addEventListener(
      "bitsentry:runbook-terminal-analytics",
      handleTerminalAnalytics,
    );
    return () => {
      window.removeEventListener(
        "bitsentry:runbook-terminal-analytics",
        handleTerminalAnalytics,
      );
    };
  }, [captureDesktopAnalyticsEvent, promptKind]);

  const closePrompt = (submitted: boolean) => {
    if (promptKind === null) return;
    if (!submitted) {
      captureDesktopAnalyticsEvent("feedback_dismissed", {
        ...sharedPromptProperties(promptKind, promptDetail),
      });
    }
    markPromptResolved(promptKind);
    setPromptKind(null);
    setPromptDetail(null);
    setDiagnosisUseCase("");
    setOutcome("");
    setDisappointment("");
    setMissingFeedback("");
  };

  const submitPrompt = () => {
    if (promptKind === null) return;
    const trimmedFeedback = missingFeedback.trim();
    const properties: FeedbackSubmissionProperties = {
      ...sharedPromptProperties(promptKind, promptDetail),
      diagnosis_use_case: diagnosisUseCase,
      outcome,
      disappointment,
    };
    if (diagnosisUseCase.length === 0) {
      properties.diagnosis_use_case = undefined;
    }
    if (outcome.length === 0) {
      properties.outcome = undefined;
    }
    if (disappointment.length === 0) {
      properties.disappointment = undefined;
    }
    const firstInvestigationPayload = promptKind === "first_investigation";
    const submissionProperties: FeedbackSubmissionProperties = {
      ...properties,
    };
    if (firstInvestigationPayload) {
      submissionProperties.missing_feedback_length = trimmedFeedback.length;
      if (trimmedFeedback.length > 0) {
        submissionProperties.missing_feedback = trimmedFeedback.slice(0, 500);
      }
    }

    captureDesktopAnalyticsEvent("feedback_submitted", {
      ...submissionProperties,
    });
    closePrompt(true);
  };

  let canSubmit = disappointment.length > 0;
  if (promptKind === "first_investigation") {
    canSubmit = diagnosisUseCase.length > 0 && outcome.length > 0;
  }

  let promptBody = (
    <>
      <DialogHeader>
        <DialogTitle>
          {t("common.desktopBetaFeedbackPrompts.oneMoreSignal")}
        </DialogTitle>
        <DialogDescription>
          {t("common.desktopBetaFeedbackPrompts.repeatableValue")}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label>
          {t("common.desktopBetaFeedbackPrompts.disappointedIfGone")}
        </Label>
        <Select value={disappointment} onValueChange={setDisappointment}>
          <SelectTrigger>
            <SelectValue
              placeholder={t("common.desktopBetaFeedbackPrompts.pickOne")}
            />
          </SelectTrigger>
          <SelectContent>
            {DISAPPOINTMENT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {t(option.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
  if (promptKind === "first_investigation") {
    promptBody = (
      <>
        <DialogHeader>
          <DialogTitle>
            {t("common.desktopBetaFeedbackPrompts.quickCheck")}
          </DialogTitle>
          <DialogDescription>
            {t("common.desktopBetaFeedbackPrompts.realDebuggingOrTrialRun")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>
              {t("common.desktopBetaFeedbackPrompts.whatWereYouDiagnosing")}
            </Label>
            <Select value={diagnosisUseCase} onValueChange={setDiagnosisUseCase}>
              <SelectTrigger>
                <SelectValue
                  placeholder={t(
                    "common.desktopBetaFeedbackPrompts.pickOne",
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {DIAGNOSIS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>
              {t("common.desktopBetaFeedbackPrompts.didThisHelp")}
            </Label>
            <Select value={outcome} onValueChange={setOutcome}>
              <SelectTrigger>
                <SelectValue
                  placeholder={t(
                    "common.desktopBetaFeedbackPrompts.pickOne",
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {OUTCOME_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="desktop-beta-feedback-missing">
              {t("common.desktopBetaFeedbackPrompts.whatWasMissing")}
            </Label>
            <Textarea
              id="desktop-beta-feedback-missing"
              value={missingFeedback}
              onChange={(event) => {
                setMissingFeedback(event.target.value);
              }}
              maxLength={500}
              placeholder={t(
                "common.desktopBetaFeedbackPrompts.optionalHighLevel",
              )}
            />
          </div>
        </div>
      </>
    );
  }

  return (
    <Dialog
      open={promptKind !== null}
      onOpenChange={(open) => {
        if (!open) closePrompt(false);
      }}
    >
      <DialogContent className="max-w-md">
        {promptBody}
        <DialogFooter>
          <Button variant="ghost" onClick={() => { closePrompt(false); }}>
            {t("common.desktopBetaFeedbackPrompts.skip")}
          </Button>
          <Button onClick={submitPrompt} disabled={!canSubmit}>
            {t("common.desktopBetaFeedbackPrompts.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default DesktopBetaFeedbackPrompts;
