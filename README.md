# Coding Session History MCP

[![Release](https://img.shields.io/github/v/release/lstpsche/coding-session-history-mcp)](https://github.com/lstpsche/coding-session-history-mcp/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Search your local [OpenAI Codex](https://openai.com/codex/) conversation history from an MCP client. Find a past decision, locate the session where it happened, and retrieve the exact supporting messages.

The server indexes selected user and assistant messages into a local SQLite database. Your original Codex files remain untouched. Indexing and search use no embedding service or external API; connecting a client lets that client retrieve the history you selected.

## What it does

- Search messages by keywords, recorded project directory, date and role.
- List sessions and expand exact search hits, including nearby messages.
- Refresh the index independently of the MCP server.
- Restrict exposure to selected projects, sessions or physical rollout files.
- Replace configured sensitive text before it enters the index.
- Connect local MCP clients over stdio, or ChatGPT through an authenticated tunnel.

## Install

Requires **Node.js 24 or later** and **npm**. Check with `node --version` and `npm --version`. macOS is tested, including automatic startup through launchd. Linux and Windows have not been qualified for this release; the commands below use a POSIX shell.

Download `coding-session-history-mcp-1.0.0.tgz` from [GitHub Releases](https://github.com/lstpsche/coding-session-history-mcp/releases/latest), then run these commands from the folder containing the download. No repository checkout or global npm permissions are needed:

```sh
csh_install="$HOME/.local/share/coding-session-history-runtime"
npm install --prefix "$csh_install" \
  ./coding-session-history-mcp-1.0.0.tgz

csh_cli="$csh_install/node_modules/coding-session-history-mcp/dist/cli.js"
node "$csh_cli" --help
```

For command-line downloads, use `gh release download v1.0.0 --repo lstpsche/coding-session-history-mcp --pattern coding-session-history-mcp-1.0.0.tgz` with the GitHub CLI. Private repositories require an authorized GitHub login; npm does not inherit that login for direct HTTPS release URLs.

The package includes compiled JavaScript; npm installs its dependencies. It is distributed through GitHub, **not the npm registry**. If the native `better-sqlite3` dependency cannot install, use a supported Node LTS release and check npm's build diagnostic. A native build may require a C/C++ compiler and Python; macOS users can install Apple's Command Line Tools with `xcode-select --install`.

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

Scope is explicit: `cwds` matches recorded working directories exactly, rather than inferring Git roots. Session IDs may also be selected. If unrelated legacy rollouts or duplicate IDs prevent indexing, restrict discovery to exact `rollouts` paths in the policy. See [scope and format details](docs/reference.md). No history is exposed by an empty selection.

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

For **ChatGPT**, follow the [tunnel setup guide](docs/chatgpt.md). It explains the separate account, workspace and tunnel authorization steps. The optional HTTP transport is restricted to authenticated loopback access; see the [reference](docs/reference.md).

## Keep history up to date

`serve` reads the index; it does not refresh it. Run `index` again when needed, or run this separate process:

```sh
node "$csh_cli" watch --source "$csh_source" \
  --policy "$csh_data/policy.json" --db "$csh_data/index.sqlite"
```

The writer waits 15 seconds between refreshes. Stop it with Ctrl-C. Check `status` and its `indexed_at` timestamp to confirm freshness. A failed or interrupted refresh blocks retrieval until a successful refresh; the next writer attempt retries. Policy edits also block retrieval until reindexing succeeds.

For automatic startup, upgrades and removal, see the [macOS service guide](docs/install-macos.md).

## Tools

| Tool | Purpose |
|---|---|
| `codex_search` | Find messages with lexical AND search; filter by project, dates or role |
| `codex_list_sessions` | Browse session metadata with pagination |
| `codex_get_session` | Get a session overview and its starting message cursor |
| `codex_get_messages` | Expand exact references, nearby messages and long-message continuations |

Start searches with one to three distinctive terms. Every term must occur in the same message; a full question often produces no matches. Empty results do not establish absence. Search results contain revision-bound references for exact expansion. Complete tool results are capped at 64 KiB, with continuation for longer content.

## Privacy and limits

Only canonical user/assistant text is indexed. Tool outputs, system/developer messages, reasoning and images are excluded. The source is read-only, and the derived database is created with owner-only permissions. Remote tools cannot widen the local policy.

Returned history is untrusted data, not instructions. Redaction applies only to exact configured text literals; it does not redact session metadata or erase copies already returned to clients. Removing content from the index is not secure deletion of old SQLite pages or backups.

The Codex rollout format can change. Unsupported legacy records, conflicting session metadata and duplicate physical owners fail explicitly. Rewrites invalidate old message references. Schema/parser incompatibility requires rebuilding into a new database path, preserving the original database. See the [complete retrieval and storage contract](docs/reference.md).

## Development

```sh
git clone https://github.com/lstpsche/coding-session-history-mcp.git
cd coding-session-history-mcp
npm ci
npm run check
npm run benchmark -- --source test/fixtures --cases test/fixtures/retrieval-cases.json
npm pack
```

Tests use synthetic history and cover ingestion, crash recovery, policy boundaries, Unicode continuation and real MCP transports. Keep private rollouts, policies and databases out of Git. Please include a synthetic reproduction when reporting a bug through [GitHub Issues](https://github.com/lstpsche/coding-session-history-mcp/issues). Pull requests are welcome; run `npm run check` before submitting.

## License

[MIT](LICENSE) © 2026 Nikita Shkoda.

This project is independent and is not affiliated with or endorsed by OpenAI.
