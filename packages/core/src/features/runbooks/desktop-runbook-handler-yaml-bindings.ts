import {
  createDesktopRunbookHandlerBindings,
} from "./desktop-runbook-handler-bindings";
import {
  parseRunbookArtifactFile,
  serializeRunbookArtifactFile,
} from "./desktop-runbook-artifact-file-yaml";
import type {
  DesktopRunbookHandlersDatabase,
  DesktopRunbookImportEdition,
} from "./desktop-runbook.handlers";
import type { RunbookGateway } from './runbook.gateway'
import type { DesktopGlobalVariablesService } from "./desktop-global-variables-service";
import type { RunbookExecutionService } from "./desktop-runbook-execution.service";

const runbookHandlerBindings = createDesktopRunbookHandlerBindings({
  parseRunbookArtifactFile,
  serializeRunbookArtifactFile,
});

export function createDesktopYamlRunbookHandlers(
  db: DesktopRunbookHandlersDatabase,
  dependencies: {
    executionService: RunbookExecutionService;
    globalVariablesService: DesktopGlobalVariablesService;
  },
  options?: {
    edition?: DesktopRunbookImportEdition;
    runbookGateway?: RunbookGateway;
  },
) {
  return runbookHandlerBindings.createRunbookHandlers(
    db,
    dependencies,
    options,
    options?.runbookGateway,
  );
}
