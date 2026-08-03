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

export const sharedStyleRules = {
  eqeqeq: ["error", "always", { null: "ignore" }],
  "no-var": "error",
};

export const sharedTypeScriptRules = {
  ...sharedStyleRules,
  "@typescript-eslint/no-require-imports": "off",
  "no-empty": "off",
  "no-case-declarations": "off",
  "no-unused-vars": "off",
  "no-useless-catch": "off",
  "no-useless-assignment": "off",
  "no-useless-escape": "off",
  "prefer-const": "off",
  "preserve-caught-error": "off",
  "@typescript-eslint/no-empty-object-type": "off",
  "@typescript-eslint/no-unused-vars": "off",
  "require-yield": "off",
  "@typescript-eslint/no-explicit-any": [
    "error",
    {
      fixToUnknown: true,
      ignoreRestArgs: false,
    },
  ],
  "@typescript-eslint/consistent-type-assertions": "off",
  "@typescript-eslint/no-non-null-assertion": "off",
  "@typescript-eslint/strict-boolean-expressions": "off",
  "no-ternary": "off",
  "no-nested-ternary": "off",
  "no-unneeded-ternary": "off",
  "no-restricted-syntax": "off",
  "unicorn/filename-case": "off",
  "unicorn/no-nested-ternary": "off",
  "unicorn/no-null": "off",
  "unicorn/no-useless-undefined": "off",
  "unicorn/prefer-optional-catch-binding": "warn",
  "unicorn/prevent-abbreviations": "off",
  "sonarjs/cognitive-complexity": ["error", 15],
  "sonarjs/no-nested-conditional": "off",
};

const sharedGlobals = {
  ...globals.browser,
  ...globals.node,
  ...globals.jest,
};

const testStyleRuleOverrides = {
  files: ["**/*.{spec,test}.{ts,tsx}", "**/__tests__/**/*.{ts,tsx}"],
  rules: {
    "@typescript-eslint/consistent-type-assertions": "off",
    "@typescript-eslint/no-extraneous-class": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    "no-nested-ternary": "off",
    "no-restricted-syntax": "off",
    "no-ternary": "off",
    "no-unneeded-ternary": "off",
    "unicorn/no-nested-ternary": "off",
    "unicorn/no-useless-undefined": "off",
    "sonarjs/no-hardcoded-ip": "off",
    "sonarjs/no-hardcoded-passwords": "off",
  },
};

// WorkOS publishes this fixed webhook CIDR as part of its documented allowlist.
const workosWebhookIpOverride = {
  files: ["apps/backend/src/features/workos/workos-webhook.controller.ts"],
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
    workosWebhookIpOverride,
    ...overrides,
  );
}
