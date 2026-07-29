import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  memo,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "./lib/utils";
import { useTranslation } from "@bitsentry-ce/i18n";

const HTML_BREAK_TAG_REGEX = /<br\s*\/?>/gi;

export interface MarkdownContentProps {
  content: string;
  className?: string;
  paragraphizeSoftBreaks?: boolean;
}

export function normalizeMarkdownContent(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(HTML_BREAK_TAG_REGEX, "\n");
}

const MARKDOWN_STRUCTURAL_LINE_REGEX =
  /^(\s{0,3}(```|~~~)|\s{0,3}#{1,6}\s|\s{0,3}>\s?|\s*[-*+]\s+|\s*\d+\.\s+|\s*\|.*\|\s*$|\s{4,}\S)/;

export function paragraphizePlainTextSoftBreaks(content: string): string {
  const normalized = content
    .replace(/\r\n/g, "\n")
    .replace(HTML_BREAK_TAG_REGEX, "\n");
  const lines = normalized.split("\n");

  if (
    lines.some((line) => MARKDOWN_STRUCTURAL_LINE_REGEX.test(line)) ||
    lines.filter((line) => line.trim().length > 0).length < 2
  ) {
    return normalized;
  }

  return lines
    .map((line) => line.trimEnd())
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function getMarkdownPreview(content: string, maxLength = 180): string {
  const normalized = normalizeMarkdownContent(content)
    .replace(/```([\s\S]*?)```/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/\*\*|__|\*|_|~~/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trimEnd()}...`;
}

function MarkdownCodeBlock({
  code,
  children,
}: {
  code: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) return;

    void navigator.clipboard
      .writeText(code)
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
  }, [code]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  let copyButtonTitle = t("common.markdown.copyCode");
  let copyButtonLabel = t("common.markdown.copyCode_2");
  let CopyButtonIcon = CopyIcon;
  if (copied) {
    copyButtonTitle = t("common.markdown.copied");
    copyButtonLabel = t("common.markdown.copied_2");
    CopyButtonIcon = CheckIcon;
  }

  return (
    <div className="chat-markdown-codeblock">
      <button
        type="button"
        className="chat-markdown-copy-button"
        onClick={handleCopy}
        title={copyButtonTitle}
        aria-label={copyButtonLabel}
      >
        <CopyButtonIcon className="size-3" />
      </button>
      {children}
    </div>
  );
}

function getNestedText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map((child) => getNestedText(child)).join("");
  }

  if (isValidElement<{ children?: ReactNode }>(node)) {
    return getNestedText(node.props.children);
  }

  return "";
}

export function getCodeText(children: ReactNode): string {
  const childArray = Children.toArray(children);
  let codeElement: ReactNode = children;
  if (childArray.length > 0) {
    codeElement = childArray[0];
  }

  if (!isValidElement<{ children?: ReactNode }>(codeElement)) {
    return "";
  }

  return getNestedText(codeElement.props.children);
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  className,
  paragraphizeSoftBreaks = false,
}: MarkdownContentProps) {
  const { t } = useTranslation();
  const normalizedContent = useMemo(() => {
    let sourceContent = content;
    if (paragraphizeSoftBreaks) {
      sourceContent = paragraphizePlainTextSoftBreaks(content);
    }

    return normalizeMarkdownContent(sourceContent);
  }, [content, paragraphizeSoftBreaks]);

  return (
    <div
      className={cn(
        "chat-markdown w-full min-w-0 max-w-full break-words text-sm leading-relaxed text-foreground/85 [&_p]:break-words [&_li]:break-words [&_code]:break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, node: _node, ref: _ref, ...props }) => (
            <a
              {...props}
              href={href}
              target="_blank"
              rel="noreferrer noopener"
            />
          ),
          pre: ({ children, ...props }: ComponentPropsWithoutRef<"pre">) => {
            const code = getCodeText(children);
            return (
              <MarkdownCodeBlock code={code}>
                <pre {...props}>{children}</pre>
              </MarkdownCodeBlock>
            );
          },
          table: ({ children, node: _node, ref: _ref, ...props }) => (
            <div
              className="chat-markdown-table-scroll"
              role="region"
              aria-label={t("common.markdown.scrollableTable")}
              tabIndex={0}
            >
              <table {...props}>{children}</table>
            </div>
          ),
        }}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
});

export default MarkdownContent;
