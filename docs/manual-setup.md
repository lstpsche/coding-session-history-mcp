# Manual setup

Complete [installation](../README.md#install) first and keep the same terminal variables.

## First run

Keep these commands in the same terminal as the installation commands. Replace `/absolute/path/to/your/project` with the exact working directory recorded by Codex for the project you want to expose.

```sh
csh_project="/absolute/path/to/your/project"
csh_data="$HOME/.local/share/coding-session-history-mcp"
csh_source="${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$csh_data"
chmod 700 "$csh_data"

node --input-type=module - "$csh_data/policy.json" "$csh_project" <<'JS'
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({
  mode: 'selected', cwds: [process.argv[3]], redact: []
}, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
JS

node "$csh_cli" index --source "$csh_source" \
  --policy "$csh_data/policy.json" --db "$csh_data/index.sqlite"
node "$csh_cli" status --db "$csh_data/index.sqlite"
node "$csh_cli" sessions --db "$csh_data/index.sqlite"
node "$csh_cli" search "bootstrap" --db "$csh_data/index.sqlite"
```

The policy command creates a new file and refuses to overwrite an existing one. If it already exists, inspect and edit it deliberately, then run `index` again. A successful index reports `refresh.state: "ready"`, its timestamp, and session/message counts. Zero sessions usually means the recorded working directory differs from your selection. Search for a term you know appears in your own history; `bootstrap` is only an example.

Scope is explicit: `cwds` matches recorded working directories exactly, rather than inferring Git roots. Session IDs may also be selected. If unrelated legacy rollouts or duplicate IDs prevent indexing, restrict discovery to exact `rollouts` paths in the policy. See [scope and format details](reference.md). No history is exposed by an empty selection.

Review the indexed sessions before connecting a client. `show SESSION_ID` returns an overview; `messages SESSION_ID` begins reading that session. Both commands accept the same `--db` flag. History may contain private information in ordinary messages; literal redaction is not automatic secret detection.

## Connect an MCP client

Index once before starting the server. To generate a configuration containing the actual Node, installed CLI and database paths:

```sh
node --input-type=module - "$csh_cli" "$csh_data/index.sqlite" <<'JS'
console.log(JSON.stringify({ mcpServers: {
  'coding-session-history': {
    command: process.execPath,
    args: [process.argv[2], 'serve', '--db', process.argv[3]]
  }
}}, null, 2));
JS
```

Add the printed entry to your client's MCP configuration and restart or reconnect the client. Clients use different configuration locations; merge it with existing entries. The server communicates over stdio and waits for MCP requests, so launching `serve` in a terminal does not display an interactive interface.

Clients must support MCP structured results: the complete response is in `structuredContent`, and the text block is only a pointer. After connecting, confirm that all four tools below are available. Try: **“Search my coding history for the SQLite decision, then expand the exact message that supports it.”**

For **ChatGPT**, follow the [tunnel setup guide](chatgpt.md). It explains the separate account, workspace and tunnel authorization steps. The optional HTTP transport is restricted to authenticated loopback access; see the [reference](reference.md).

