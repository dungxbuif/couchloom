# OpenClaw Connection

CouchLoom exposes MCP Streamable HTTP at `http://vm100:8787/mcp`. OpenClaw's
canonical transport value is `streamable-http`.

Configure it with an environment-backed bearer token:

```json
{
  "mcp": {
    "servers": {
      "couchloom": {
        "url": "http://vm100:8787/mcp",
        "transport": "streamable-http",
        "headers": {
          "Authorization": "Bearer ${COUCHLOOM_MCP_TOKEN}"
        },
        "connectionTimeoutMs": 10000,
        "requestTimeoutMs": 60000,
        "supportsParallelToolCalls": true
      }
    }
  }
}
```

Or use the CLI:

```bash
openclaw mcp set couchloom '{"url":"http://vm100:8787/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer ${COUCHLOOM_MCP_TOKEN}"},"requestTimeoutMs":60000}'
openclaw mcp probe couchloom
```

After connecting, call `list_vaults`, then pass `vault_id` to every other
tool. Keep `COUCHLOOM_MCP_TOKEN` in OpenClaw's service environment rather than
writing the token value into its JSON file.

Reference: <https://docs.openclaw.ai/cli/mcp/transports>
