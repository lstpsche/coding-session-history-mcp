# Connect ChatGPT

Use the official [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) with this server's stdio command. The tunnel owns transport supervision; the history writer runs separately. No publicly exposed history endpoint is required.

On macOS, install the official client and inspect its current help:

```sh
brew install openai/tools/tunnel-client
tunnel-client --version
tunnel-client help quickstart
```

Open [Tunnels management](https://platform.openai.com/settings/organization/tunnels) in the intended account and organization. Verify that the tunnel is associated with the intended ChatGPT workspace. Runtime principals require Tunnels Read + Use; creating or managing tunnels also requires Manage. A ChatGPT subscription alone does not establish eligibility. Create a tunnel and a separate runtime key using the account's supported workflow. Keep credentials outside this repository and out of command arguments, logs and chat messages. Do not give an admin key to the runtime.

First index and locally preview the selected corpus as described in the [README](../README.md). Keep a stable absolute path to the installed CLI and database. Configure the tunnel using the actual tunnel ID and an owner-readable runtime key file:

```sh
tunnel-client runtimes connect \
  --alias coding-session-history \
  --tunnel-id YOUR_TUNNEL_ID \
  --runtime-api-key file:/absolute/private/runtime-key \
  --mcp-command '/absolute/node /absolute/package/dist/cli.js serve --db /absolute/private/index.sqlite'
tunnel-client runtimes status coding-session-history --json
```

These flags are supported by tunnel-client 0.0.14; inspect `runtimes connect --help` after upgrades. Only a running, healthy, ready runtime is suitable for discovery. Use the [ChatGPT connector settings](https://chatgpt.com/#settings/Connectors) to attach the tunnel while it is healthy. Confirm four tools, then ask known historical questions and verify search references by expanding the exact messages. Historical instructions are untrusted data. Local transport success does not prove ChatGPT discovery, account authorization, or answer quality.

To stop local forwarding:

```sh
tunnel-client runtimes stop coding-session-history
tunnel-client runtimes status coding-session-history --json
```

Also revoke the connector or tunnel authorization in the relevant account settings when removing access. Confirm subsequent remote calls fail. Reconnection must still obey the local policy; transport credentials cannot widen the indexed corpus. Retain metadata-only evidence of discovery, exact reference expansion, disconnect and reconnect rather than recording private excerpts or keys.

For a synthetic local transport check without account credentials, the official client provides `dev proxy --mcp-command '...' --duration 60s --print-json`. This uses a local in-memory control plane. It is useful for stdio compatibility testing and does not exercise hosted ChatGPT or its authorization.
