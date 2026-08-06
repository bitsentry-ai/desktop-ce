import { useEffect, useState } from "react";
import { Button } from "@bitsentry-ce/components/ui/button";
import { Download, RefreshCw, X } from "@bitsentry-ce/components/icons";
import { useTranslation } from "@bitsentry-ce/i18n";
import { getDesktopApi, type DesktopUpdaterState } from "../services/desktop-api";

type UpdateBannerContentProps = {
  state: UpdaterState;
  busy: boolean;
  onStartDownload: () => void;
  onInstallNow: () => void;
  onRetry: () => void;
};

type UpdaterState = DesktopUpdaterState;

function DownloadingUpdateContent({
  availableVersion,
  downloadPercent,
}: {
  availableVersion: string | null;
  downloadPercent: number | null;
}) {
  const { t } = useTranslation();
  let downloadLabel = availableVersion ?? t("common.updateBanner.update");
  if (downloadPercent !== null) {
    downloadLabel = `${downloadLabel} - ${downloadPercent.toString()}%`;
  }

  const progressPercent = downloadPercent ?? 0;

  return (
    <>
      <p className="text-sm font-medium text-foreground">
        {t("common.updateBanner.downloadingUpdate")}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {downloadLabel}
      </p>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${progressPercent.toString()}%` }}
        />
      </div>
    </>
  );
}

function UpdateErrorContent({
  message,
  busy,
  onRetry,
}: {
  message: string | null;
  busy: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <p className="text-sm font-medium text-destructive">
        {t("common.updateBanner.updateFailed")}
      </p>
      <p className="mt-0.5 break-words text-xs text-muted-foreground">
        {message ?? t("common.updateBanner.unknownError")}
      </p>
      <Button
        size="sm"
        variant="outline"
        className="mt-2 h-7 px-2 text-xs"
        onClick={onRetry}
        disabled={busy}
      >
        <RefreshCw size={12} className="mr-1.5" />
        {t("common.updateBanner.tryAgain")}
      </Button>
    </>
  );
}

function UpdateBannerContent({
  state,
  busy,
  onStartDownload,
  onInstallNow,
  onRetry,
}: UpdateBannerContentProps) {
  const { t } = useTranslation();
  const { status, availableVersion, downloadedVersion, downloadPercent, message } =
    state;

  if (status === "available") {
    return (
      <>
        <p className="text-sm font-medium text-foreground">
          {t("common.updateBanner.updateAvailable")}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("common.updateBanner.bitsentry-desktopReadyToDownload", {
            version: availableVersion,
          })}
        </p>
        <Button
          size="sm"
          variant="outline"
          className="mt-2 h-7 px-2 text-xs"
          onClick={onStartDownload}
          disabled={busy}
        >
          <Download size={12} className="mr-1.5" />
          {t("common.updateBanner.download")}
        </Button>
      </>
    );
  }

  if (status === "downloading") {
    return (
      <DownloadingUpdateContent
        availableVersion={availableVersion}
        downloadPercent={downloadPercent ?? null}
      />
    );
  }

  if (status === "downloaded") {
    return (
      <>
        <p className="text-sm font-medium text-foreground">
          {t("common.updateBanner.updateReadyToInstall")}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("common.updateBanner.bitsentry-desktopWillInstallOnRestart", {
            version: downloadedVersion,
          })}
        </p>
        <Button
          size="sm"
          variant="outline"
          className="mt-2 h-7 px-2 text-xs"
          onClick={onInstallNow}
          disabled={busy}
        >
          <RefreshCw size={12} className="mr-1.5" />
          {t("common.updateBanner.restartAndInstall")}
        </Button>
      </>
    );
  }

  if (status === "installing") {
    return (
      <>
        <p className="text-sm font-medium text-foreground">
          {t("common.updateBanner.restartingToInstallUpdate")}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("common.updateBanner.savingInFlightWorkBefore")}
        </p>
      </>
    );
  }

  if (status === "error") {
    return (
      <UpdateErrorContent message={message ?? null} busy={busy} onRetry={onRetry} />
    );
  }

  return null;
}

export default function UpdateBanner() {
  const { t } = useTranslation();
  const [state, setState] = useState<UpdaterState | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const api = getDesktopApi()?.updater;
    if (api === undefined) {
      return;
    }

    void api.getState().then((initial) => {
      if (!cancelled) setState(initial);
    });

    const unsubscribe = api.onState((next) => {
      if (cancelled) return;
      setState((current) => {
        if (
          current === null ||
          current.status !== next.status ||
          current.availableVersion !== next.availableVersion ||
          current.downloadedVersion !== next.downloadedVersion
        ) {
          setDismissed(false);
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (state === null || dismissed) return null;

  if (
    state.status === "idle" ||
    state.status === "checking" ||
    state.status === "disabled"
  ) {
    return null;
  }

  const startDownload = (): void => {
    const updater = getDesktopApi()?.updater;
    if (updater === undefined) return;
    setBusy(true);
    void updater.download().finally(() => {
      setBusy(false);
    });
  };

  const installNow = (): void => {
    const updater = getDesktopApi()?.updater;
    if (updater === undefined) return;
    setBusy(true);
    void updater.install().finally(() => {
      setBusy(false);
    });
  };

  const retry = (): void => {
    const updater = getDesktopApi()?.updater;
    if (typeof updater?.check === "function") {
      void updater.check();
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 w-auto max-w-sm rounded-lg border border-border bg-card p-3 shadow-lg">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <UpdateBannerContent
            state={state}
            busy={busy}
            onStartDownload={startDownload}
            onInstallNow={installNow}
            onRetry={retry}
          />
        </div>

        {state.status !== "installing" && (
          <button
            type="button"
            onClick={() => {
              setDismissed(true);
            }}
            aria-label={t("common.updateBanner.dismiss")}
            className="shrink-0 rounded p-1 text-muted-foreground/70 hover:bg-muted hover:text-foreground transition-colors"
          >
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
