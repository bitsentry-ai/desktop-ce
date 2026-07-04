import { afterEach, describe, expect, it, vi } from "vitest";

import plugin from "./plugin";
import type {
  DesktopPluginCodeActionContext,
  DesktopPluginCodeHostContext,
} from "@bitsentry-ce/core/features/plugins";

const host: DesktopPluginCodeHostContext = {
  pluginRoot: "",
  entryPath: "",
  localPluginDirectories: [],
  reloadPlugins: () => Promise.resolve(),
};

function action(id: string) {
  const match = plugin.actions.find((candidate) => candidate.id === id);
  if (match === undefined) {
    throw new Error(`Missing Sentry plugin action: ${id}`);
  }
  return match;
}

describe("Sentry plugin package", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("declares Sentry as a typed error-source code plugin", () => {
    expect(plugin).toMatchObject({
      id: "sentry",
      metadata: {
        dataSource: {
          sourceType: "sentry",
          oauth: {
            publicClient: false,
          },
        },
      },
    });
    expect(plugin.actions.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining([
        "build_authorize_url",
        "exchange_code_for_token",
        "refresh_token",
        "list_issues",
        "list_issue_events",
      ]),
    );
  });

  it("rejects non-HTTPS Sentry API bases before sending bearer credentials", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const context: DesktopPluginCodeActionContext = {
      pluginId: plugin.id,
      actionId: "list_organizations",
      auth: {
        accessToken: "sentry-token",
        baseUrl: "file:///tmp/sentry",
      },
      input: {},
      host,
    };

    await expect(action("list_organizations").execute(context)).rejects.toThrow(
      "Sentry API base URL must use https://",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unallowlisted Sentry API bases before sending bearer credentials", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const context: DesktopPluginCodeActionContext = {
      pluginId: plugin.id,
      actionId: "list_organizations",
      auth: {
        accessToken: "sentry-token",
        baseUrl: "https://evil.example.com",
      },
      input: {},
      host,
    };

    await expect(action("list_organizations").execute(context)).rejects.toThrow(
      "Sentry API base URL \"evil.example.com\" is not in the allowlist",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses redirects when sending bearer credentials to Sentry", async () => {
    vi.stubEnv("SENTRY_ALLOWED_BASE_URLS", "sentry.example.com");
    const fetchMock = vi
      .fn<(url: string, request?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response(JSON.stringify([{ slug: "bitsentry", name: "BitSentry" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const context: DesktopPluginCodeActionContext = {
      pluginId: plugin.id,
      actionId: "list_organizations",
      auth: {
        accessToken: "sentry-token",
        baseUrl: "https://sentry.example.com",
      },
      input: {},
      host,
    };

    await expect(action("list_organizations").execute(context)).resolves.toMatchObject(
      {
        data: [{ slug: "bitsentry", name: "BitSentry" }],
      },
    );

    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://sentry.example.com/api/0/organizations/");
    expect(request?.headers).toMatchObject({
      Authorization: "Bearer sentry-token",
      Accept: "application/json",
    });
    expect(request?.redirect).toBe("error");
  });

  it("applies configured project slug filters to issue queries", async () => {
    vi.stubEnv("SENTRY_ALLOWED_BASE_URLS", "sentry.example.com");
    const fetchMock = vi
      .fn<(url: string, request?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const context: DesktopPluginCodeActionContext = {
      pluginId: plugin.id,
      actionId: "list_issues",
      auth: {
        accessToken: "sentry-token",
        baseUrl: "https://sentry.example.com",
      },
      input: {
        orgSlug: "bitsentry",
        projectIds: ["123"],
        projectSlugs: ["frontend"],
      },
      host,
    };

    await expect(action("list_issues").execute(context)).resolves.toMatchObject({
      data: { issues: [] },
    });

    const [url] = fetchMock.mock.calls[0] ?? [];
    const parsedUrl = new URL(url ?? "");
    expect(parsedUrl.searchParams.getAll("project")).toEqual([
      "123",
      "frontend",
    ]);
  });
});
