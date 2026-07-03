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
  });

  it("declares Sentry as a typed error-source code plugin", () => {
    expect(plugin).toMatchObject({
      id: "sentry",
      metadata: {
        errorSource: {
          sourceType: "sentry",
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

  it("rejects non-HTTP Sentry API bases before sending bearer credentials", async () => {
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
      "Sentry API base URL must use http:// or https://",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
