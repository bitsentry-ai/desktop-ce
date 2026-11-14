import { type Dispatch, type SetStateAction } from "react";

import { collectRunbookGlobalReferences } from "@bitsentry-ce/core";

import type { GlobalVariable, RunbookRecord } from "../../services";
import type { RunbookMetaPatch } from "./runbookRecordHelpers";

type UseRunbookMetadataFlowOptions = {
  activeEditingRunbook: RunbookRecord | null;
  globalVariables: GlobalVariable[];
  setEditingRunbook: Dispatch<SetStateAction<RunbookRecord | null>>;
  commitMeta: (patch: RunbookMetaPatch) => Promise<void>;
};

export function useRunbookMetadataFlow({
  activeEditingRunbook,
  globalVariables,
  setEditingRunbook,
  commitMeta,
}: UseRunbookMetadataFlowOptions) {
  const availableKeys = new Set(globalVariables.map((globalVariable) => globalVariable.key));
  const unresolvedGlobalKeys =
    activeEditingRunbook === null
      ? []
      : collectRunbookGlobalReferences(activeEditingRunbook).filter((key) => !availableKeys.has(key));

  const handleTitleChange = (value: string) => {
    setEditingRunbook((prev) => {
      if (prev === null) {
        return prev;
      }

      let title = value;
      if (title.length === 0) {
        title = "Untitled Runbook";
      }

      return { ...prev, title };
    });
  };

  const handleTitleBlur = () => {
    if (activeEditingRunbook === null) {
      return;
    }

    let title = activeEditingRunbook.title;
    if (title.length === 0) {
      title = "Untitled Runbook";
    }

    void commitMeta({ title });
  };

  const handleDescriptionChange = (value: string) => {
    setEditingRunbook((prev) => {
      if (prev === null) {
        return prev;
      }

      return {
        ...prev,
        description: value,
      };
    });
  };

  const handleDescriptionBlur = () => {
    if (activeEditingRunbook === null) {
      return;
    }

    void commitMeta({
      description: activeEditingRunbook.description,
    });
  };

  return {
    handleDescriptionBlur,
    handleDescriptionChange,
    handleTitleBlur,
    handleTitleChange,
    unresolvedGlobalKeys,
  };
}
