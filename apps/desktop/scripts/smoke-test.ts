import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";

const desktopDir = resolve(__dirname, "../..");
const electronBin = require("electron") as string;
const READY_MARKER = "[smoke] desktop-ready";
const RUNBOOK_COMPLETE_MARKER = "[smoke] runbook-completed";
const TIMEOUT_MS = 30_000;
const READY_GRACE_MS = 1_000;
const smokeScenario = process.env.BITSENTRY_DESKTOP_SMOKE_SCENARIO ?? "ready";
let requiredMarkers = [READY_MARKER];
if (smokeScenario === "runbook") {
  requiredMarkers = [READY_MARKER, RUNBOOK_COMPLETE_MARKER];
}

console.log("\nLaunching desktop smoke test...");

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  BITSENTRY_DESKTOP_SMOKE_TEST: "1",
  BITSENTRY_DESKTOP_SMOKE_SCENARIO: smokeScenario,
  ELECTRON_ENABLE_LOGGING: "1",
  START_MINIMIZED: "1",
};

delete childEnv.ELECTRON_RUN_AS_NODE;

const child: ChildProcessWithoutNullStreams = spawn(electronBin, [desktopDir], {
  cwd: desktopDir,
  detached: process.platform !== "win32",
  stdio: ["pipe", "pipe", "pipe"],
  env: childEnv,
});

let output = "";
const observedMarkers = new Set<string>();
let settled = false;
let readyTimer: NodeJS.Timeout | null = null;

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
    process.exit(code);
  }, 100);
}

function scheduleSuccessCheck(): void {
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
  for (const marker of requiredMarkers) {
    if (text.includes(marker)) {
      observedMarkers.add(marker);
    }
  }
  if (observedMarkers.has(READY_MARKER) && observedMarkers.size === requiredMarkers.length) {
    scheduleSuccessCheck();
  }
}

child.stdout.on("data", handleOutputChunk);
child.stderr.on("data", handleOutputChunk);

const timeout = setTimeout(() => {
  finish(1, `\nDesktop smoke test timed out after ${String(TIMEOUT_MS)}ms.\n\nFull output:\n${output}`);
}, TIMEOUT_MS);

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
