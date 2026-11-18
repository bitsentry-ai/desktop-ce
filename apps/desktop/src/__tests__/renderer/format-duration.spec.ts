import { describe, expect, it } from "vitest";
import { formatDuration } from "@bitsentry-ce/components/chat/utils";

describe("formatDuration", () => {
  it("keeps short runs precise", () => {
    expect(formatDuration(400)).toBe("0.4s");
    expect(formatDuration(8_200)).toBe("8.2s");
    expect(formatDuration(42_000)).toBe("42s");
  });

  it("switches to minutes, hours and days for long runs", () => {
    expect(formatDuration(185_000)).toBe("3m 05s");
    expect(formatDuration(75_526_000)).toBe("20h 58m");
    expect(formatDuration(273_600_000)).toBe("3d 4h");
  });
});
