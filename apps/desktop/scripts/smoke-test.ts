import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";

const desktopDir = resolve(__dirname, "../..");
const repositoryDir = resolve(desktopDir, "../..");
const electronBin = require("electron") as string;
const READY_MARKER = "[smoke] desktop-ready";
const RUNBOOK_COMPLETE_MARKER = "[smoke] runbook-completed";
const TIMEOUT_MS = 30_000;
const READY_GRACE_MS = 1_000;
const smokeScenario = process.env.BITSENTRY_DESKTOP_SMOKE_SCENARIO ?? "ready";
const packagedBinary = process.env.BITSENTRY_DESKTOP_SMOKE_BINARY;
const requirePackagedBinary = process.env.BITSENTRY_DESKTOP_SMOKE_REQUIRE_PACKAGED === "1";
let requiredMarkers = [READY_MARKER];
if (smokeScenario === "runbook") {
  requiredMarkers = [READY_MARKER, RUNBOOK_COMPLETE_MARKER];
}

console.log("\nLaunching desktop smoke test...");

let command = electronBin;
let commandArgs = [desktopDir];
if (requirePackagedBinary && (packagedBinary === undefined || packagedBinary.trim() === "")) {
  throw new Error("BITSENTRY_DESKTOP_SMOKE_BINARY is required for a packaged smoke scenario");
}
if (packagedBinary !== undefined && packagedBinary.trim() !== "") {
  const desktopRelativeBinary = resolve(desktopDir, packagedBinary);
  const repositoryRelativeBinary = resolve(repositoryDir, packagedBinary);
  if (existsSync(desktopRelativeBinary)) {
    command = desktopRelativeBinary;
  } else if (existsSync(repositoryRelativeBinary)) {
    command = repositoryRelativeBinary;
  } else {
    const candidateDirectories = [
      dirname(desktopRelativeBinary),
      dirname(repositoryRelativeBinary),
    ];
    const discoveredBinary = candidateDirectories
      .map((directory) => findPackagedAppBinary(directory))
      .find((candidate) => candidate !== null);
    if (discoveredBinary === undefined) {
      throw new Error(
        `Unable to locate packaged desktop binary. Checked: ${desktopRelativeBinary}, ${repositoryRelativeBinary}`,
      );
    }
    command = discoveredBinary;
  }
  commandArgs = [];
}
if (process.env.BITSENTRY_DESKTOP_SMOKE_NO_SANDBOX === "1") {
  commandArgs.push("--no-sandbox");
}
const temporaryUserDataDir = mkdtempSync(
  resolve(os.tmpdir(), "bitsentry-desktop-smoke-"),
);
const smokeMarkerFile = join(temporaryUserDataDir, "markers.log");

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  BITSENTRY_DESKTOP_SMOKE_TEST: "1",
  BITSENTRY_DESKTOP_SMOKE_SCENARIO: smokeScenario,
  BITSENTRY_DESKTOP_SMOKE_MARKER_FILE: smokeMarkerFile,
  BITSENTRY_USER_DATA_DIR: temporaryUserDataDir,
  ELECTRON_ENABLE_LOGGING: "1",
  START_MINIMIZED: "1",
};

delete childEnv.ELECTRON_RUN_AS_NODE;

const child: ChildProcessWithoutNullStreams = spawn(command, commandArgs, {
  cwd: desktopDir,
  detached: process.platform !== "win32",
  stdio: ["pipe", "pipe", "pipe"],
  env: childEnv,
});

let output = "";
const observedMarkers = new Set<string>();
let settled = false;
let readyTimer: NodeJS.Timeout | null = null;
let markerPollTimer: NodeJS.Timeout | null = null;

function isPackagedAppExecutable(candidate: string): boolean {
  const entryName = candidate.split(/[\\/]/).pop() ?? "";
  if (entryName === "bitsentry" || entryName === "bitsentry.cmd") return false;
  if (entryName === "chrome-sandbox" || entryName === "chrome_crashpad_handler") return false;
  if (process.platform === "win32") return entryName.toLowerCase().endsWith(".exe");
  try {
    return (statSync(candidate).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function findPackagedAppBinary(directory: string): string | null {
  if (!existsSync(directory)) return null;

  if (process.platform === "darwin") {
    const appBundle = readdirSync(directory, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
    if (appBundle === undefined) return null;
    const macOsDirectory = join(directory, appBundle.name, "Contents", "MacOS");
    if (!existsSync(macOsDirectory)) return null;
    const executable = readdirSync(macOsDirectory, { withFileTypes: true })
      .find((entry) => entry.isFile() && isPackagedAppExecutable(join(macOsDirectory, entry.name)));
    if (executable === undefined) return null;
    return join(macOsDirectory, executable.name);
  }

  const executable = readdirSync(directory, { withFileTypes: true })
    .find((entry) => entry.isFile() && isPackagedAppExecutable(join(directory, entry.name)));
  if (executable === undefined) return null;
  return join(directory, executable.name);
}

const fatalPatterns = [
  "Cannot find module",
  "Could not locate the bindings file",
  "MODULE_NOT_FOUND",
  "Uncaught Error",
  "Uncaught TypeError",
  "Uncaught ReferenceError",
  "[main] Startup failed:",
  "render-process-gone",
  "preload-error",
  "did-fail-load",
];

function collectFailures(): string[] {
  return fatalPatterns.filter((pattern) => output.includes(pattern));
}

function maybeFailFast(): boolean {
  const failures = collectFailures();
  if (failures.length === 0 || settled) return false;

  let message = "\nDesktop smoke test failed:";
  for (const failure of failures) {
    message += `\n - ${failure}`;
  }
  message += `\n\nFull output:\n${output}`;
  finish(1, message);
  return true;
}

function stopChild(signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {}

  try {
    child.kill(signal);
  } catch {}
}

function finish(code: number, message: string): void {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  if (readyTimer !== null) {
    clearTimeout(readyTimer);
  }
  if (markerPollTimer !== null) {
    clearInterval(markerPollTimer);
  }
  process.exitCode = code;

  if (message.length > 0 && code === 0) {
    console.log(message);
  }

  if (message.length > 0 && code !== 0) {
    console.error(message);
  }

  let signal: NodeJS.Signals = "SIGKILL";
  if (code === 0) {
    signal = "SIGTERM";
  }
  stopChild(signal);
  setTimeout(() => {
    stopChild("SIGKILL");
    rmSync(temporaryUserDataDir, { recursive: true, force: true });
    process.exit(code);
  }, 100);
}

function scheduleSuccessCheck(): void {
  if (readyTimer !== null) return;
  readyTimer = setTimeout(() => {
    const failures = collectFailures();
    if (failures.length > 0) {
      finish(1, `\nDesktop smoke test failed after ready marker.\n\nFull output:\n${output}`);
      return;
    }
    finish(0, "\nDesktop smoke test passed.");
  }, READY_GRACE_MS);
}

function handleOutputChunk(chunk: unknown): void {
  const text = String(chunk);
  output += text;
  if (maybeFailFast()) return;
  observeMarkers(text);
}

function observeMarkers(text: string): void {
  for (const marker of requiredMarkers) {
    if (text.includes(marker)) {
      observedMarkers.add(marker);
    }
  }
  if (observedMarkers.has(READY_MARKER) && observedMarkers.size === requiredMarkers.length) {
    scheduleSuccessCheck();
  }
}

function observeMarkerFile(): void {
  try {
    observeMarkers(readFileSync(smokeMarkerFile, "utf8"));
  } catch {}
}

child.stdout.on("data", handleOutputChunk);
child.stderr.on("data", handleOutputChunk);

const timeout = setTimeout(() => {
  finish(1, `\nDesktop smoke test timed out after ${String(TIMEOUT_MS)}ms.\n\nFull output:\n${output}`);
}, TIMEOUT_MS);

markerPollTimer = setInterval(observeMarkerFile, 25);

child.on("error", (error: Error) => {
  finish(1, `\nDesktop smoke test failed to launch.\n\n${String(error)}`);
});

child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
  if (settled) return;
  const failures = collectFailures();
  if (failures.length > 0) {
    let message = "\nDesktop smoke test failed:";
    for (const failure of failures) {
      message += `\n - ${failure}`;
    }
    message += `\n\nFull output:\n${output}`;
    finish(1, message);
    return;
  }

  const missingMarkers = requiredMarkers.filter((marker) => !observedMarkers.has(marker));
  if (missingMarkers.length > 0) {
    finish(1, `\nDesktop smoke test failed: required marker(s) were never observed: ${missingMarkers.join(", ")}.\n\nFull output:\n${output}`);
    return;
  }

  if (code !== 0 && code !== null) {
    finish(1, `\nDesktop smoke test failed: process exited with code ${String(code)}.\n\nFull output:\n${output}`);
    return;
  }

  if (signal !== null) {
    finish(1, `\nDesktop smoke test failed: process exited from signal ${signal}.\n\nFull output:\n${output}`);
    return;
  }

  finish(0, "\nDesktop smoke test passed.");
});
