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
    throw new Error(`Missing Wazuh plugin action: ${id}`);
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
      indexUrl: "https://wazuh.example.com:9200",
      indexPassword: "wazuh-secret",
    },
    input,
    host,
  };
}

describe("Wazuh plugin package", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("declares a typed Wazuh error-source code plugin", () => {
    expect(plugin).toMatchObject({
      id: "wazuh",
      metadata: {
        errorSource: {
          sourceType: "wazuh",
        },
      },
    });
    expect(plugin.actions.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(["query_issues", "search_alerts"]),
    );
  });

  it("executes search_alerts through plugin-owned OpenSearch query code", async () => {
    const fetchMock = vi
      .fn<(url: string, request?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            hits: {
              total: { value: 1, relation: "eq" },
              hits: [
                {
                  _id: "alert-1",
                  _index: "wazuh-alerts-4.x-2026.06.01",
                  _score: 1,
                  _source: {
                    "@timestamp": "2026-06-01T00:05:00.000Z",
                    rule: {
                      id: "5710",
                      level: 10,
                      description: "sshd brute force attempt",
                    },
                    agent: {
                      name: "prod-api-1",
                    },
                  },
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await action("search_alerts").execute(
      context("search_alerts", {
        query: "rule.level:>=10",
        indexPattern: "wazuh-alerts-*",
        limit: 2,
        offset: 0,
        since: "2026-06-01T00:00:00.000Z",
        until: "2026-06-01T01:00:00.000Z",
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      summary: "Fetched 1 Wazuh alerts.",
      data: {
        hasMore: false,
        total: 1,
      },
    });

    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://wazuh.example.com:9200/wazuh-alerts-*/_search");
    expect(request).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Basic ${Buffer.from("admin:wazuh-secret").toString("base64")}`,
        "Content-Type": "application/json",
      },
    });
  });

  it("rejects non-HTTP Wazuh index URLs before sending basic credentials", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      action("search_alerts").execute({
        ...context("search_alerts", {
          indexPattern: "wazuh-alerts-*",
        }),
        auth: {
          indexUrl: "file:///tmp/wazuh",
          indexPassword: "wazuh-secret",
        },
      }),
    ).rejects.toThrow("Wazuh index URL must use http:// or https://");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
