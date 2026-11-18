/**
 * Splits pretty-printed JSON into coloured runs for the Results output block.
 *
 * The input is display text, not strict JSON: string escapes may already be
 * expanded into real newlines and the text may be cut off mid-value by the
 * line cap. The scanner is a single forward pass with no regular expressions,
 * so neither costs more than one look at each character, and anything it does
 * not recognise is passed through as plain text.
 */

export type JsonTokenKind =
  | "key"
  | "string"
  | "number"
  | "literal"
  | "punctuation"
  | "text";

export interface JsonToken {
  kind: JsonTokenKind;
  text: string;
  /** Offset of the token in the source text; unique, so usable as a key. */
  start: number;
}

const LITERALS = new Set(["true", "false", "null"]);
const PUNCTUATION = new Set(["{", "}", "[", "]", ",", ":"]);
const NUMBER_PARTS = new Set(["-", "+", ".", "e", "E"]);

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

function isWhitespace(character: string): boolean {
  return (
    character === " " ||
    character === "\n" ||
    character === "\r" ||
    character === "\t"
  );
}

function isWordCharacter(character: string): boolean {
  return (
    (character >= "a" && character <= "z") ||
    (character >= "A" && character <= "Z")
  );
}

function isNumberCharacter(character: string): boolean {
  return isDigit(character) || NUMBER_PARTS.has(character);
}

function isOtherCharacter(character: string): boolean {
  return !(
    character === '"' ||
    character === "-" ||
    isDigit(character) ||
    isWordCharacter(character) ||
    isWhitespace(character) ||
    PUNCTUATION.has(character)
  );
}

function scanWhile(
  text: string,
  start: number,
  predicate: (character: string) => boolean,
): number {
  let index = start;
  while (index < text.length && predicate(text[index])) index += 1;
  return index;
}

/** Index just past the closing quote, or the end of the text if it is cut off. */
function scanString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\") {
      index += 2;
    } else if (character === '"') {
      return index + 1;
    } else {
      index += 1;
    }
  }
  return text.length;
}

function isFollowedByColon(text: string, index: number): boolean {
  const next = scanWhile(
    text,
    index,
    (character) => character === " " || character === "\t",
  );
  return text[next] === ":";
}

function scanToken(
  text: string,
  start: number,
): { kind: JsonTokenKind; end: number } {
  const character = text[start];
  if (character === '"') {
    const end = scanString(text, start);
    return { kind: isFollowedByColon(text, end) ? "key" : "string", end };
  }
  if (character === "-" || isDigit(character)) {
    return { kind: "number", end: scanWhile(text, start, isNumberCharacter) };
  }
  if (isWordCharacter(character)) {
    const end = scanWhile(text, start, isWordCharacter);
    return {
      kind: LITERALS.has(text.slice(start, end)) ? "literal" : "text",
      end,
    };
  }
  // Whitespace rides along with punctuation so a `,\n    ` run stays one node.
  if (isWhitespace(character) || PUNCTUATION.has(character)) {
    const end = scanWhile(
      text,
      start + 1,
      (next) => isWhitespace(next) || PUNCTUATION.has(next),
    );
    return { kind: "punctuation", end };
  }
  return { kind: "text", end: scanWhile(text, start + 1, isOtherCharacter) };
}

export function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let index = 0;
  while (index < text.length) {
    const { kind, end } = scanToken(text, index);
    const value = text.slice(index, end);
    const previous = tokens[tokens.length - 1] as JsonToken | undefined;
    if (
      previous !== undefined &&
      previous.kind === kind &&
      kind !== "key" &&
      kind !== "string"
    ) {
      previous.text += value;
    } else {
      tokens.push({ kind, text: value, start: index });
    }
    index = end;
  }
  return tokens;
}
