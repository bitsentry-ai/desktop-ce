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
    throw new Error(`Missing PostHog plugin action: ${id}`);
  }
  return match;
}

function context(input: Record<string, unknown>): DesktopPluginCodeActionContext {
  return {
    pluginId: plugin.id,
    actionId: "query_issues",
    auth: {
      accessToken: "phx-token",
      baseUrl: "https://eu.posthog.com",
    },
    input,
    host,
  };
}

describe("PostHog plugin package", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("declares a typed PostHog error-source code plugin", () => {
    expect(plugin).toMatchObject({
      id: "posthog",
      metadata: {
        dataSource: {
          sourceType: "posthog",
          setupFields: expect.arrayContaining([
            expect.objectContaining({
              key: "projectIds",
              required: true,
            }),
          ]),
        },
      },
    });
    expect(plugin.actions.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(["query_issues", "list_issue_events"]),
    );
  });

  it("executes query_issues through plugin-owned HogQL", async () => {
    const fetchMock = vi
      .fn<(url: string, request?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            columns: [
              "fingerprint",
              "message",
              "exception_type",
              "level",
              "lib",
              "environment",
              "event_count",
              "user_count",
              "first_seen",
              "last_seen",
              "exception_list",
              "project_id",
            ],
            results: [
              [
                "fp-1",
                "SMTP 550 mailbox full",
                "EmailDeliveryError",
                "error",
                "python",
                "prod",
                19,
                16,
                "2026-05-12T04:31:56.740Z",
                "2026-05-12T04:55:40.560Z",
                null,
                "177710",
              ],
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await action("query_issues").execute(
      context({
        orgSlug: "org-1",
        projectIds: ["177710"],
        query: "`mailbox`",
        limit: 2,
      }),
    );

    expect(result).toMatchObject({
      data: {
        hasMore: false,
        issues: [
          {
            id: "177710:fp-1",
            title: "EmailDeliveryError: SMTP 550 mailbox full",
            projectIdentifier: "177710",
            environment: "prod",
          },
        ],
      },
    });

    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://eu.posthog.com/api/projects/177710/query/");
    expect(request?.headers).toMatchObject({
      Authorization: "Bearer phx-token",
      "Content-Type": "application/json",
    });
    expect(request?.redirect).toBe("error");
  });

  it("rejects unallowlisted custom PostHog origins", async () => {
    await expect(
      action("query_issues").execute({
        ...context({
          orgSlug: "org-1",
          projectIds: ["177710"],
        }),
        auth: {
          accessToken: "phx-token",
          baseUrl: "https://self-hosted.posthog.internal",
        },
      }),
    ).rejects.toThrow("PostHog base URL \"self-hosted.posthog.internal\" is not in the allowlist");
  });

  it("allows self-hosted PostHog origins from the env allowlist", async () => {
    vi.stubEnv(
      "POSTHOG_ALLOWED_BASE_URLS",
      "https://self-hosted.posthog.internal",
    );
    const fetchMock = vi
      .fn<(url: string, request?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            columns: [
              "fingerprint",
              "message",
              "exception_type",
              "level",
              "lib",
              "environment",
              "event_count",
              "user_count",
              "first_seen",
              "last_seen",
              "exception_list",
              "project_id",
            ],
            results: [],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      action("query_issues").execute({
        ...context({
          orgSlug: "org-1",
          projectIds: ["177710"],
        }),
        auth: {
          accessToken: "phx-token",
          baseUrl: "https://self-hosted.posthog.internal",
        },
      }),
    ).resolves.toMatchObject({ status: 200 });

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://self-hosted.posthog.internal/api/projects/177710/query/");
  });
});
