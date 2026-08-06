import { describe, expect, it } from "vitest";
import {
  selectIncidentTokenUsage,
  updateIncidentTokenUsage,
} from "@bitsentry-ce/components/investigation/Incidents";

describe("incident token usage selection", () => {
  it("keeps provider usage available when switching away and back", () => {
    const usage = {
      inputTokens: 25_129,
      outputTokens: 182,
      contextTokens: 25_311,
      contextLimit: 258_400,
    };
    const stored = updateIncidentTokenUsage({}, "incident-a", usage);

    expect(selectIncidentTokenUsage(stored, "incident-a")).toEqual(usage);
    expect(selectIncidentTokenUsage(stored, "incident-b")).toBeUndefined();
    expect(selectIncidentTokenUsage(stored, "incident-a")).toEqual(usage);
  });
});
