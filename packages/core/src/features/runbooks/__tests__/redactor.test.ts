import { SecureRedactor } from "../redactor";
import { expect, it } from "vitest";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected "${String(expected)}", got "${String(actual)}"`,
    );
  }
};

const assertDeepEqual = (
  actual: unknown,
  expected: unknown,
  message: string,
): void => {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);

  if (actualJson !== expectedJson) {
    throw new Error(
      `${message}: expected ${expectedJson}, got ${actualJson}`,
    );
  }
};

it("redacts secure values across nested runbook output", () => {
const redactor = new SecureRedactor([
  {
    key: "api_token",
    value: "token-123",
    derivedValues: ["token%2D123"],
  },
  {
    key: "webhook",
    namespace: "globals",
    value: "https://hooks.example/secret",
  },
]);

assertEqual(
  redactor.redactString("Authorization: Bearer token-123"),
  "Authorization: Bearer [secure:api_token]",
  "exact secret value should be redacted in strings",
);

assertEqual(
  redactor.redactString("encoded=token%2D123"),
  "encoded=[secure:api_token]",
  "derived secret value should be redacted in strings",
);

assertDeepEqual(
  redactor.redact({
    input: {
      command: "curl -H 'Authorization: token-123'",
      url: "https://hooks.example/secret",
    },
    metadata: {
      auth: "token-123",
      nested: {
        webhook: "https://hooks.example/secret",
      },
    },
    structuredOutput: {
      token: "token-123",
      list: ["safe", "token-123"],
    },
  }),
  {
    input: {
      command: "curl -H 'Authorization: [secure:api_token]'",
      url: "[secure-global:webhook]",
    },
    metadata: {
      auth: "[secure:api_token]",
      nested: {
        webhook: "[secure-global:webhook]",
      },
    },
    structuredOutput: {
      token: "[secure:api_token]",
      list: ["safe", "[secure:api_token]"],
    },
  },
  "recursive redaction should cover input, metadata, structuredOutput, arrays, and objects",
);

const shared = {
  token: "token-123",
};
assertDeepEqual(
  redactor.redact({
    first: shared,
    second: shared,
  }),
  {
    first: {
      token: "[secure:api_token]",
    },
    second: {
      token: "[secure:api_token]",
    },
  },
  "recursive redaction should handle shared object references without leaking",
);

const emptySecretRedactor = new SecureRedactor([
  {
    key: "empty",
    value: "",
  },
]);
assertEqual(
  emptySecretRedactor.redactString("abc"),
  "abc",
  "empty secure values should be ignored",
);
expect(emptySecretRedactor.redactString("abc")).toBe("abc");
});
