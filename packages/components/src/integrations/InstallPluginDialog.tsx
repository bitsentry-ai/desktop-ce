import { useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "@bitsentry-ce/i18n";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  useAvailablePlugins,
  useInstallPluginFromArtifact,
  useInstallPluginFromIndex,
} from "../services/hooks";
import type { AvailablePlugin } from "../services/contracts";

interface InstallPluginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

async function readFileAsBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function toMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Install failed.";
}

export default function InstallPluginDialog({
  open,
  onOpenChange,
}: InstallPluginDialogProps) {
  const { t } = useTranslation();
  const availableQuery = useAvailablePlugins(open);
  const installFromIndex = useInstallPluginFromIndex();
  const installFromArtifact = useInstallPluginFromArtifact();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);

  const entries: AvailablePlugin[] = availableQuery.data?.data ?? [];

  function handleInstallFromIndex(name: string): void {
    setPendingName(name);
    installFromIndex.mutate(
      { name },
      {
        onSuccess: () => {
          toast.success(t("common.dataSourcesManager.installSuccess"));
        },
        onError: (error: unknown) => {
          toast.error(toMessage(error));
        },
        onSettled: () => {
          setPendingName(null);
        },
      },
    );
  }

  async function handleInstallFromFile(): Promise<void> {
    if (selectedFile === null) {
      return;
    }

    try {
      const artifactBase64 = await readFileAsBase64(selectedFile);
      installFromArtifact.mutate(artifactBase64, {
        onSuccess: () => {
          toast.success(t("common.dataSourcesManager.installSuccess"));
          setSelectedFile(null);
        },
        onError: (error: unknown) => {
          toast.error(toMessage(error));
        },
      });
    } catch (error) {
      toast.error(toMessage(error));
    }
  }

  function renderInstallLabel(name: string): string {
    if (installFromIndex.isPending && pendingName === name) {
      return t("common.dataSourcesManager.installBusy");
    }

    return t("common.dataSourcesManager.installButton");
  }

  function renderAvailableList() {
    if (availableQuery.isLoading) {
      return (
        <p className="text-sm text-muted-foreground">
          {t("common.dataSourcesManager.installBusy")}
        </p>
      );
    }

    if (availableQuery.isError) {
      return (
        <p className="text-sm text-red-600 dark:text-red-400">
          {t("common.dataSourcesManager.installIndexError")}
        </p>
      );
    }

    if (entries.length === 0) {
      return (
        <p className="text-sm text-muted-foreground">
          {t("common.dataSourcesManager.installNone")}
        </p>
      );
    }

    return (
      <ul className="space-y-2">
        {entries.map((entry) => (
          <li
            key={entry.name}
            className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{entry.name}</div>
              {entry.description !== undefined && (
                <div className="truncate text-xs text-muted-foreground">
                  {entry.description}
                </div>
              )}
            </div>
            {entry.installed && (
              <Badge variant="secondary">
                {t("common.dataSourcesManager.installInstalledBadge")}
              </Badge>
            )}
            {!entry.installed && (
              <Button
                variant="outline"
                size="sm"
                disabled={installFromIndex.isPending}
                onClick={() => {
                  handleInstallFromIndex(entry.name);
                }}
              >
                {renderInstallLabel(entry.name)}
              </Button>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t("common.dataSourcesManager.installTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("common.dataSourcesManager.installSubtitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                {t("common.dataSourcesManager.installAvailableHeading")}
              </h3>
              <Button
                variant="ghost"
                size="sm"
                disabled={availableQuery.isFetching}
                onClick={() => {
                  void availableQuery.refetch();
                }}
              >
                {t("common.dataSourcesManager.installRefresh")}
              </Button>
            </div>
            {renderAvailableList()}
          </section>

          <section className="space-y-2 border-t border-border pt-4">
            <h3 className="text-sm font-semibold">
              {t("common.dataSourcesManager.installFromFileHeading")}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t("common.dataSourcesManager.installFromFileHelp")}
            </p>
            <div className="flex items-center gap-2">
              <input
                type="file"
                accept=".tgz,.tar.gz,.gz,application/gzip"
                className="text-sm"
                onChange={(event) => {
                  setSelectedFile(event.target.files?.[0] ?? null);
                }}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={selectedFile === null || installFromArtifact.isPending}
                onClick={() => {
                  void handleInstallFromFile();
                }}
              >
                {t("common.dataSourcesManager.installFromFileButton")}
              </Button>
            </div>
          </section>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t("common.actions.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
