# OpenClaw Connection

CouchLoom exposes MCP Streamable HTTP at `http://vm100:8787/mcp`. OpenClaw's
canonical transport value is `streamable-http`.

Generate one 256-bit bearer token on the CouchLoom host:

```bash
openssl rand -hex 32
```

Store that value as `MCP_AUTH_TOKEN` in CouchLoom's mode-`0600` environment
file. Put the same value in OpenClaw's service environment under the different
variable name `COUCHLOOM_MCP_TOKEN`. Do not paste the literal token into a
tracked JSON file.

Configure OpenClaw with the environment-backed token:

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
writing the token value into its JSON file. If the probe returns `401`, confirm
that `COUCHLOOM_MCP_TOKEN` and CouchLoom's `MCP_AUTH_TOKEN` contain exactly the
same value, then restart both services so they reload their environments.

Reference: <https://docs.openclaw.ai/cli/mcp/transports>
