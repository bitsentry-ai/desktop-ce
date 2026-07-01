import { describe, expect, it } from "vitest";

import plugin from "./plugin";

describe("Sentry plugin package", () => {
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
});
