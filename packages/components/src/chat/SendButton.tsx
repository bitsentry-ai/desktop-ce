/**
 * SendButton — the composer's primary action, adapted from T3 Code
 * (https://github.com/pingdotgg/t3code, MIT):
 *   idle: send arrow
 *   running, empty composer: stop
 *   running, with text: queue (ListPlus) or steer (CornerUpRight); Ctrl/⌘ swaps them
 *   editing a queued message: check
 *   stopped with a held queue: resume
 */

import { Check, CornerUpRight, ListPlus, Play } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import { cn } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { resolveComposerDispatchMode, useShortcutModifierState } from "./composerDispatch";

interface SendButtonProps {
  isRunning: boolean;
  /** The composer holds something to send and nothing blocks sending. */
  canSend: boolean;
  canSteer: boolean;
  canResume: boolean;
  isEditingQueuedMessage: boolean;
  /** `alternate` is true for a Ctrl/⌘-click, which sends the other way while the agent runs. */
  onSubmit: (alternate: boolean) => void;
  onResume: () => void;
  onInterrupt: () => void;
}

function SendArrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SendButton({
  isRunning,
  canSend,
  canSteer,
  canResume,
  isEditingQueuedMessage,
  onSubmit,
  onResume,
  onInterrupt,
}: SendButtonProps) {
  const { t } = useTranslation();
  const modifiers = useShortcutModifierState();

  if (isRunning && !canSend && !isEditingQueuedMessage) {
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onInterrupt}
              aria-label={t("common.incidents.composer.stopGeneration")}
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-destructive/90 text-white shadow-sm transition-colors duration-150 hover:bg-destructive"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                <rect x="2" y="2" width="8" height="8" rx="1.5" />
              </svg>
            </button>
          </TooltipTrigger>
          <TooltipContent>{t("common.incidents.composer.interrupt")}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  const showResume = canResume && !canSend && !isEditingQueuedMessage;
  const isQueuing =
    !isEditingQueuedMessage &&
    resolveComposerDispatchMode({
      running: isRunning,
      canSteer,
      alternateModifier: modifiers.metaKey || modifiers.ctrlKey,
    }) === "queue";

  let label = t("common.incidents.sendMessage");
  if (showResume) label = t("common.incidents.composer.resumeThread");
  else if (isEditingQueuedMessage) label = t("common.incidents.composer.updateQueuedMessage");
  else if (isQueuing) label = t("common.incidents.composer.queueMessage");
  else if (isRunning) label = t("common.incidents.composer.steerMessage");

  let tooltip = label;
  if (isRunning && !isEditingQueuedMessage && canSteer) {
    tooltip = t("common.incidents.composer.clickToQueue");
  }

  let icon = <SendArrow />;
  if (showResume) icon = <Play className="size-4 fill-current" aria-hidden="true" />;
  else if (isEditingQueuedMessage) icon = <Check className="size-4" aria-hidden="true" />;
  else if (isRunning) icon = isQueuing ? <ListPlus className="size-4" aria-hidden="true" /> : <CornerUpRight className="size-4" aria-hidden="true" />;

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <button
              type="button"
              onClick={(event) => {
                if (showResume) {
                  onResume();
                  return;
                }
                onSubmit(event.metaKey || event.ctrlKey);
              }}
              disabled={!canSend && !showResume}
              aria-label={label}
              className={cn(
                "flex size-8 items-center justify-center rounded-full bg-primary/90 text-primary-foreground shadow-sm transition-all duration-150",
                "enabled:cursor-pointer enabled:hover:scale-105 enabled:hover:bg-primary disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none",
              )}
            >
              {icon}
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
