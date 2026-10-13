// Mirrored factory: edit this file with its counterpart in the sibling repository.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import tseslint from "typescript-eslint";

const sharedIgnores = [
  "**/node_modules/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/coverage/**",
  "**/dist/**",
  ".worktrees/**",
  "**/build/**",
  "**/out/**",
  "**/release/**",
  "**/playwright-report/**",
  "**/.generated-trpc-types/**",
  "**/src/@generated/**",
  "apps/desktop/src/main/generated/**",
  "**/generated/**",
  "**/*.d.ts",
];

const sharedStyleRules = {
  eqeqeq: ["error", "always", { null: "ignore" }],
  "no-var": "error",
};

// Correctness: catch dead code, lost error causes, and impossible control flow.
const correctnessRules = {
  "array-callback-return": "error",
  "default-case-last": "error",
  "no-constructor-return": "error",
  "no-empty": "error",
  "no-self-compare": "error",
  "no-sequences": "error",
  "no-throw-literal": "error",
  "no-unmodified-loop-condition": "error",
  "no-unreachable-loop": "error",
  "no-useless-assignment": "error",
  "no-useless-catch": "error",
  "preserve-caught-error": "error",
  "prefer-promise-reject-errors": "error",
  radix: "error",
  "require-yield": "error",
  "@typescript-eslint/no-loop-func": "error",
  "@typescript-eslint/no-non-null-assertion": "error",
  "@typescript-eslint/no-shadow": [
    "error",
    { allow: ["_"], ignoreOnInitialization: true },
  ],
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      caughtErrors: "none",
      destructuredArrayIgnorePattern: "^_",
      ignoreRestSiblings: true,
      varsIgnorePattern: "^_",
    },
  ],
  "unicorn/error-message": "error",
  "unicorn/new-for-builtins": "error",
  "unicorn/no-chained-comparison": "error",
  "unicorn/no-instanceof-array": "error",
  "unicorn/prefer-number-properties": "error",
  "unicorn/throw-new-error": "error",
};

// Readability: one obvious way to express a branch, loop, or lookup.
const readabilityRules = {
  "no-case-declarations": "error",
  "no-else-return": "error",
  "no-implicit-coercion": "error",
  "no-lonely-if": "error",
  "no-nested-ternary": "error",
  "no-return-assign": "error",
  "no-unneeded-ternary": "error",
  "no-useless-computed-key": "error",
  "no-useless-concat": "error",
  "no-useless-escape": "error",
  "no-useless-rename": "error",
  "no-useless-return": "error",
  "object-shorthand": "error",
  "prefer-arrow-callback": ["error", { allowNamedFunctions: true }],
  "prefer-const": "error",
  "prefer-exponentiation-operator": "error",
  "prefer-object-spread": "error",
  "prefer-template": "error",
  "@typescript-eslint/consistent-generic-constructors": "error",
  "@typescript-eslint/default-param-last": "error",
  "@typescript-eslint/no-confusing-non-null-assertion": "error",
  "@typescript-eslint/no-empty-object-type": "error",
  "@typescript-eslint/no-inferrable-types": "error",
  "@typescript-eslint/no-useless-empty-export": "error",
  "@typescript-eslint/prefer-for-of": "error",
  "@typescript-eslint/prefer-function-type": "error",
  "sonarjs/cognitive-complexity": ["error", 15],
  "sonarjs/no-nested-conditional": "error",
  "unicorn/no-for-loop": "error",
  "unicorn/no-negated-condition": "error",
  "unicorn/no-unnecessary-boolean-comparison": "error",
  "unicorn/no-unreadable-iife": "error",
  "unicorn/no-useless-boolean-cast": "error",
  "unicorn/no-useless-else": "error",
  "unicorn/no-useless-fallback-in-spread": "error",
  "unicorn/no-useless-promise-resolve-reject": "error",
  "unicorn/no-useless-switch-case": "error",
  "unicorn/no-zero-fractions": "error",
  "unicorn/prefer-array-find": "error",
  "unicorn/prefer-array-flat": "error",
  "unicorn/prefer-array-flat-map": "error",
  "unicorn/prefer-array-index-of": "error",
  "unicorn/prefer-array-some": "error",
  "unicorn/prefer-date-now": "error",
  "unicorn/prefer-default-parameters": "error",
  "unicorn/prefer-else-if": "error",
  "unicorn/prefer-includes": "error",
  "unicorn/prefer-logical-operator-over-ternary": "error",
  "unicorn/prefer-node-protocol": "error",
  "unicorn/prefer-optional-catch-binding": "error",
  "unicorn/prefer-regexp-test": "error",
  "unicorn/prefer-single-call": "error",
  "unicorn/prefer-string-slice": "error",
  "unicorn/prefer-string-starts-ends-with": "error",
};

const sharedTypeScriptRules = {
  ...sharedStyleRules,
  ...correctnessRules,
  ...readabilityRules,
  "no-unused-vars": "off",
  "@typescript-eslint/no-explicit-any": [
    "error",
    {
      fixToUnknown: true,
      ignoreRestArgs: false,
    },
  ],
};

const sharedGlobals = {
  ...globals.browser,
  ...globals.node,
  ...globals.jest,
};

const testStyleRuleOverrides = {
  files: ["**/*.{spec,test}.{ts,tsx}", "**/*.e2e-spec.ts", "**/__tests__/**/*.{ts,tsx}"],
  rules: {
    "@typescript-eslint/consistent-type-assertions": "off",
    "@typescript-eslint/no-extraneous-class": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    "sonarjs/no-clear-text-protocols": "off",
    "sonarjs/no-hardcoded-ip": "off",
    "sonarjs/no-hardcoded-passwords": "off",
  },
};

// Build and smoke scripts load compiled CommonJS output at runtime.
const scriptRequireOverride = {
  files: ["**/scripts/**/*.{ts,mts,cts}"],
  rules: {
    "@typescript-eslint/no-require-imports": "off",
  },
};

// WorkOS publishes this fixed webhook CIDR as part of its documented allowlist.
const workosWebhookIpOverride = {
  files: ["**/workos-webhook.controller.ts"],
  rules: {
    "sonarjs/no-hardcoded-ip": "off",
  },
};

// Seed records use private-network examples as intentional fixture data.
const demoFixtureIpOverride = {
  files: ["**/seed-comprehensive.ts"],
  rules: {
    "sonarjs/no-hardcoded-ip": "off",
  },
};

export function createPackageConfig({
  ignores = [],
  react = false,
  extraRules = {},
  tsconfigRootDir,
  overrides = [],
} = {}) {
  const reactRules = react
    ? {
        "react-hooks/rules-of-hooks": "error",
        "react-hooks/exhaustive-deps": "warn",
        "react-refresh/only-export-components": [
          "warn",
          { allowConstantExport: true },
        ],
      }
    : {};

  return tseslint.config(
    { ignores: [...sharedIgnores, ...ignores] },
    {
      extends: [
        js.configs.recommended,
        ...tseslint.configs.strict,
        { ...sonarjs.configs.recommended, plugins: {} },
      ],
      files: ["**/*.{ts,tsx,mts,cts}"],
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        globals: sharedGlobals,
        parserOptions: { tsconfigRootDir },
      },
      plugins: {
        sonarjs,
        unicorn,
        ...(react
          ? {
              "react-hooks": reactHooks,
              "react-refresh": reactRefresh,
            }
          : {}),
      },
      rules: {
        ...sharedTypeScriptRules,
        ...reactRules,
        ...extraRules,
      },
    },
    testStyleRuleOverrides,
    scriptRequireOverride,
    workosWebhookIpOverride,
    demoFixtureIpOverride,
    ...overrides,
  );
}
