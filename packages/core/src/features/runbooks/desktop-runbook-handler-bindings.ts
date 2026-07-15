import { readFile, writeFile } from "fs/promises";
import log from "electron-log";

import {
  createDesktopRunbookHandlers,
  type DesktopRunbookArtifactIo,
  type DesktopRunbookImportEdition,
  type DesktopRunbookHandlerDependencies,
  type DesktopRunbookHandlersDatabase,
} from "./desktop-runbook.handlers";
import {
  consumeApprovedRunbookExportPath,
  consumeApprovedRunbookImportPath,
} from "./desktop-trusted-runbook-paths";

type SharedDesktopRunbookHandlerDependencies = Pick<
  DesktopRunbookHandlerDependencies,
  "executionService" | "globalVariablesService"
>;

export function createDesktopRunbookHandlerBindings(
  artifactIo: DesktopRunbookArtifactIo,
) {
  return {
    createRunbookHandlers(
      db: DesktopRunbookHandlersDatabase,
      dependencies: SharedDesktopRunbookHandlerDependencies,
      options?: {
        edition?: DesktopRunbookImportEdition;
      },
    ) {
      return createDesktopRunbookHandlers(db, {
        ...dependencies,
        artifactIo,
        fileSystem: {
          readFile,
          writeFile,
        },
        trustedRunbookPaths: {
          consumeApprovedRunbookExportPath,
          consumeApprovedRunbookImportPath,
        },
        logger: log,
      }, options);
    },
  };
}
