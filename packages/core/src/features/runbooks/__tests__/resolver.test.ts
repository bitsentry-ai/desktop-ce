import {
  resolveRequiredRunbookTemplate,
  TemplateResolutionError,
  TemplateResolver,
} from "../resolver";
import { expect, it } from "vitest";

const assert = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected "${String(expected)}", got "${String(actual)}"`,
    );
  }
};

it("resolves legacy, runtime, and secure template references", () => {
const legacy = resolveRequiredRunbookTemplate("psql -h {{ db_host }}", {
  parameterDefinitions: [
    {
      key: "db_host",
      defaultValue: "localhost",
      required: true,
    },
  ],
});
assertEqual(legacy, "psql -h localhost", "legacy default should resolve");

const params = new TemplateResolver({
  params: {
    service: "api",
  },
}).resolveRequired("restart ${params.service}");
assertEqual(params, "restart api", "runtime param should resolve");

const globals = new TemplateResolver({
  globals: {
    env: "production",
  },
}).resolveRequired("target ${globals.env}");
assertEqual(globals, "target production", "global value should resolve");

const steps = new TemplateResolver({
  steps: [
    {
      actionId: "second",
      order: 2,
      status: "completed",
      output: "second-output",
    },
    {
      actionId: "first",
      order: 1,
      status: "completed",
      output: "first-output",
      structuredOutput: {
        active: 47,
        nested: {
          traceId: "trace-123",
        },
      },
    },
  ],
});
assertEqual(
  steps.resolveRequired("previous ${steps.0.output}"),
  "previous first-output",
  "step output should resolve by runbook order",
);
assertEqual(
  steps.resolveRequired("active=${steps.0.structuredOutput.active}"),
  "active=47",
  "nested structured output should resolve",
);
assertEqual(
  steps.resolveRequired("trace=${steps.0.structuredOutput.nested.traceId}"),
  "trace=trace-123",
  "deep structured output should resolve",
);

let missingError: unknown;
try {
  steps.resolveRequired("missing=${steps.0.structuredOutput.missing}");
} catch (error) {
  missingError = error;
}
assert(
  missingError instanceof TemplateResolutionError,
  "required unresolved reference should throw TemplateResolutionError",
);
assert(
  missingError instanceof TemplateResolutionError &&
    missingError.missing.includes("steps.0.structuredOutput.missing"),
  "required unresolved reference should report missing path",
);

const secureParam = new TemplateResolver({
  params: {
    api_token: "token-123",
  },
  parameterDefinitions: [
    {
      key: "api_token",
      secure: true,
    },
  ],
}).resolve("token=${params.api_token}", { secureValueMode: "placeholder" });
assertEqual(
  secureParam.value,
  "token=[secure:api_token]",
  "secure param should become a placeholder for LLM-safe resolution",
);
assert(
  secureParam.secureReferences.includes("params.api_token"),
  "secure param reference should be tracked",
);

const secureGlobal = new TemplateResolver({
  globals: {
    webhook: "https://hooks.example/secret",
  },
  globalDefinitions: [
    {
      key: "webhook",
      secure: true,
    },
  ],
}).resolve("url=${globals.webhook}", { secureValueMode: "placeholder" });
assertEqual(
  secureGlobal.value,
  "url=[secure-global:webhook]",
  "secure global should use secure-global placeholder",
);
expect(secureGlobal.value).toBe("url=[secure-global:webhook]");
});
