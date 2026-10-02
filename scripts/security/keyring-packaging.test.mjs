import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runAfterPack } from "../../packages/desktop-cli/dist/packaging/after-pack.js";

const projectRoot = fileURLToPath(
  new URL("../../apps/desktop/", import.meta.url),
);
const require = createRequire(import.meta.url);
const suffixes = { darwin: "", linux: "-gnu", win32: "-msvc" };

for (const [architecture, arch] of [
  ["x64", 1],
  ["arm64", 3],
]) {
  test(
    `packaged CLI includes the ${architecture} keyring native runtime`,
    {
      skip: suffixes[process.platform] === undefined,
    },
    async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "keyring-packaging-"),
      );
      try {
        const appOutDir = path.join(
          directory,
          process.platform === "darwin"
            ? "BitSentry-Desktop.app"
            : "bitsentry-desktop",
        );
        await mkdir(appOutDir);
        await runAfterPack(
          { appOutDir, electronPlatformName: process.platform, arch },
          projectRoot,
        );

        const resourcesDir =
          process.platform === "darwin"
            ? path.join(appOutDir, "Contents", "Resources")
            : path.join(appOutDir, "resources");
        const nodeModulesDir = path.join(
          resourcesDir,
          "app.asar.unpacked",
          "node_modules",
        );
        const bindingName = `@napi-rs/keyring-${process.platform}-${architecture}${suffixes[process.platform]}`;
        const bindingDir = path.join(nodeModulesDir, bindingName);
        const binding = JSON.parse(
          await readFile(path.join(bindingDir, "package.json"), "utf8"),
        );

        assert.deepEqual(binding.cpu, [architecture]);
        assert.deepEqual(binding.os, [process.platform]);
        assert.match(binding.main, /\.node$/);
        assert.ok((await stat(path.join(bindingDir, binding.main))).isFile());
        await access(path.join(resourcesDir, "cli", "cli.js"));
        if (architecture === process.arch) {
          const loader = require(path.join(nodeModulesDir, "@napi-rs/keyring"));
          assert.equal(typeof loader.Entry, "function");
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
