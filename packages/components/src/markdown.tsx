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
  collapsedJsonLabel?: string;
}

function readBacktickDelimiter(line: string, index: number): string | undefined {
  if (line[index] !== "`") return undefined;
  let end = index + 1;
  while (line[end] === "`") end += 1;
  return line.slice(index, end);
}

function toggleCodeDelimiter(current: number, next: number): number {
  if (current === 0) return next;
  return current === next ? 0 : current;
}

interface MarkdownFence {
  marker: string;
  length: number;
  closingIndent: number;
}

function skipUpToThreeSpaces(line: string): number {
  let index = 0;
  while (index < 3 && line[index] === " ") index += 1;
  return index;
}

function readFenceAt(line: string, index: number): MarkdownFence | undefined {
  const marker = line[index];
  if (marker !== "`" && marker !== "~") return undefined;
  let end = index;
  while (line[end] === marker) end += 1;
  if (end - index < 3 || (marker === "`" && line.slice(end).includes("`"))) {
    return undefined;
  }
  return { marker, length: end - index, closingIndent: 3 };
}

function readListContentStart(line: string, index: number): number | undefined {
  if (["-", "+", "*"].includes(line[index] ?? "")) index += 1;
  else {
    const digitStart = index;
    while (/\d/.test(line[index] ?? "")) index += 1;
    if (index === digitStart || (line[index] !== "." && line[index] !== ")")) {
      return undefined;
    }
    index += 1;
  }
  if (line[index] !== " " && line[index] !== "\t") return undefined;
  while (line[index] === " " || line[index] === "\t") index += 1;
  return index;
}

function readFenceOpening(line: string): MarkdownFence | undefined {
  const contentStart = skipUpToThreeSpaces(line);
  const directFence = readFenceAt(line, contentStart);
  if (directFence !== undefined) return { ...directFence, closingIndent: 3 };
  const listContentStart = readListContentStart(line, contentStart);
  if (listContentStart === undefined) return undefined;
  const listFence = readFenceAt(line, listContentStart);
  return listFence === undefined
    ? undefined
    : { ...listFence, closingIndent: listContentStart + 3 };
}

function isFenceClosing(line: string, fence: MarkdownFence): boolean {
  let markerStart = 0;
  while (line[markerStart] === " ") markerStart += 1;
  if (markerStart > fence.closingIndent) return false;
  const closingFence = readFenceAt(line, markerStart);
  if (
    closingFence === undefined ||
    closingFence.marker !== fence.marker ||
    closingFence.length < fence.length
  ) {
    return false;
  }
  return line
    .slice(markerStart + closingFence.length)
    .split("")
    .every((character) => character === " " || character === "\t");
}

function isMarkdownTableDelimiter(line: string): boolean {
  if (/^ {4}/.test(line)) return false;
  let content = line.slice(skipUpToThreeSpaces(line));
  while (content.startsWith(">")) content = content.slice(1).trimStart();
  content = content.trim();
  if (!content.includes("|")) return false;
  if (content.startsWith("|")) content = content.slice(1);
  if (content.endsWith("|")) content = content.slice(0, -1);
  const cells = content.split("|");
  return (
    cells.length >= 2 &&
    cells.every((cell) => /^:?-+:?$/.test(cell.trim()))
  );
}

function getProtectedMarkdownLines(lines: string[]): Set<number> {
  const protectedLines = new Set<number>();
  let fence: MarkdownFence | undefined;
  lines.forEach((line, index) => {
    if (fence !== undefined) {
      protectedLines.add(index);
      if (isFenceClosing(line, fence)) fence = undefined;
      return;
    }

    const opening = readFenceOpening(line);
    if (opening !== undefined) {
      fence = opening;
      protectedLines.add(index);
    } else if (/^ {4}/.test(line)) {
      protectedLines.add(index);
    }
  });
  return protectedLines;
}

function hasTableSeparator(line: string): boolean {
  line = line.slice(skipUpToThreeSpaces(line));
  while (line.startsWith(">")) line = line.slice(1).trimStart();
  let codeDelimiterLength = 0;
  for (let index = 0; index < line.length; ) {
    if (line[index] === "\\" && codeDelimiterLength === 0 && index + 1 < line.length) {
      index += 2;
      continue;
    }
    const delimiter = readBacktickDelimiter(line, index);
    if (delimiter !== undefined) {
      codeDelimiterLength = toggleCodeDelimiter(codeDelimiterLength, delimiter.length);
      index += delimiter.length;
      continue;
    }
    if (line[index] === "|" && codeDelimiterLength === 0) return true;
    index += 1;
  }
  return false;
}

function getMarkdownTableLines(lines: string[], protectedLines: Set<number>): Set<number> {
  const tableLines = new Set<number>();
  for (let index = 1; index < lines.length; index += 1) {
    if (
      protectedLines.has(index) ||
      protectedLines.has(index - 1) ||
      !isMarkdownTableDelimiter(lines[index]) ||
      !hasTableSeparator(lines[index - 1])
    ) {
      continue;
    }

    tableLines.add(index - 1);
    tableLines.add(index);
    for (let row = index + 1; row < lines.length; row += 1) {
      if (
        protectedLines.has(row) ||
        lines[row].trim() === "" ||
        !hasTableSeparator(lines[row])
      ) {
        break;
      }
      tableLines.add(row);
    }
  }
  return tableLines;
}

function escapeInlineCodePipesInTableRow(line: string): string {
  let result = "";
  let codeDelimiterLength = 0;
  for (let index = 0; index < line.length; ) {
    if (line[index] === "\\" && codeDelimiterLength === 0 && index + 1 < line.length) {
      result += line.slice(index, index + 2);
      index += 2;
      continue;
    }
    const delimiter = readBacktickDelimiter(line, index);
    if (delimiter !== undefined) {
      codeDelimiterLength = toggleCodeDelimiter(
        codeDelimiterLength,
        delimiter.length,
      );
      result += delimiter;
      index += delimiter.length;
      continue;
    }
    if (line[index] === "|" && codeDelimiterLength > 0) result += "\\|";
    else result += line[index];
    index += 1;
  }
  return result;
}

export function normalizeMarkdownContent(content: string): string {
  const lines = content
    .replace(/\r\n/g, "\n")
    .replace(HTML_BREAK_TAG_REGEX, "\n")
    .split("\n");
  const protectedLines = getProtectedMarkdownLines(lines);
  const tableLines = getMarkdownTableLines(lines, protectedLines);
  return lines
    .map((line, index) =>
      tableLines.has(index) ? escapeInlineCodePipesInTableRow(line) : line,
    )
    .join("\n");
}

const MARKDOWN_HEADING_LINE_REGEX = /^\s{0,3}#{1,6}\s/;
const MARKDOWN_QUOTE_LINE_REGEX = /^\s{0,3}>\s?/;
const MARKDOWN_BULLET_LINE_REGEX = /^\s*[-*+]\s+/;
const MARKDOWN_ORDERED_LIST_LINE_REGEX = /^\s*\d+\.\s+/;
const MARKDOWN_INDENTED_CODE_LINE_REGEX = /^\s{4,}\S/;

function isMarkdownStructuralLine(line: string): boolean {
  return readFenceOpening(line) !== undefined ||
    MARKDOWN_HEADING_LINE_REGEX.test(line) ||
    MARKDOWN_QUOTE_LINE_REGEX.test(line) ||
    MARKDOWN_BULLET_LINE_REGEX.test(line) ||
    MARKDOWN_ORDERED_LIST_LINE_REGEX.test(line) ||
    MARKDOWN_INDENTED_CODE_LINE_REGEX.test(line);
}

export function paragraphizePlainTextSoftBreaks(content: string): string {
  const normalized = content
    .replace(/\r\n/g, "\n")
    .replace(HTML_BREAK_TAG_REGEX, "\n");
  const lines = normalized.split("\n");
  const protectedLines = getProtectedMarkdownLines(lines);

  if (
    lines.some(isMarkdownStructuralLine) ||
    getMarkdownTableLines(lines, protectedLines).size > 0 ||
    lines.filter((line) => line.trim().length > 0).length < 2
  ) {
    return normalized;
  }

  return lines
    .map((line) => line.trimEnd())
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n");
}

function unwrapDelimitedText(value: string, delimiter: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf(delimiter, cursor);
    if (start < 0) return result + value.slice(cursor);
    const end = value.indexOf(delimiter, start + delimiter.length);
    if (end < 0) return result + value.slice(cursor);
    result += value.slice(cursor, start) + value.slice(start + delimiter.length, end);
    cursor = end + delimiter.length;
  }
  return result;
}

function replaceMarkdownLinks(value: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < value.length) {
    const labelStart = value.indexOf("[", cursor);
    if (labelStart < 0) return result + value.slice(cursor);
    const labelEnd = value.indexOf("](", labelStart + 1);
    const urlEnd = labelEnd < 0 ? -1 : value.indexOf(")", labelEnd + 2);
    if (labelEnd < 0 || urlEnd < 0) return result + value.slice(cursor);

    const imageMarker = labelStart > cursor && value[labelStart - 1] === "!" ? 1 : 0;
    result += value.slice(cursor, labelStart - imageMarker);
    result += value.slice(labelStart + 1, labelEnd);
    cursor = urlEnd + 1;
  }
  return result;
}

function stripMarkdownLinePrefix(line: string): string {
  let start = 0;
  while (start < 3 && (line[start] === " " || line[start] === "\t")) start += 1;
  const value = line.slice(start);
  if (value.startsWith(">")) return value.slice(1).trimStart();

  let headingLength = 0;
  while (value[headingLength] === "#") headingLength += 1;
  if (headingLength > 0 && headingLength <= 6 && value[headingLength]?.trim() === "") {
    return value.slice(headingLength).trimStart();
  }

  if (["-", "*", "+"].includes(value[0] ?? "") && value[1]?.trim() === "") {
    return value.slice(1).trimStart();
  }

  let digitCount = 0;
  while (value[digitCount] >= "0" && value[digitCount] <= "9") digitCount += 1;
  return value[digitCount] === "." && value[digitCount + 1]?.trim() === ""
    ? value.slice(digitCount + 1).trimStart()
    : line;
}

function stripHtmlTags(value: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf("<", cursor);
    if (start < 0) return result + value.slice(cursor);
    const end = value.indexOf(">", start + 1);
    if (end < 0) return result + value.slice(cursor);
    result += value.slice(cursor, start) + " ";
    cursor = end + 1;
  }
  return result;
}

export function getMarkdownPreview(content: string, maxLength = 180): string {
  const withoutLinks = replaceMarkdownLinks(
    unwrapDelimitedText(
      unwrapDelimitedText(normalizeMarkdownContent(content), "```"),
      "`",
    ),
  );
  const normalized = stripHtmlTags(
    withoutLinks
      .split("\n")
      .map((line) => stripMarkdownLinePrefix(line))
      .join("\n"),
  )
    .replace(/\|/g, " ")
    .replace(/\*\*|__|\*|_|~~/g, "")
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
  collapsedJsonLabel,
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
            const block = (
              <MarkdownCodeBlock code={code}>
                <pre {...props}>{children}</pre>
              </MarkdownCodeBlock>
            );
            const child = Children.toArray(children)[0];
            const isJson =
              isValidElement<{ className?: string }>(child) &&
              child.props.className?.split(" ").includes("language-json");
            if (!collapsedJsonLabel || !isJson) return block;
            return (
              <details className="my-3 min-w-0 rounded-lg border border-border bg-muted/30 p-3">
                <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
                  {collapsedJsonLabel}
                </summary>
                {block}
              </details>
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
