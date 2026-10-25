import { describe, expect, it } from "vitest";
import { readBoundedResponseText } from "../src/shared/bounded-response";

describe("readBoundedResponseText", () => {
  it("stops reading an endless body at the limit", async () => {
    const chunk = new TextEncoder().encode("x".repeat(1_000));
    const body = new ReadableStream<Uint8Array>({ pull: (controller) => { controller.enqueue(chunk); } });

    const result = await readBoundedResponseText(new Response(body), 2_500);

    expect(result).toEqual({ text: "x".repeat(2_500), truncated: true });
  });
});
