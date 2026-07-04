import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", async () => {
  const actual =
    await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

vi.mock("@bitsentry-ce/coding-agents/cli-probe.service", () => ({
  probeClaudeCode: vi.fn(),
  probeCodex: vi.fn(),
  probeOpenCode: vi.fn(),
  probeCursor: vi.fn(),
  detectBinary: vi.fn(),
  doctor: vi.fn(),
}));

vi.mock("@bitsentry-ce/coding-agents/codex-provider.service", async () => {
  const actual = await vi.importActual<
    typeof import("@bitsentry-ce/coding-agents/codex-provider.service")
  >("@bitsentry-ce/coding-agents/codex-provider.service");
  return {
    ...actual,
    executeCodex: vi.fn(),
  };
});

vi.mock("@bitsentry-ce/coding-agents/opencode-provider.service", async () => {
  const actual = await vi.importActual<
    typeof import("@bitsentry-ce/coding-agents/opencode-provider.service")
  >("@bitsentry-ce/coding-agents/opencode-provider.service");
  return {
    ...actual,
    executeOpenCode: vi.fn(),
  };
});

vi.mock("@bitsentry-ce/coding-agents/cursor-provider.service", () => ({
  executeCursor: vi.fn(),
  listCursorModels: vi.fn(),
}));

vi.mock("@bitsentry-ce/desktop-cli/runtime/desktop-sentry", () => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import { ChildProcess, execFile } from "child_process";
import {
  CodingAgentsProviderService,
  type CodingAgentsSettingsStore,
} from "@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents";
import {
  detectBinary,
  probeCodex,
  probeOpenCode,
} from "@bitsentry-ce/coding-agents/cli-probe.service";
import { executeCodex } from "@bitsentry-ce/coding-agents/codex-provider.service";
import { executeOpenCode } from "@bitsentry-ce/coding-agents/opencode-provider.service";

function createDbMock(): CodingAgentsSettingsStore {
  return {
    setting: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(null),
    },
  };
}

describe("CodingAgentsProviderService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("silently detects and uses the resolved codex binary without changing the saved path", async () => {
    vi.mocked(detectBinary).mockResolvedValue("/opt/homebrew/bin/codex");
    vi.mocked(probeCodex).mockResolvedValue({
      installed: true,
      version: "0.42.0",
      auth: { status: "authenticated" },
      status: "ready",
    });
    vi.mocked(executeCodex).mockImplementation(({ binaryPath, prompt }) =>
      Promise.resolve({
        output: `${binaryPath}:${prompt}`,
      }),
    );

    const db = createDbMock();
    const service = new CodingAgentsProviderService(db);
    await service.saveSettings({
      codex: {
        enabled: true,
        binaryPath: "codex",
      },
    });

    const result = await service.execute(
      "codex",
      "hello",
      new AbortController(),
    );

    expect(result.output).toBe("/opt/homebrew/bin/codex:hello");
    expect(service.getSettings().codex.binaryPath).toBe("codex");
    expect(service.getSettings().codex.lastProbe?.status).toBe("ready");
  });

  it("fails before execution when the silent startup probe still reports an error", async () => {
    vi.mocked(detectBinary).mockResolvedValue("/opt/homebrew/bin/codex");
    vi.mocked(probeCodex).mockResolvedValue({
      installed: true,
      version: "0.42.0",
      auth: { status: "unknown" },
      status: "error",
      errorKind: "app_server_init_failed",
      message: "Codex app-server probe failed: initialize failed",
    });
    vi.mocked(executeCodex).mockRejectedValue(
      new Error("execute should not run"),
    );

    const db = createDbMock();
    const service = new CodingAgentsProviderService(db);
    await service.saveSettings({
      codex: {
        enabled: true,
        binaryPath: "codex",
      },
    });

    await expect(
      service.execute("codex", "hello", new AbortController()),
    ).rejects.toThrow("Codex app-server probe failed: initialize failed");
  });

  it("passes configured OpenCode args to provider probes", async () => {
    vi.mocked(probeOpenCode).mockImplementation((_binaryPath, opencodeArgs) => {
      let status: "ready" | "error" = "error";
      if (
        JSON.stringify(opencodeArgs) ===
        JSON.stringify(["--provider", "github-copilot"])
      ) {
        status = "ready";
      }
      return Promise.resolve({
        installed: true,
        version: "0.7.0",
        auth: { status: "authenticated" },
        status,
      });
    });

    const db = createDbMock();
    const service = new CodingAgentsProviderService(db);
    await service.saveSettings({
      opencode: {
        enabled: true,
        binaryPath: "opencode",
        opencodeArgs: ["--provider", "github-copilot"],
      },
    });

    const result = await service.probe("opencode");

    expect(result.status).toBe("ready");
    expect(service.getSettings().opencode.lastProbe?.status).toBe("ready");
  });

  it("passes configured OpenCode args when syncing models", async () => {
    vi.mocked(detectBinary).mockResolvedValue(null);
    vi.mocked(execFile).mockImplementation(
      (command, args, options, callback) => {
        let cb = callback;
        if (typeof options === "function") {
          cb = options;
        }
        if (
          command === "opencode" &&
          Array.isArray(args) &&
          args.join("\u0000") ===
            ["--provider", "github-copilot", "models"].join("\u0000")
        ) {
          cb?.(null, "opencode/grok-code-fast-free\n", "");
        } else {
          cb?.(new Error("unexpected models command"), "", "");
        }
        return new ChildProcess();
      },
    );

    const db = createDbMock();
    const service = new CodingAgentsProviderService(db);
    await service.saveSettings({
      opencode: {
        enabled: true,
        binaryPath: "opencode",
        opencodeArgs: ["--provider", "github-copilot"],
      },
    });

    const models = await service.listModels("opencode");

    expect(models).toEqual(["opencode/grok-code-fast-free"]);
  });

  it("retries OpenCode model sync when its database is briefly locked", async () => {
    vi.mocked(detectBinary).mockResolvedValue(null);
    let attempts = 0;
    vi.mocked(execFile).mockImplementation(
      (_command, _args, options, callback) => {
        let cb = callback;
        if (typeof options === "function") {
          cb = options;
        }
        attempts += 1;
        if (attempts === 1) {
          cb?.(
            new Error(
              "Command failed: opencode models\nError: Unexpected error\n\ndatabase is locked",
            ),
            "",
            "Error: Unexpected error\n\ndatabase is locked",
          );
          return new ChildProcess();
        }

        cb?.(null, "opencode/big-pickle\n", "");
        return new ChildProcess();
      },
    );

    const db = createDbMock();
    const service = new CodingAgentsProviderService(db);
    await service.saveSettings({
      opencode: {
        enabled: true,
        binaryPath: "opencode",
      },
    });

    const models = await service.listModels("opencode");

    expect(models).toEqual(["opencode/big-pickle"]);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent OpenCode model sync requests", async () => {
    vi.mocked(detectBinary).mockResolvedValue(null);
    let completeModelsCommand: ((stdout: string) => void) | undefined;
    vi.mocked(execFile).mockImplementation(
      (_command, _args, options, callback) => {
        let cb = callback;
        if (typeof options === "function") {
          cb = options;
        }
        if (cb === undefined || cb === null) {
          throw new Error("Expected execFile callback");
        }
        completeModelsCommand = (stdout: string) => {
          cb(null, stdout, "");
        };
        return new ChildProcess();
      },
    );

    const db = createDbMock();
    const service = new CodingAgentsProviderService(db);
    await service.saveSettings({
      opencode: {
        enabled: true,
        binaryPath: "opencode",
      },
    });

    const first = service.listModels("opencode");
    const second = service.listModels("opencode");
    await Promise.resolve();

    expect(execFile).toHaveBeenCalledTimes(1);
    completeModelsCommand?.("opencode/big-pickle\n");
    await expect(Promise.all([first, second])).resolves.toEqual([
      ["opencode/big-pickle"],
      ["opencode/big-pickle"],
    ]);
  });

  it("uses the detected OpenCode binary when syncing models", async () => {
    vi.mocked(detectBinary).mockResolvedValue("/opt/homebrew/bin/opencode");
    vi.mocked(execFile).mockImplementation(
      (command, args, options, callback) => {
        let cb = callback;
        if (typeof options === "function") {
          cb = options;
        }
        if (
          command === "/opt/homebrew/bin/opencode" &&
          Array.isArray(args) &&
          args.join("\u0000") ===
            ["--provider", "github-copilot", "models"].join("\u0000")
        ) {
          cb?.(null, "resolved/opencode-model\n", "");
        } else {
          cb?.(new Error("unexpected models command"), "", "");
        }
        return new ChildProcess();
      },
    );

    const db = createDbMock();
    const service = new CodingAgentsProviderService(db);
    await service.saveSettings({
      opencode: {
        enabled: true,
        binaryPath: "opencode",
        opencodeArgs: ["--provider", "github-copilot"],
      },
    });

    const models = await service.listModels("opencode");

    expect(models).toEqual(["resolved/opencode-model"]);
  });

  it("uses catalog Cursor models without spawning Cursor ACP during model sync", async () => {
    const db = createDbMock();
    const service = new CodingAgentsProviderService(db);
    await service.saveSettings({
      cursor: {
        enabled: true,
        binaryPath: "cursor-agent",
      },
    });

    const models = await service.listModels("cursor");

    expect(models).toEqual(["composer-2.5"]);
    expect(detectBinary).not.toHaveBeenCalled();
    expect(service.getSettings().cursor.binaryPath).toBe("cursor-agent");
  });

  it("silently detects and uses the resolved opencode binary without changing the saved path", async () => {
    vi.mocked(detectBinary).mockResolvedValue("/opt/homebrew/bin/opencode");
    vi.mocked(probeOpenCode).mockImplementation((binaryPath, opencodeArgs) => {
      let status: "ready" | "error" = "error";
      if (
        binaryPath === "/opt/homebrew/bin/opencode" &&
        JSON.stringify(opencodeArgs) ===
          JSON.stringify(["--provider", "github-copilot"])
      ) {
        status = "ready";
      }
      return Promise.resolve({
        installed: true,
        version: "0.7.0",
        auth: { status: "authenticated" },
        status,
      });
    });
    vi.mocked(executeOpenCode).mockImplementation(
      ({ binaryPath, opencodeArgs, prompt }) => {
        let opencodeArgsText = "";
        if (opencodeArgs !== undefined) {
          opencodeArgsText = opencodeArgs.join(" ");
        }
        return Promise.resolve({
          output: `${binaryPath}:${opencodeArgsText}:${prompt}`,
        });
      },
    );

    const db = createDbMock();
    const service = new CodingAgentsProviderService(db);
    await service.saveSettings({
      opencode: {
        enabled: true,
        binaryPath: "opencode",
        opencodeArgs: ["--provider", "github-copilot"],
      },
    });

    const result = await service.execute(
      "opencode",
      "hello",
      new AbortController(),
    );

    expect(result.output).toBe(
      "/opt/homebrew/bin/opencode:--provider github-copilot:hello",
    );
    expect(service.getSettings().opencode.binaryPath).toBe("opencode");
    expect(service.getSettings().opencode.lastProbe?.status).toBe("ready");
  });
});
