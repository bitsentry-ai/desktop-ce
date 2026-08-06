import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", async () => {
  const actual =
    await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

vi.mock("@bitsentry-ce/desktop-cli/runtime/desktop-sentry", () => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import { ChildProcess, execFile } from "child_process";
import {
  CodingAgentsProviderService,
  type CodingAgentsProviderDependencies,
  type CodingAgentsSettingsStore,
} from "@bitsentry-ce/coding-agents/coding-agents-provider.service";
import {
  getCatalogModel,
  getCatalogModelIds,
  getEffectiveComposerOptions,
  resolveCatalogModelRuntimeSelection,
} from "@bitsentry-ce/components/llm/modelCatalog";

const cli = {
  detectBinary: vi.fn(),
  doctor: vi.fn(),
  probeClaudeCode: vi.fn(),
  probeCodex: vi.fn(),
  probeOpenCode: vi.fn(),
  probeCursor: vi.fn(),
  executeClaudeCode: vi.fn(),
  executeCodex: vi.fn(),
  executeOpenCode: vi.fn(),
  executeCursor: vi.fn(),
};

const {
  detectBinary,
  probeClaudeCode,
  probeCodex,
  probeOpenCode,
  executeClaudeCode,
  executeCodex,
  executeOpenCode,
} = cli;

function createDbMock(): CodingAgentsSettingsStore {
  return {
    setting: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(null),
    },
  };
}

function createService(
  db: CodingAgentsSettingsStore,
): CodingAgentsProviderService {
  const dependencies: CodingAgentsProviderDependencies = {
    executeOpenCode: cli.executeOpenCode as never,
    executeClaudeCode: cli.executeClaudeCode as never,
    executeCodex: cli.executeCodex as never,
    executeCursor: cli.executeCursor as never,
    detectBinary: cli.detectBinary as never,
    doctor: cli.doctor as never,
    probeClaudeCode: cli.probeClaudeCode as never,
    probeCodex: cli.probeCodex as never,
    probeOpenCode: cli.probeOpenCode as never,
    probeCursor: cli.probeCursor as never,
    reportError: vi.fn(),
  };
  return new CodingAgentsProviderService(db, dependencies);
}

describe("CodingAgentsProviderService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes Opus 5 with separate effort and context options", () => {
    const catalogModel = getCatalogModel("claude_code", "claude-opus-5");
    expect(catalogModel).toMatchObject({
      id: "claude-opus-5",
      displayName: "Claude Opus 5",
    });
    expect(getEffectiveComposerOptions(catalogModel!)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "effort" }),
        expect.objectContaining({ id: "contextWindow" }),
      ]),
    );
    expect(getEffectiveComposerOptions(catalogModel!)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fastMode" })]),
    );
    expect(
      resolveCatalogModelRuntimeSelection("claude_code", "claude-opus-5", {
        effort: "high",
        contextWindow: "1m",
      }),
    ).toEqual({
      modelId: "claude-opus-5",
      traitValues: { effort: "high", contextWindow: "1m" },
    });
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
    const service = createService(db);
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
    const service = createService(db);
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
    const service = createService(db);
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
    const service = createService(db);
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
    const service = createService(db);
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
    const service = createService(db);
    await service.saveSettings({
      cursor: {
        enabled: true,
        binaryPath: "cursor-agent",
      },
    });

    const models = await service.listModels("cursor");

    expect(models).toEqual(getCatalogModelIds("cursor"));
    for (const modelId of models) {
      expect(getCatalogModel("cursor", modelId)).toBeDefined();
    }
    expect(detectBinary).not.toHaveBeenCalled();
    expect(service.getSettings().cursor.binaryPath).toBe("cursor-agent");
  });

  it("maps every Claude effort tier to agent max turns", async () => {
    vi.mocked(detectBinary).mockResolvedValue("/opt/homebrew/bin/claude");
    vi.mocked(probeClaudeCode).mockResolvedValue({
      installed: true,
      version: "2.0.0",
      auth: { status: "authenticated" },
      status: "ready",
    });
    vi.mocked(executeClaudeCode).mockImplementation((input) =>
      Promise.resolve({
        output: JSON.stringify({
          binaryPath: input.binaryPath,
          model: input.model,
          maxTurns: input.maxTurns,
          contextWindow: input.contextWindow,
        }),
      }),
    );

    const db = createDbMock();
    const service = createService(db);
    await service.saveSettings({
      claudeCode: {
        enabled: true,
        binaryPath: "claude",
      },
    });

    for (const [effort, maxTurns] of [
      ["low", 3],
      ["medium", 8],
      ["high", 16],
      ["xhigh", 24],
      ["max", 40],
      ["ultrathink", 64],
    ] as const) {
      const result = await service.execute(
        "claude_code",
        "hello",
        new AbortController(),
        undefined,
        undefined,
        "claude-sonnet-5",
        "auto-accept-edits",
        { effort, contextWindow: "1m" },
      );

      expect(JSON.parse(result.output)).toEqual({
        binaryPath: "/opt/homebrew/bin/claude",
        model: "claude-sonnet-5",
        maxTurns,
        contextWindow: "1m",
      });
    }
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
    const service = createService(db);
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
