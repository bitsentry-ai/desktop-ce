import { describe, expect, it } from "vitest";
import {
  selectIncidentTokenUsage,
  updateIncidentTokenUsage,
} from "@bitsentry-ce/components/investigation/Incidents";

describe("incident token usage selection", () => {
  it("preserves actual usage through an estimate and accepts a smaller actual", () => {
    const actual = { kind: "actual" as const, inputTokens: 32_000, outputTokens: 100 };
    const estimate = { kind: "estimate" as const, inputTokens: 55_000, outputTokens: 0 };
    const smaller = { kind: "actual" as const, inputTokens: 20_000, outputTokens: 50 };
    const stored = updateIncidentTokenUsage({}, "incident-a", actual);
    const afterEstimate = updateIncidentTokenUsage(stored, "incident-a", estimate);
    expect(selectIncidentTokenUsage(afterEstimate, "incident-a")).toEqual(actual);
    expect(selectIncidentTokenUsage(
      updateIncidentTokenUsage(afterEstimate, "incident-a", smaller), "incident-a",
    )).toEqual(smaller);
    expect(selectIncidentTokenUsage(afterEstimate, "incident-b")).toBeUndefined();
  });

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
