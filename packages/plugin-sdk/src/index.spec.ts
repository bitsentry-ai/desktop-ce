import { describe, expect, it } from "vitest";

import { desktopCodePluginSchema, desktopPluginDescriptorSchema } from ".";

describe("@bitsentry/plugin-sdk", () => {
  it("validates a desktop plugin descriptor", () => {
    const descriptor = desktopPluginDescriptorSchema.parse({
      id: "example",
      name: "Example",
      version: "0.1.0",
      description: "Example plugin.",
      auth: {
        fields: [],
      },
      actions: [
        {
          id: "ping",
          title: "Ping",
          description: "Return a test response.",
          riskLevel: "read",
          fields: [],
        },
      ],
    });

    expect(descriptor.type).toBe("data_source");
  });

  it("validates a code plugin action handler", () => {
    const plugin = desktopCodePluginSchema.parse({
      id: "example",
      name: "Example",
      version: "0.1.0",
      description: "Example plugin.",
      auth: {
        fields: [],
      },
      actions: [
        {
          id: "ping",
          title: "Ping",
          description: "Return a test response.",
          riskLevel: "read",
          fields: [],
          execute: () => ({
            ok: true,
            status: 200,
            summary: "Plugin executed successfully.",
          }),
        },
      ],
    });

    expect(plugin.actions[0]?.id).toBe("ping");
  });
});
