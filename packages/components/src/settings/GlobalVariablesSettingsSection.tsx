import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  useCreateGlobalVariable,
  useDeleteGlobalVariable,
  useGlobalVariables,
  useUpdateGlobalVariable,
  type GlobalVariable,
} from "../services";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { useToast } from "../hooks/use-toast";
import {
  useDebouncedAutoSave,
  type AutoSaveStatus,
} from "../hooks/useDebouncedAutoSave";
import { useTranslation } from "@bitsentry-ce/i18n";

const GLOBAL_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const formatGlobalVariableReference = (key: string) => `\${globals.${key}}`;

interface GlobalVariableDraft {
  key: string;
  value?: string;
  description: string;
  secure: boolean;
}

interface GlobalVariablesSettingsSectionProps {
  id?: string;
  className?: string;
  title?: string;
  description?: string;
}

function toDraft(globalVariable?: GlobalVariable): GlobalVariableDraft {
  let value: string | undefined = "";
  if (globalVariable !== undefined) {
    value = globalVariable.value;
    if (globalVariable.secure === true) {
      value = undefined;
    }
  }

  return {
    key: globalVariable?.key ?? "",
    value,
    description: globalVariable?.description ?? "",
    secure: globalVariable?.secure === true,
  };
}

function validateDraft(
  draft: GlobalVariableDraft,
  globals: GlobalVariable[],
  currentId?: string,
  t?: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  const translate = (
      key: string,
      defaultValue: string,
      options?: Record<string, unknown>,
    ) => t?.(key, { defaultValue, ...options }) ?? defaultValue;
  const key = draft.key.trim();
  if (key.length === 0) {
    return translate(
      "common.globalVariablesSettingsSection.keyIsRequired",
      "Key is required.",
    );
  }

  if (!GLOBAL_KEY_PATTERN.test(key)) {
    return translate(
      "common.globalVariablesSettingsSection.keyFormatHelp",
      "Keys must start with a letter or underscore and use only letters, numbers, underscores, dots, and hyphens.",
    );
  }
  const duplicate = globals.find(
    (globalVariable) =>
      globalVariable.id !== currentId && globalVariable.key === key,
  );
  if (duplicate !== undefined) {
    return translate(
      "common.globalVariablesSettingsSection.variableAlreadyExists",
      'Global variable "{{key}}" already exists.',
      { key },
    );
  }

  let current: GlobalVariable | undefined;
  if (currentId !== undefined) {
    current = globals.find((globalVariable) => globalVariable.id === currentId);
  }

  const changesSecureMode =
    current !== undefined && (current.secure === true) !== draft.secure;
  if (changesSecureMode && draft.value === undefined) {
    return translate(
      "common.globalVariablesSettingsSection.enterReplacementValue",
      "Enter a replacement value before changing secure mode.",
    );
  }
  return null;
}

const inputCls =
  "rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary/50";

interface VariablePanelProps {
  globalVariable: GlobalVariable;
  globals: GlobalVariable[];
  onUpdate: (id: string, draft: GlobalVariableDraft) => Promise<void>;
  onDelete: () => void | Promise<void>;
  isPendingDelete: boolean;
}

function VariablePanel({
  globalVariable,
  globals,
  onUpdate,
  onDelete,
  isPendingDelete,
}: VariablePanelProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<GlobalVariableDraft>(() =>
    toDraft(globalVariable),
  );

  // Re-sync draft when the upstream record updates (avoids stomping in-flight typing
  // because we only sync when keys differ — the rare case where another client edits).
  useEffect(() => {
    setDraft((current) => {
      if (current.key === "" && current.description === "" && !current.secure) {
        return toDraft(globalVariable);
      }
      return current;
    });
  }, [globalVariable.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const { status, error } = useDebouncedAutoSave(
    draft,
    async (value) => {
      await onUpdate(globalVariable.id, value);
    },
    {
      enabled: expanded,
      validate: (value) => validateDraft(value, globals, globalVariable.id, t),
      validationKey: globals,
    },
  );

  let secureBadge: ReactNode = null;
  if (globalVariable.secure === true) {
    secureBadge = (
      <Badge variant="secondary">
        {t("common.globalVariablesSettingsSection.secure")}
      </Badge>
    );
  }

  let chevronClassName = "h-4 w-4 text-muted-foreground shrink-0 transition-transform";
  if (expanded) {
    chevronClassName = `${chevronClassName} rotate-180`;
  }

  let valueLabel = t("common.globalVariablesSettingsSection.value");
  let valueInputType = "text";
  let valuePlaceholder = t("common.globalVariablesSettingsSection.value");
  if (draft.secure) {
    valueLabel = t("common.globalVariablesSettingsSection.secretValue");
    valueInputType = "password";
    valuePlaceholder = t(
      "common.globalVariablesSettingsSection.leaveBlankToKeepThe",
      "Leave blank to keep the saved value",
    );
  }

  let autoSaveError: ReactNode = null;
  if (status === "error" && error !== null) {
    autoSaveError = <p className="text-xs text-destructive">{error}</p>;
  }

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => { setExpanded((prev) => !prev); }}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-accent/50 transition-colors"
      >
        <span className="text-sm font-medium text-foreground truncate font-mono">
          {globalVariable.key}
        </span>
        {secureBadge}
        <span className="flex-1" />
        <svg
          className={chevronClassName}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-border px-4 py-4 space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-foreground mb-1.5">
                {t("common.globalVariablesSettingsSection.key")}
              </label>
              <input
                value={draft.key}
                onChange={(event) =>
                  { setDraft((current) => ({ ...current, key: event.target.value })); }
                }
                className={`${inputCls} w-full`}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-foreground mb-1.5">
                {valueLabel}
              </label>
              <input
                type={valueInputType}
                value={draft.value ?? ""}
                onChange={(event) =>
                  { setDraft((current) => ({ ...current, value: event.target.value })); }
                }
                onFocus={() => {
                  const changesSecureMode =
                    (globalVariable.secure === true) !== draft.secure;
                  if (!changesSecureMode || draft.value !== undefined) return;
                  setDraft((current) => ({ ...current, value: "" }));
                }}
                placeholder={valuePlaceholder}
                className={`${inputCls} w-full`}
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-foreground mb-1.5">
                {t("common.globalVariablesSettingsSection.description")}
              </label>
              <input
                value={draft.description}
                onChange={(event) =>
                  { setDraft((current) => ({
                    ...current,
                    description: event.target.value,
                  })); }
                }
                placeholder={t(
                  "common.globalVariablesSettingsSection.optionalDescription",
                )}
                className={`${inputCls} w-full`}
              />
            </div>
          </div>

          <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={draft.secure}
              onChange={(event) =>
                { setDraft((current) => {
                  let nextValue = current.value;
                  if (globalVariable.secure === true && !event.target.checked) {
                    nextValue = undefined;
                  }

                  return {
                    ...current,
                    secure: event.target.checked,
                    value: nextValue,
                  };
                }); }
              }
            />
            {t("common.globalVariablesSettingsSection.secureValue")}
          </label>

          {autoSaveError}

          <div className="flex items-center justify-between gap-3">
            <div
              data-tour="settings-global-variable-reference"
              className="text-xs text-muted-foreground"
            >
              <span>{t("common.globalVariablesSettingsSection.useAs")} </span>
              <code className="text-foreground">
                {formatGlobalVariableReference(globalVariable.key)}
              </code>
              <span> · </span>
              <SaveStatusInline status={status} />
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void onDelete()}
              disabled={isPendingDelete}
            >
              {t("common.actions.delete")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SaveStatusInline({ status }: { status: AutoSaveStatus }) {
  const { t } = useTranslation();
  if (status === "idle")
    return (
      <span className="text-muted-foreground">
        {t("common.globalVariablesSettingsSection.autoSaved")}
      </span>
    );
  if (status === "saving")
    return (
      <span className="text-muted-foreground">{t("common.actions.saving")}</span>
    );
  if (status === "saved")
    return (
      <span className="text-muted-foreground">
        {t("common.globalVariablesSettingsSection.saved")}
      </span>
    );
  return (
    <span className="text-red-600 dark:text-red-400">
      {t("common.globalVariablesSettingsSection.saveError")}
    </span>
  );
}

interface CreatePanelProps {
  draft: GlobalVariableDraft;
  setDraft: React.Dispatch<React.SetStateAction<GlobalVariableDraft>>;
  onSave: () => void | Promise<void>;
  onCancel: () => void;
  error: string | null;
  isPending: boolean;
}

function CreatePanel({
  draft,
  setDraft,
  onSave,
  onCancel,
  error,
  isPending,
}: CreatePanelProps) {
  const { t } = useTranslation();
  // Defer validation noise until the user has actually engaged with the form.
  const [touched, setTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const showError = (touched || submitted) && error !== null;

  let valueLabel = t("common.globalVariablesSettingsSection.value");
  let valueInputType = "text";
  let valuePlaceholder = t("common.globalVariablesSettingsSection.value");
  if (draft.secure) {
    valueLabel = t("common.globalVariablesSettingsSection.secretValue");
    valueInputType = "password";
    valuePlaceholder = t("common.globalVariablesSettingsSection.secretValue");
  }

  let errorContent: ReactNode = null;
  if (showError) {
    errorContent = <p className="text-sm text-destructive">{error}</p>;
  }

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden">
      <div className="px-4 py-4 space-y-4">
        <div>
          <h3 className="text-sm font-medium text-foreground">
            {t("common.globalVariablesSettingsSection.newVariable")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("common.globalVariablesSettingsSection.reusableValueHelp")}{" "}
            <code>{t("common.globalVariablesSettingsSection.globalsKey")}</code>.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">
              {t("common.globalVariablesSettingsSection.key")}
            </label>
            <input
              value={draft.key}
              onChange={(event) => {
                setTouched(true);
                setDraft((current) => ({ ...current, key: event.target.value }));
              }}
              placeholder="environment"
              className={`${inputCls} w-full`}
            />
            </div>
            <div>
              <label className="block text-xs font-medium text-foreground mb-1.5">
                {valueLabel}
              </label>
              <input
                type={valueInputType}
                value={draft.value ?? ""}
              onChange={(event) =>
                { setDraft((current) => ({ ...current, value: event.target.value })); }
              }
                placeholder={valuePlaceholder}
              className={`${inputCls} w-full`}
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-foreground mb-1.5">
              {t("common.globalVariablesSettingsSection.description")}
            </label>
            <input
              value={draft.description}
              onChange={(event) =>
                { setDraft((current) => ({
                  ...current,
                  description: event.target.value,
                })); }
              }
              placeholder={t(
                "common.globalVariablesSettingsSection.optionalDescription",
              )}
              className={`${inputCls} w-full`}
            />
          </div>
        </div>

        {errorContent}

        <div className="flex items-center justify-between gap-2">
          <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={draft.secure}
              onChange={(event) =>
                { setDraft((current) => ({
                  ...current,
                  secure: event.target.checked,
                  value: "",
                })); }
              }
            />
            {t("common.globalVariablesSettingsSection.secureValue")}
          </label>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onCancel}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="text-primary hover:bg-primary/10 hover:text-primary border-primary/30"
              onClick={() => {
                setSubmitted(true);
                void onSave();
              }}
              disabled={isPending}
            >
              {t("common.globalVariablesSettingsSection.create")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function GlobalVariablesSettingsSection({
  id = "global-variables",
  className,
  title,
  description,
}: GlobalVariablesSettingsSectionProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { data: globals = [], isLoading } = useGlobalVariables();
  const createMutation = useCreateGlobalVariable();
  const updateMutation = useUpdateGlobalVariable();
  const deleteMutation = useDeleteGlobalVariable();
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState<GlobalVariableDraft>(() =>
    toDraft(),
  );

  const sortedGlobals = useMemo(
    () => [...globals].sort((left, right) => left.key.localeCompare(right.key)),
    [globals],
  );

  let createError: string | null = null;
  if (creating) {
    createError = validateDraft(createDraft, sortedGlobals, undefined, t);
  }

  const cancelCreate = () => {
    setCreating(false);
    setCreateDraft(toDraft());
  };

  const saveCreate = async () => {
    if (createError !== null) {
      toast({
        title: t("common.globalVariablesSettingsSection.invalidGlobalVariable"),
        description: createError,
        variant: "destructive",
      });
      return;
    }
    try {
      const description = createDraft.description.trim();
      const createPayload: {
        key: string;
        description?: string;
        secure: boolean;
        value?: string;
      } = {
        key: createDraft.key.trim(),
        secure: createDraft.secure,
      };
      if (description.length > 0) {
        createPayload.description = description;
      }
      if (createDraft.value !== undefined && createDraft.value.length > 0) {
        createPayload.value = createDraft.value;
      }

      await createMutation.mutateAsync(createPayload);
      cancelCreate();
      toast({
        title: t("common.globalVariablesSettingsSection.globalVariableCreated"),
      });
    } catch (error) {
      let description = t("common.globalVariablesSettingsSection.unknownError");
      if (error instanceof Error) {
        description = error.message;
      }

      toast({
        title: t(
          "common.globalVariablesSettingsSection.failedToCreateGlobalVariable",
        ),
        description,
        variant: "destructive",
      });
    }
  };

  const handleUpdate = async (id: string, draft: GlobalVariableDraft) => {
    const description = draft.description.trim();
    const patch: {
      key: string;
      description?: string;
      secure: boolean;
      value?: string;
    } = {
      key: draft.key.trim(),
      secure: draft.secure,
    };
    if (description.length > 0) {
      patch.description = description;
    }
    if (draft.value !== undefined) {
      patch.value = draft.value;
    }

    await updateMutation.mutateAsync({
      id,
      patch,
    });
  };

  const removeGlobal = async (globalVariable: GlobalVariable) => {
    try {
      await deleteMutation.mutateAsync(globalVariable.id);
      toast({
        title: t("common.globalVariablesSettingsSection.deletedVariable", {
          key: globalVariable.key,
        }),
      });
    } catch (error) {
      let description = t("common.globalVariablesSettingsSection.unknownError");
      if (error instanceof Error) {
        description = error.message;
      }

      toast({
        title: t(
          "common.globalVariablesSettingsSection.failedToDeleteGlobalVariable",
        ),
        description,
        variant: "destructive",
      });
    }
  };

  const sectionTitle = title ?? t("navigation.navbar.globalVariables");
  const sectionDescription =
    description ??
    t("common.globalVariablesSettingsSection.storeSharedRunbookValues");

  let createButton: ReactNode = null;
  if (!creating) {
    createButton = (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          setCreating(true);
          setCreateDraft(toDraft());
        }}
      >
        {t("common.globalVariablesSettingsSection.addVariable")}
      </Button>
    );
  }

  let createPanel: ReactNode = null;
  if (creating) {
    createPanel = (
      <CreatePanel
        draft={createDraft}
        setDraft={setCreateDraft}
        onSave={saveCreate}
        onCancel={cancelCreate}
        error={createError}
        isPending={createMutation.isPending}
      />
    );
  }

  let globalsContent: ReactNode;
  if (isLoading) {
    globalsContent = (
      <div className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
        {t(
          "common.globalVariablesSettingsSection.loadingGlobalVariables",
          "Loading global variables…",
        )}
      </div>
    );
  } else if (sortedGlobals.length === 0 && !creating) {
    globalsContent = (
      <div className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
        {t(
          "common.globalVariablesSettingsSection.noGlobalVariablesSavedYet",
          "No global variables saved yet.",
        )}
      </div>
    );
  } else {
    globalsContent = sortedGlobals.map((globalVariable) => (
      <VariablePanel
        key={globalVariable.id}
        globalVariable={globalVariable}
        globals={globals}
        onUpdate={handleUpdate}
        onDelete={() => removeGlobal(globalVariable)}
        isPendingDelete={deleteMutation.isPending}
      />
    ));
  }

  return (
    <section id={id} data-tour="settings-global-variables" className={className}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            {sectionTitle}
          </h2>
          <p className="text-xs text-muted-foreground">
            {sectionDescription}
          </p>
        </div>
        {createButton}
      </div>

      <div className="space-y-2">
        {createPanel}
        {globalsContent}
      </div>
    </section>
  );
}
