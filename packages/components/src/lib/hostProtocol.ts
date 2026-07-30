const HIDDEN_HOST_BLOCKS = [
  {
    openPrefix: "<bitsentry_tool_result",
    closeTag: "</bitsentry_tool_result>",
  },
  {
    openPrefix: "<bitsentry_host_instruction",
    closeTag: "</bitsentry_host_instruction>",
  },
  {
    openPrefix: "<bitsentry_host_protocol",
    closeTag: "</bitsentry_host_protocol>",
  },
  {
    openPrefix: "<function_calls",
    closeTag: "</function_calls>",
  },
  {
    openPrefix: "<invoke",
    closeTag: "</invoke>",
  },
  {
    openPrefix: "<tool_use",
    closeTag: "</tool_use>",
  },
] as const;

const STANDALONE_HOST_TAG_LINE =
  /^\s*<\/?bitsentry_(?:tool_result|host_instruction|host_protocol)\b[^>]*>\s*$/gim;

export function stripInternalHostBlocks(value: string): string {
  let sanitized = value;

  for (const block of HIDDEN_HOST_BLOCKS) {
    const escapedOpenPrefix = block.openPrefix.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const escapedCloseTag = block.closeTag.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    sanitized = sanitized.replace(
      new RegExp(
        `${escapedOpenPrefix}[^>]*>[\\s\\S]*?${escapedCloseTag}\\s*`,
        "gi",
      ),
      "\n\n",
    );
    sanitized = sanitized.replace(
      new RegExp(`${escapedOpenPrefix}\\b[\\s\\S]*$`, "gi"),
      "\n\n",
    );
  }

  return sanitized
    .replace(STANDALONE_HOST_TAG_LINE, "\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
