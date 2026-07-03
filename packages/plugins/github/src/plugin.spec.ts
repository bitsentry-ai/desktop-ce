import { afterEach, describe, expect, it, vi } from "vitest";

import plugin from "./plugin";
import type {
  DesktopPluginCodeActionContext,
  DesktopPluginCodeHostContext,
} from "@bitsentry-ce/core/features/plugins";

function createGitHubIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    number: 42,
    title: "API deploy failed",
    body: "Deploy job failed after checkout.",
    state: "open",
    html_url: "https://github.com/bitsentry-ai/monorepo/issues/42",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:05:00Z",
    comments: 3,
    labels: [{ name: "deploy" }],
    user: { login: "octocat" },
    ...overrides,
  };
}

const host: DesktopPluginCodeHostContext = {
  pluginRoot: "",
  entryPath: "",
  localPluginDirectories: [],
  reloadPlugins: () => Promise.resolve(),
};

function action(id: string) {
  const match = plugin.actions.find((candidate) => candidate.id === id);
  if (match === undefined) {
    throw new Error(`Missing GitHub plugin action: ${id}`);
  }
  return match;
}

function context(
  actionId: string,
  input: Record<string, unknown>,
): DesktopPluginCodeActionContext {
  return {
    pluginId: plugin.id,
    actionId,
    auth: {
      accessToken: "gh-token",
      apiBase: "https://github.example.com/api/v3",
    },
    input,
    host,
  };
}

describe("GitHub plugin package", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("declares a typed GitHub error-source code plugin", () => {
    expect(plugin).toMatchObject({
      id: "github",
      referenceRepositoryPath: ".repos/references/plugins/stackstorm-github",
      metadata: {
        errorSource: {
          sourceType: "github",
        },
      },
    });
    expect(plugin.actions.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(["list_issues", "query_issues", "list_projects"]),
    );
  });

  it("executes list_issues through plugin code", async () => {
    const fetchMock = vi.fn<(url: string, request?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([createGitHubIssue()]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await action("list_issues").execute(
      context("list_issues", {
        owner: "bitsentry-ai",
        repo: "monorepo",
        labels: ["deploy"],
        limit: 2,
        since: "2026-06-01T00:00:00Z",
      }),
    );

    expect(result).toMatchObject({
      status: 200,
      summary: "Fetched 1 GitHub issues.",
      data: {
        issues: [
          {
            externalIssueId: "bitsentry-ai/monorepo#42",
            projectIdentifier: "bitsentry-ai/monorepo",
            status: "open",
            title: "API deploy failed",
          },
        ],
        hasMore: false,
      },
    });

    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(new URL(String(url)).pathname).toBe(
      "/api/v3/repos/bitsentry-ai/monorepo/issues",
    );
    expect(request?.headers).toMatchObject({
      Authorization: "Bearer gh-token",
      Accept: "application/vnd.github+json",
    });
  });

  it("keeps setup and auth mapping inside plugin code", async () => {
    expect(
      plugin.errorSource?.resolveSetup?.({
        pluginId: plugin.id,
        setupValues: {
          accessToken: "gh-token",
          owner: "bitsentry-ai",
          repos: ["monorepo", "runbooks"],
          apiBase: "https://github.example.com/api/v3",
        },
        host,
      }),
    ).toEqual({
      accessTokenRef: "gh-token",
      configuration: {
        orgSlug: "bitsentry-ai",
        projectIds: ["monorepo", "runbooks"],
        baseUrl: "https://github.example.com/api/v3",
      },
    });
  });
});
