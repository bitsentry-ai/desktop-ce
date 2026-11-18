import { useMemo } from "react";

import { tokenizeJson, type JsonTokenKind } from "./jsonTokens";

// Restrained on purpose: keys read as plain text, values pick up the theme's
// status text colours, structure recedes.
const TOKEN_CLASS: Record<JsonTokenKind, string | undefined> = {
  key: "text-foreground",
  string: "text-[hsl(var(--success-text))]",
  number: "text-[hsl(var(--info-text))]",
  literal: "text-[hsl(var(--warning-text))]",
  punctuation: "text-muted-foreground",
  text: undefined,
};

/** Syntax-coloured JSON text, meant to sit inside a `<pre>`. */
export function HighlightedJson({ text }: { text: string }) {
  const tokens = useMemo(() => tokenizeJson(text), [text]);
  return (
    <>
      {tokens.map((token) => (
        <span key={token.start} className={TOKEN_CLASS[token.kind]}>
          {token.text}
        </span>
      ))}
    </>
  );
}
