import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ChatMessage, AgentIteration, ToolCallCard } from "./types";
import { ToolCard, WorkLogGroup } from "./ToolCallCard";
import { formatDuration } from "./utils";
import { useTranslation } from "@bitsentry-ce/i18n";
import { MarkdownContent } from "../markdown";
import {
  CheckIcon,
  CopyIcon,
  FileText,
  ShieldAlert,
  Loader2,
} from "lucide-react";
import { getProviderLogo } from "./ProviderLogos";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../lib/utils";

function dedupeToolCalls(toolCalls: ToolCallCard[]): ToolCallCard[] {
  return Array.from(
    new Map(
      toolCalls.map((toolCall) => [toolCall.toolCallId, toolCall]),
    ).values(),
  );
}

type AgentMessage = Extract<ChatMessage, { kind: "agent" }>;
type UserMessage = Extract<ChatMessage, { kind: "user" }>;

function UserChatBubble({ msg }: { msg: UserMessage }) {
  const attachmentsContent: ReactNode = msg.attachments !== undefined && msg.attachments.length > 0
    ? (
        <div className="grid grid-cols-2 gap-2">
          {msg.attachments.map((attachment) =>
            attachment.type === "image" ? (
              <img
                key={attachment.id}
                src={attachment.dataUrl}
                alt={attachment.name}
                className="max-h-40 w-full rounded-xl border border-border/60 object-cover"
              />
            ) : (
              <div
                key={attachment.id}
                className="flex items-center gap-2 rounded-xl border border-border/60 px-3 py-2 text-xs"
              >
                <FileText size={14} className="shrink-0 text-muted-foreground" />
                <span>
                  {attachment.name} ({attachment.rowCount}/
                  {attachment.totalRowCount} rows)
                </span>
              </div>
            ),
          )}
        </div>
      )
    : null;
  const textContent = msg.text.length > 0
    ? <div className="whitespace-pre-wrap">{msg.text}</div>
    : null;

  return (
    <div className="flex justify-end">
      <div className="max-w-[75%] space-y-2 rounded-2xl bg-muted px-4 py-2.5 text-sm">
        {attachmentsContent}
        {textContent}
      </div>
    </div>
  );
}

function getVisibleIterationText(
  msg: AgentMessage,
  iter: AgentIteration,
  isLastIteration: boolean,
): string {
  if (iter.text.length > 0) return iter.text;
  if (isLastIteration) return msg.finalText ?? "";
  return "";
}

export function hasWaitingAgentIndicator(msg: ChatMessage): boolean {
  if (msg.kind !== "agent") return false;
  if (msg.status !== "thinking" && msg.status !== "streaming") return false;
  if (msg.iterations.length === 0) return true;
  if (msg.activeIterationId === null) return false;
  return msg.iterations.some((iter) => iter.id === msg.activeIterationId);
}

export function shouldRenderIterationText(
  msg: AgentMessage,
  isLastIteration: boolean,
): boolean {
  if (isLastIteration) return true;

  const finalResponse = (msg.finalText ?? "").trim();
  return !(msg.status === "done" && finalResponse.length > 0);
}

export function getCopyableMarkdown(msg: AgentMessage): string {
  const renderedIterations = msg.iterations
    .map((iter, index, iterations) => {
      const isLastIteration = index === iterations.length - 1;
      if (!shouldRenderIterationText(msg, isLastIteration)) {
        return "";
      }

      return getVisibleIterationText(msg, iter, isLastIteration).trim();
    })
    .filter((text) => text.length > 0)
    .join("\n\n");

  if (renderedIterations.length > 0) {
    return renderedIterations;
  }

  return (msg.finalText ?? "").trim();
}

function CopyMarkdownResponseButton({ content }: { content: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  let label = t("common.markdown.copyResponseMarkdown");
  let Icon = CopyIcon;
  if (copied) {
    label = t("common.markdown.copied");
    Icon = CheckIcon;
  }

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) return;

    void navigator.clipboard
      .writeText(content)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => {});
  }, [content]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/80 text-muted-foreground shadow-sm transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={label}
        >
          <Icon className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function AssistantWaitingIndicator({
  label,
  elapsedMs,
}: {
  label: string;
  elapsedMs?: number;
}) {
  let elapsedText = "";
  if (elapsedMs !== undefined) {
    elapsedText = ` ${formatDuration(elapsedMs)}`;
  }

  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-muted/35 px-2.5 py-1 text-xs text-muted-foreground">
      <Loader2 size={12} className="animate-spin" aria-hidden="true" />
      <span>
        {label}
        {elapsedText}
      </span>
    </div>
  );
}

export const ChatBubble = memo(function ChatBubble({
  msg,
  providerKey,
}: {
  msg: ChatMessage;
  providerKey?: string | null;
}) {
  const { t } = useTranslation();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const shouldTickElapsed =
    msg.kind === "agent" &&
    (msg.status === "thinking" ||
      msg.status === "streaming" ||
      msg.iterations.some((iter) => iter.status === "thinking"));

  useEffect(() => {
    if (!shouldTickElapsed) return;

    setNowMs(Date.now());
    const interval = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => {
      clearInterval(interval);
    };
  }, [shouldTickElapsed]);

  if (msg.kind === "user") {
    return <UserChatBubble msg={msg} />;
  }

  const copyableMarkdown = getCopyableMarkdown(msg);
  const toolCallMap = Object.fromEntries(
    msg.toolCalls.map((tc) => [tc.toolCallId, tc]),
  );

  const formatTime = (iso: string) => {
    const date = new Date(iso);
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  };

  let providerLogoContent: ReactNode = (
    <ShieldAlert size={14} className="text-muted-foreground" />
  );
  if (providerKey !== undefined && providerKey !== null) {
    const ProviderLogo = getProviderLogo(providerKey);
    if (ProviderLogo !== null) {
      providerLogoContent = <ProviderLogo size={14} />;
    }
  }

  const isWaitingForAssistant =
    msg.status === "thinking" || msg.status === "streaming";

  let copyResponseButton: ReactNode = null;
  if (copyableMarkdown.length > 0) {
    copyResponseButton = <CopyMarkdownResponseButton content={copyableMarkdown} />;
  }

  let errorStatusContent: ReactNode = null;
  if (msg.status === "error" || msg.status === "cancelled") {
    let statusText = t("common.incidents.errorWithMessage", {
      message: msg.errorMsg,
    });
    if (msg.status === "cancelled") {
      statusText = t("common.incidents.sessionCancelled");
    }

    errorStatusContent = (
      <p className="text-xs italic text-muted-foreground">{statusText}</p>
    );
  }

  return (
    <div className="flex gap-3">
      <div
        className={cn(
          "relative mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted transition-colors",
          isWaitingForAssistant && "border-primary/25 bg-primary/5",
        )}
      >
        {providerLogoContent}
        {isWaitingForAssistant && (
          <span
            className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary/70 shadow-[0_0_0_3px_hsl(var(--background))] motion-safe:animate-pulse"
            aria-hidden="true"
          />
        )}
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="min-w-0 flex-1 space-y-3">
          {/* Render each iteration */}
          {msg.iterations.map((iter, index) => {
            const iterTools = dedupeToolCalls(
              iter.toolCallIds
                .map((id) => toolCallMap[id])
                .filter((toolCall): toolCall is ToolCallCard => toolCall !== undefined),
            );
            let duration: string | null = null;
            if (iter.completedAt !== undefined) {
              duration = formatDuration(
                new Date(iter.completedAt).getTime() -
                  new Date(iter.startedAt).getTime(),
              );
            }
            const isActive = iter.id === msg.activeIterationId;
            const elapsedMs = nowMs - new Date(iter.startedAt).getTime();
            const isLastIteration = index === msg.iterations.length - 1;
            let visibleText = "";
            if (shouldRenderIterationText(msg, isLastIteration)) {
              visibleText = getVisibleIterationText(msg, iter, isLastIteration);
            }
            const hasVisibleText =
              visibleText.trim().length > 0;
            const shouldShowWaitingIndicator = isActive && isWaitingForAssistant;

            // Show timestamp when iteration completes
            const showTimestamp =
              !shouldShowWaitingIndicator &&
              iter.completedAt !== undefined &&
              iter.status !== "thinking" &&
              (hasVisibleText || iterTools.length > 0);

            if (
              !hasVisibleText &&
              iterTools.length === 0 &&
              !shouldShowWaitingIndicator
            ) {
              return null;
            }

            let timestampContent: ReactNode = null;
            if (showTimestamp && duration !== null && iter.completedAt !== undefined) {
              timestampContent = (
                <p className="text-xs text-muted-foreground">
                  {formatTime(iter.completedAt)} • {duration}
                </p>
              );
            }

            return (
              <div key={iter.id} className="space-y-1">
                {shouldShowWaitingIndicator && (
                  <AssistantWaitingIndicator
                    label={t("common.incidents.workingFor")}
                    elapsedMs={elapsedMs}
                  />
                )}

                {hasVisibleText && (
                  <div className="text-sm leading-relaxed text-foreground">
                    <MarkdownContent
                      content={visibleText}
                      paragraphizeSoftBreaks
                    />
                  </div>
                )}

                {timestampContent}

                {iterTools.length > 0 && (
                  <WorkLogGroup toolCalls={iterTools}>
                    <div className="flex flex-wrap gap-1.5">
                      {iterTools.map((tc) => (
                        <ToolCard key={tc.toolCallId} card={tc} />
                      ))}
                    </div>
                  </WorkLogGroup>
                )}
              </div>
            );
          })}

          {msg.iterations.length === 0 && isWaitingForAssistant && (
            <AssistantWaitingIndicator
              label={t("common.incidents.aiIsResponding")}
            />
          )}

          {msg.iterations.length === 0 && msg.finalText && (
            <div className="text-sm leading-relaxed text-foreground">
              <MarkdownContent
                content={msg.finalText}
                paragraphizeSoftBreaks
              />
            </div>
          )}

          {errorStatusContent}

          {copyResponseButton !== null && (
            <div className="flex items-center gap-1.5">
              {copyResponseButton}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
