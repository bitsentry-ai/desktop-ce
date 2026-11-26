import type { DriveStep } from "driver.js";

export type TourId =
  | "main"
  | "incidents"
  | "runbooks"
  | "results"
  | "settings"
  | "runbookCreation"
  | "dataSources";

/**
 * A guided tour. Desktop tours use the ids in {@link TourId}; a product can define its own tours (the Dashboard does)
 * with any other id and run them through the same runner and Help section.
 */
export interface TourDefinition {
  id: string;
  label: string;
  description: string;
  steps: DriveStep[];
  /** Page path to navigate to before starting the tour. */
  route?: string;
  /** Page path to navigate to after a preview tour is dismissed. */
  returnRoute?: string;
  /**
   * Runs after navigating to `route` and before the first step, for example to open the record the steps point at.
   * It gets the router navigate function when the caller passed one.
   */
  prepare?: (navigate?: (path: string) => void) => Promise<void>;
  /**
   * Leave out steps whose target is not on the page (an empty list, a control the member cannot use) instead of
   * pointing them at the whole page. Tours over real pages set this; preview tours always have every target.
   */
  skipMissingTargets?: boolean;
}

type Translate = (
  key: string,
  options?: Record<string, string | number | boolean>,
) => string;

/** Resolve a data-tour element or fall back to document.body. */
function tourEl(attr: string): () => Element {
  return () =>
    document.querySelector(`[data-tour="${attr}"]`) ?? document.body;
}

export function getTours(t: Translate): Record<TourId, TourDefinition> {
  const mainTour: TourDefinition = {
    id: "main",
    label: t("common.tours.main.label.platformTour"),
    description: t(
      "common.tours.main.description.aQuickWalkthroughOfTheOnCallWorkspace.",
    ),
    steps: [
      {
        popover: {
          title: t("common.tours.main.title.welcomeToBitSentry"),
          description: t(
            "common.tours.main.description.bitSentryIsAnOnCallWorkspaceForResolvingProduction",
          ),
        },
      },
      {
        element: '[data-tour="nav-incidents"]',
        popover: {
          title: t("common.tours.main.title.incidents"),
          description: t(
            "common.tours.main.description.resolveALiveIncidentWithAnAIAgentDescribeWhatSHapp",
          ),
          side: "right",
          align: "start",
        },
      },
      {
        element: '[data-tour="nav-runbooks"]',
        popover: {
          title: t("common.tours.main.title.runbooks"),
          description: t(
            "common.tours.main.description.buildDeterministicRunbooksShellCommandsAIPromptsHT",
          ),
          side: "right",
          align: "start",
        },
      },
      {
        element: '[data-tour="nav-results"]',
        popover: {
          title: t("common.tours.main.title.results"),
          description: t(
            "common.tours.main.description.everyRunbookExecutionIsCapturedHereWithPerStepStat",
          ),
          side: "right",
          align: "start",
        },
      },
      {
        element: () =>
          document.querySelector('[data-tour="nav-app-settings"]') ??
          document.querySelector('[data-tour="nav-settings"]') ??
          document.querySelector('[data-tour="nav-profile"]') ??
          document.body,
        popover: {
          title: t("common.tours.main.title.settings"),
          description: t(
            "common.tours.main.description.connectLLMProvidersAttachCodePluginSources",
          ),
          side: "right",
          align: "start",
        },
      },
      {
        popover: {
          title: t("common.tours.main.title.youReAllSet"),
          description: t(
            "common.tours.main.description.replayThisTourAnytimeFromTheHelpSectionInSettings.",
          ),
        },
      },
    ],
  };

  const incidentsTour: TourDefinition = {
    id: "incidents",
    label: t("common.tours.incidents.label.incidentsTour"),
    description: t(
      "common.tours.incidents.description.learnHowToDriveAnAIAssistedIncidentResolution.",
    ),
    route: "/tour/incidents",
    steps: [
      {
        popover: {
          title: t("common.tours.incidents.title.welcomeToIncidents"),
          description: t(
            "common.tours.incidents.description.resolveAProductionIncidentWithAnAIAgentEachInciden",
          ),
        },
      },
      {
        element: tourEl("incidents-composer"),
        popover: {
          title: t("common.tours.incidents.title.messageComposer"),
          description: t(
            "common.tours.incidents.description.describeTheIncidentHereUseTheMenuToAttachImagesOrT",
          ),
          side: "top",
          align: "center",
        },
      },
      {
        element: tourEl("incidents-model-picker"),
        popover: {
          title: t("common.tours.incidents.title.modelPicker"),
          description: t(
            "common.tours.incidents.description.chooseWhichLLMProviderAndModelPowersTheInvestigati",
          ),
          side: "top",
          align: "end",
        },
      },
      {
        element: tourEl("incidents-send-btn"),
        popover: {
          title: t("common.tours.incidents.title.sendMessage"),
          description: t(
            "common.tours.incidents.description.sendYourMessageToStartOrContinueTheInvestigationYo",
          ),
          side: "top",
          align: "end",
        },
      },
      {
        element: tourEl("incidents-artifacts-btn"),
        popover: {
          title: t("common.tours.incidents.title.runbookResults"),
          description: t(
            "common.tours.incidents.description.whenTheAITriggersRunbooksDuringAnInvestigationThei",
          ),
          side: "bottom",
          align: "end",
        },
        onHighlightStarted: () => {
          const btn = document.querySelector<HTMLElement>(
            '[data-tour="incidents-artifacts-btn"]',
          );
          const rail = document.querySelector(
            '[data-tour="incidents-artifacts-rail"]',
          );
          if (btn && rail && !rail.classList.contains("translate-x-0")) {
            btn.click();
          }
        },
      },
      {
        element: tourEl("incidents-artifacts-detail"),
        popover: {
          title: t("common.tours.incidents.title.executionDetails"),
          description: t(
            "common.tours.incidents.description.seeLiveStepsExecutionParametersInputOutputAndError",
          ),
          side: "left",
          align: "start",
        },
      },
      {
        element: tourEl("incidents-new-btn"),
        popover: {
          title: t("common.tours.incidents.title.newIncident"),
          description: t(
            "common.tours.incidents.description.startANewAIAssistedInvestigationDescribeWhatSHappe",
          ),
          side: "bottom",
          align: "end",
        },
      },
    ],
  };

  const runbooksTour: TourDefinition = {
    id: "runbooks",
    label: t("common.tours.runbooks.label.runbooksTour"),
    description: t(
      "common.tours.runbooks.description.learnHowToBuildDeterministicRunbooksForIncidentRes",
    ),
    route: "/tour/runbooks",
    steps: [
      {
        popover: {
          title: t("common.tours.runbooks.title.welcomeToRunbooks"),
          description: t(
            "common.tours.runbooks.description.runbooksAreDeterministicActionSequencesShellComman",
          ),
        },
      },
      {
        element: tourEl("runbooks-editor-header"),
        popover: {
          title: t("common.tours.runbooks.title.runbookHeader"),
          description: t(
            "common.tours.runbooks.description.nameTheRunbookDescribeItsPurposeAndAccessTheMainCo",
          ),
          side: "bottom",
          align: "start",
        },
      },
      {
        element: tourEl("runbooks-actions-list"),
        popover: {
          title: t("common.tours.runbooks.title.actionSequence"),
          description: t(
            "common.tours.runbooks.description.actionsRunTopToBottomClickACardToExpandAndEditItDr",
          ),
          side: "left",
          align: "center",
        },
        onDeselected: () => {
          const card = document.querySelector<HTMLElement>(
            '[data-tour="runbooks-first-action"]',
          );
          card?.click();
        },
      },
      {
        element: tourEl("runbooks-action-types"),
        popover: {
          title: t("common.tours.runbooks.title.actionTypes"),
          description: t(
            "common.tours.runbooks.description.eachActionHasATypeShellTerminalCommandsAILLMPrompt",
          ),
          side: "bottom",
          align: "center",
        },
      },
      {
        element: tourEl("runbooks-run-btn"),
        popover: {
          title: t("common.tours.runbooks.title.runRunbook"),
          description: t(
            "common.tours.runbooks.description.executeTheRunbookActionsRunInSequenceAndResultsAre",
          ),
          side: "bottom",
          align: "end",
        },
      },
      {
        element: tourEl("runbooks-history-btn"),
        popover: {
          title: t("common.tours.runbooks.title.executionHistory"),
          description: t(
            "common.tours.runbooks.description.viewPastExecutionResultsForThisRunbook.",
          ),
          side: "bottom",
          align: "end",
        },
      },
      {
        element: tourEl("runbooks-new-btn"),
        popover: {
          title: t("common.tours.runbooks.title.createRunbook"),
          description: t(
            "common.tours.runbooks.description.startAFreshRunbookWithoutLeavingTheRunbooksPage.",
          ),
          side: "bottom",
          align: "end",
        },
      },
    ],
  };

  const resultsTour: TourDefinition = {
    id: "results",
    label: t("common.tours.results.label.resultsTour"),
    description: t(
      "common.tours.results.description.learnHowToReviewWhatEachRunbookExecutionDid.",
    ),
    route: "/tour/results",
    steps: [
      {
        popover: {
          title: t("common.tours.results.title.welcomeToResults"),
          description: t(
            "common.tours.results.description.everyRunbookExecutionLandsHereWithFullStepByStepOu",
          ),
        },
      },
      {
        element: tourEl("results-summary"),
        popover: {
          title: t("common.tours.results.title.summaryPanel"),
          description: t(
            "common.tours.results.description.showsTheRunbookNameStatusCompletedStepsParametersA",
          ),
          side: "right",
          align: "start",
        },
      },
      {
        element: tourEl("results-steps"),
        popover: {
          title: t("common.tours.results.title.stepsPanel"),
          description: t(
            "common.tours.results.description.eachStepIsListedWithItsTypeShellAIHTTPExternalAndS",
          ),
          side: "left",
          align: "start",
        },
      },
      {
        element: tourEl("results-output"),
        popover: {
          title: t("common.tours.results.title.outputPanel"),
          description: t(
            "common.tours.results.description.viewTheSelectedStepSInputOutputAndAnyErrorsOutputR",
          ),
          side: "left",
          align: "start",
        },
      },
      {
        element: tourEl("results-runbooks-btn"),
        popover: {
          title: t("common.tours.results.title.goToRunbook"),
          description: t(
            "common.tours.results.description.jumpToTheSourceRunbookToEditOrReRunIt.",
          ),
          side: "bottom",
          align: "start",
        },
      },
      {
        element: tourEl("results-history-btn"),
        popover: {
          title: t("common.tours.results.title.allResults"),
          description: t(
            "common.tours.results.description.viewTheFullExecutionHistoryListWithStatsForTotalRu",
          ),
          side: "bottom",
          align: "end",
        },
      },
      {
        popover: {
          title: t("common.tours.results.title.thatSTheResultsPage"),
          description: t(
            "common.tours.results.description.everyExecutionIsCapturedForReviewReplayThisTourAny",
          ),
        },
      },
    ],
  };

  const settingsTour: TourDefinition = {
    id: "settings",
    label: t("common.tours.settings.label.settingsTour"),
    description: t(
      "common.tours.settings.description.learnHowToConfigureBitSentry Desktop.",
    ),
    route: "/tour/settings",
    returnRoute: "/app-settings",
    steps: [
      {
        popover: {
          title: t("common.tours.settings.title.welcomeToSettings"),
          description: t(
            "common.tours.settings.description.settingsKeepBitSentry DesktopLocalFirst.",
          ),
        },
      },
      {
        element: tourEl("settings-external-sources"),
        popover: {
          title: t("common.tours.settings.title.externalSources"),
          description: t(
            "common.tours.settings.description.connectExternalSourcesForRunbooks.",
          ),
          side: "bottom",
          align: "start",
        },
      },
      {
        element: tourEl("settings-global-variables"),
        popover: {
          title: t("common.tours.settings.title.globalVariables"),
          description: t(
            "common.tours.settings.description.storeReusableValuesAsGlobals.",
          ),
          side: "bottom",
          align: "start",
        },
      },
      {
        element: tourEl("settings-global-variable-reference"),
        popover: {
          title: t("common.tours.settings.title.globalReferences"),
          description: t(
            "common.tours.settings.description.referenceGlobalsFromRunbooks.",
          ),
          side: "top",
          align: "start",
        },
      },
      {
        element: tourEl("settings-coding-agents"),
        popover: {
          title: t("common.tours.settings.title.codingAgents"),
          description: t(
            "common.tours.settings.description.configureCodexAndClaudeCode.",
          ),
          side: "bottom",
          align: "start",
        },
      },
      {
        element: tourEl("settings-coding-agent-primary"),
        popover: {
          title: t("common.tours.settings.title.primaryCodingAgent"),
          description: t(
            "common.tours.settings.description.chooseTheDefaultCodingAgent.",
          ),
          side: "left",
          align: "start",
        },
      },
      {
        element: tourEl("settings-help"),
        popover: {
          title: t("common.tours.settings.title.help"),
          description: t(
            "common.tours.settings.description.replayToursFromHelp.",
          ),
          side: "top",
          align: "start",
        },
      },
    ],
  };

  const runbookCreationTour: TourDefinition = {
    id: "runbookCreation",
    label: t("common.tours.runbookCreation.label.runbookCreationTour"),
    description: t(
      "common.tours.runbookCreation.description.learnHowToCreateRunbooksWithGlobals.",
    ),
    route: "/tour/runbook-creation",
    returnRoute: "/runbooks",
    steps: [
      {
        popover: {
          title: t("common.tours.runbookCreation.title.createARunbook"),
          description: t(
            "common.tours.runbookCreation.description.runbooksStartWithANameAndPurpose.",
          ),
        },
      },
      {
        element: tourEl("runbook-create-header"),
        popover: {
          title: t("common.tours.runbookCreation.title.runbookDetails"),
          description: t(
            "common.tours.runbookCreation.description.nameAndDescribeTheRunbook.",
          ),
          side: "bottom",
          align: "start",
        },
      },
      {
        element: tourEl("runbook-create-action-type"),
        popover: {
          title: t("common.tours.runbookCreation.title.chooseActionType"),
          description: t(
            "common.tours.runbookCreation.description.actionsCanUseShellAIHTTPOrExternalSources.",
          ),
          side: "bottom",
          align: "center",
        },
      },
      {
        element: tourEl("runbook-create-global-reference"),
        popover: {
          title: t("common.tours.runbookCreation.title.useGlobalVariables"),
          description: t(
            "common.tours.runbookCreation.description.insertGlobalsWithSyntax.",
          ),
          side: "right",
          align: "start",
        },
      },
      {
        element: tourEl("runbook-create-parameters"),
        popover: {
          title: t("common.tours.runbookCreation.title.runtimeParameters"),
          description: t(
            "common.tours.runbookCreation.description.parametersRemainRunSpecific.",
          ),
          side: "right",
          align: "start",
        },
      },
      {
        element: tourEl("runbook-create-run"),
        popover: {
          title: t("common.tours.runbookCreation.title.runTheRunbook"),
          description: t(
            "common.tours.runbookCreation.description.valuesResolveAtExecutionTime.",
          ),
          side: "bottom",
          align: "end",
        },
      },
    ],
  };

  const dataSourcesTour: TourDefinition = {
    id: "dataSources",
    label: t("common.tours.dataSources.label.externalSourcesTour"),
    description: t(
      "common.tours.dataSources.description.learnHowToConnectAndUseExternalSources.",
    ),
    route: "/tour/data-sources",
    returnRoute: "/app-settings",
    steps: [
      {
        popover: {
          title: t("common.tours.dataSources.title.externalSources"),
          description: t(
            "common.tours.dataSources.description.externalSourcesFeedRunbooks",
          ),
        },
      },
      {
        element: tourEl("data-sources-add-source"),
        popover: {
          title: t("common.tours.dataSources.title.addSource"),
          description: t(
            "common.tours.dataSources.description.startByAddingASource.",
          ),
          side: "bottom",
          align: "end",
        },
      },
      {
        element: tourEl("data-sources-provider-picker"),
        popover: {
          title: t("common.tours.dataSources.title.chooseProvider"),
          description: t(
            "common.tours.dataSources.description.pickCodePluginSource.",
          ),
          side: "bottom",
          align: "center",
        },
      },
      {
        element: tourEl("data-sources-credentials"),
        popover: {
          title: t("common.tours.dataSources.title.enterConnectionDetails"),
          description: t(
            "common.tours.dataSources.description.enterTokenOrgAndProjectDetails",
          ),
          side: "left",
          align: "start",
        },
      },
      {
        element: tourEl("data-sources-runbook-action-type"),
        popover: {
          title: t("common.tours.dataSources.title.useFromRunbook"),
          description: t(
            "common.tours.dataSources.description.chooseExternalSourceAction",
          ),
          side: "bottom",
          align: "center",
        },
      },
      {
        element: tourEl("data-sources-runbook-selector"),
        popover: {
          title: t("common.tours.dataSources.title.selectTheSource"),
          description: t(
            "common.tours.dataSources.description.selectAConnectedSource.",
          ),
          side: "right",
          align: "start",
        },
      },
      {
        element: tourEl("data-sources-runbook-query"),
        popover: {
          title: t("common.tours.dataSources.title.writeAQuery"),
          description: t(
            "common.tours.dataSources.description.queryCanUseGlobalsAndParameters.",
          ),
          side: "right",
          align: "start",
        },
      },
    ],
  };

  return {
    main: mainTour,
    incidents: incidentsTour,
    runbooks: runbooksTour,
    results: resultsTour,
    settings: settingsTour,
    runbookCreation: runbookCreationTour,
    dataSources: dataSourcesTour,
  };
}
