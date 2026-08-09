# Stateless MCP host

The host-tool endpoint serves only MCP protocol revision `2026-07-28`.
It binds to `127.0.0.1` on an ephemeral port and creates a new MCP server
instance for every request. It does not accept `initialize`,
`notifications/initialized`, or `Mcp-Session-Id` from the network.

The endpoint requires a bearer token, `MCP-Protocol-Version`, `Mcp-Method`,
and the per-request `_meta` envelope. The SDK validates required name headers,
client capabilities, discovery, and cache metadata. The bearer token is an
authentication capability only. Each tool call uses a `contextId` handle that
is checked against the token scope before the host tool runs.

Codex, Cursor, and OpenCode connect through the generated stdio shim. The shim
answers their legacy `initialize` request from `server/discover`, then converts
each legacy JSON-RPC request to stateless HTTP. It sets the required headers,
adds client metadata, preserves W3C tracing metadata when provided, and adds
the scoped context handle. This keeps all compatibility code outside the host.

The in-process Claude Agent SDK server uses the same protocol-agnostic host
tool core. It does not use the HTTP transport until the Agent SDK supports the
stateless revision.

Sessions are application state, not MCP transport state. They are removed when
a provider execution ends, on expiry, and during desktop shutdown. Runbook
proposals remain in memory and require operator approval before persistence.
