/**
 * Host tools report failures to the agent as a JSON string so it can read the
 * code and the offending field paths and retry. That payload is for the model,
 * not for a person: rendering it verbatim shows the operator a wall of JSON with
 * internal paths like `operations.0.action.pluginId` in it.
 *
 * This turns the payload back into a summary sentence plus the field-level
 * detail, so a UI can lead with the sentence and keep the rest behind a
 * disclosure. Anything that is not a structured host-tool error is passed
 * through untouched.
 */

export interface HostToolErrorIssue {
  path: string;
  message: string;
}

export interface ParsedHostToolError {
  /** One human-readable sentence. Never empty when the input is non-empty. */
  summary: string;
  /** Field-level detail, empty when the payload carried none. */
  issues: HostToolErrorIssue[];
  /** Machine code, when the payload declared one. */
  code?: string;
  /** True when the input parsed as a structured host-tool error. */
  structured: boolean;
  /** The original string, for a technical-details view. */
  raw: string;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readIssues(value: unknown): HostToolErrorIssue[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const message = readString(record, 'message');
    if (message === undefined) {
      return [];
    }

    return [{ path: readString(record, 'path') ?? '', message }];
  });
}

export function parseHostToolError(raw: string): ParsedHostToolError {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { summary: '', issues: [], structured: false, raw };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { summary: trimmed, issues: [], structured: false, raw };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { summary: trimmed, issues: [], structured: false, raw };
  }

  const record = parsed as Record<string, unknown>;
  const message = readString(record, 'message');
  const code = readString(record, 'code');
  const issues = readIssues(record.issues);

  if (message === undefined && code === undefined && issues.length === 0) {
    // Valid JSON, but not one of ours. Showing the object is better than
    // claiming a summary we do not have.
    return { summary: trimmed, issues: [], structured: false, raw };
  }

  return {
    // A payload can carry a code and issues without a message; fall back to the
    // first issue rather than surfacing the bare code.
    summary: message ?? issues[0]?.message ?? code ?? trimmed,
    issues,
    ...(code === undefined ? {} : { code }),
    structured: true,
    raw,
  };
}
