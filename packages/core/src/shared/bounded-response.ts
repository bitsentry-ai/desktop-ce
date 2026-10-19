export interface BoundedResponseText {
  text: string;
  truncated: boolean;
}

/**
 * Reads at most `maxLength` characters of a response body, cancelling the
 * stream once the limit is passed instead of buffering the whole body.
 */
export async function readBoundedResponseText(
  response: Response,
  maxLength: number,
): Promise<BoundedResponseText> {
  if (response.body === null) return { text: "", truncated: false };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let done = false;
  try {
    while (!done && text.length <= maxLength) {
      const chunk = await reader.read();
      done = chunk.done;
      text += chunk.done
        ? decoder.decode()
        : decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
  }

  if (text.length <= maxLength) return { text, truncated: false };
  let end = maxLength;
  const lastKept = text.charCodeAt(end - 1);
  // Do not keep half of a surrogate pair split by the limit.
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}
