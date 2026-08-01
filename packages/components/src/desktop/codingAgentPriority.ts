import type { ProviderId as CodingAgentId } from "../settings/CodingAgentProvidersSection";

export const CODING_AGENT_PRIORITY = [
  "codex",
  "claude_code",
  "opencode",
  "cursor",
] as const satisfies readonly CodingAgentId[];
