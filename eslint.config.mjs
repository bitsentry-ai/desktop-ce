import { createPackageConfig } from "./scripts/eslint/create-config.mjs";

export default createPackageConfig({
  react: true,
  ignores: [
    ".worktrees/**",
    "**/.worktrees/**",
    "packages/electron-trpc/**",
    "packages/plugin-sdk/**",
    "packages/plugins/**",
  ],
  tsconfigRootDir: import.meta.dirname,
});
