# @bitsentry/plugin-sdk

SDK contracts and validation schemas for BitSentry desktop plugins.

This package is intentionally small. It defines the stable plugin boundary that
first-party and third-party plugins compile against, while SuperTerminal owns
plugin discovery, installation, credential storage, execution, and UI.

## Installation

```sh
npm install @bitsentry/plugin-sdk
```

## Usage

```ts
import type { DesktopCodePlugin } from "@bitsentry/plugin-sdk";

export const plugin: DesktopCodePlugin = {
  id: "example",
  name: "Example",
  version: "0.1.0",
  description: "Example BitSentry desktop plugin.",
  type: "data_source",
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
      async execute() {
        return {
          ok: true,
          status: 200,
          summary: "Plugin executed successfully.",
          data: { pong: true },
        };
      },
    },
  ],
};

export default plugin;
```

## Contract Surface

The SDK exports TypeScript types and Zod schemas for:

- plugin descriptors
- auth and setup fields
- plugin actions
- execution requests and results
- data-source setup and auth hooks
- install-from-artifact requests and results

Plugins should depend on this package instead of importing from SuperTerminal or
`@bitsentry-ce/core`. That keeps plugin repositories independent from the
desktop application's internal package graph.

## Versioning

`0.x` releases may evolve while the plugin system stabilizes. After `1.0.0`,
breaking contract changes will require a major version bump.

## License

Apache-2.0
