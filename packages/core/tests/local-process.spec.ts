import { spawn, type ChildProcess } from "child_process";
import { Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  acquireChildProcess,
  terminateProcessTree,
} from "../src/features/agent-runtime/shared/local-process";

const posixOnly = it.skipIf(process.platform === "win32");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("local process termination", () => {
  posixOnly("kills a SIGTERM-ignoring process group including grandchildren", async () => {
    const child = spawn("/bin/sh", ["-c", 'trap "" TERM; sleep 30 & echo $!; wait'], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const grandchildPid = await new Promise<number>((resolve) => {
      child.stdout.once("data", (data: Buffer) => { resolve(Number(data.toString().trim())); });
    });

    const result = await terminateProcessTree(child, { graceMs: 100, forceKillWaitMs: 1_000 });

    expect(result.outcome).toBe("forcefully-terminated");
    await vi.waitFor(() => { expect(isAlive(grandchildPid)).toBe(false); }, { timeout: 1_000 });
  });

  posixOnly("a timed-out scoped process has exited before the effect completes", async () => {
    let child: ChildProcess | undefined;
    const program = Effect.scoped(
      Effect.gen(function* () {
        const scoped = yield* acquireChildProcess(
          () => spawn("/bin/sh", ["-c", 'trap "" TERM; echo ready; while :; do sleep 1; done'], {
            detached: true,
            stdio: ["ignore", "pipe", "ignore"],
          }),
          { graceMs: 100 },
        );
        child = scoped;
        // Start the deadline only once the TERM trap is installed.
        yield* Effect.promise(() => new Promise((resolve) => scoped.stdout.once("data", resolve)));
        yield* Effect.never.pipe(Effect.timeout(100));
      }),
    );

    const exit = await Effect.runPromiseExit(program);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(child?.signalCode).toBe("SIGKILL");
  });
});
