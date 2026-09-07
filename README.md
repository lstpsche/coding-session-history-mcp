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

Install with Homebrew on macOS:

```sh
brew install lstpsche/tap/coding-session-history-mcp
coding-session-history --help
```

The [tap](https://github.com/lstpsche/homebrew-tap) manages Node and the native SQLite dependency. Run `coding-session-history setup --repo /absolute/path/to/your/project` after installation. Installation does not index history or start a service.

For a manual tarball installation:

Requires **Node.js 24 or later** and **npm**. Check with `node --version` and `npm --version`. macOS is tested, including automatic startup through launchd. Linux and Windows have not been qualified for this release; the commands below use a POSIX shell.

Download `coding-session-history-mcp-1.1.0.tgz` from [GitHub Releases](https://github.com/lstpsche/coding-session-history-mcp/releases/latest), then run these commands from the folder containing the download. No repository checkout or global npm permissions are needed:

```sh
csh_install="$HOME/.local/share/coding-session-history-runtime"
npm install --prefix "$csh_install" \
  ./coding-session-history-mcp-1.1.0.tgz

csh_cli="$csh_install/node_modules/coding-session-history-mcp/dist/cli.js"
node "$csh_cli" --help
```

For command-line downloads, use `gh release download v1.1.0 --repo lstpsche/coding-session-history-mcp --pattern coding-session-history-mcp-1.1.0.tgz` with the GitHub CLI.

The package includes compiled JavaScript; npm installs its dependencies. It is distributed through GitHub, **not the npm registry**. If the native `better-sqlite3` dependency cannot install, use a supported Node LTS release and check npm's build diagnostic. A native build may require a C/C++ compiler and Python; macOS users can install Apple's Command Line Tools with `xcode-select --install`.

## First run

The `setup` command creates a project policy, builds the initial index and prints ready-to-paste MCP configuration. With Homebrew, run:

```sh
coding-session-history setup --repo /absolute/path/to/your/project
```

For a tarball installation, use `node "$csh_cli" setup --repo /absolute/path/to/your/project`. From a source checkout, use `node dist/cli.js setup --repo /absolute/path/to/your/project`.

Use the exact project working directory recorded by Codex. Setup reads `CODEX_HOME` or `~/.codex`, creates an owner-readable policy beside the default index, and reports the session/message counts. It prints the MCP configuration to stdout and a ready-to-run background refresh command to stderr. Copy the configuration into your MCP client, then run the refresh command in another terminal.

Setup can be rerun for the same project and preserves existing literal redaction settings. It refuses to replace a policy selecting another scope. Use a separate `--db /absolute/private/directory/index.sqlite` for a separate project, or manage a custom policy with `index`. Failed indexing produces an error without printing successful client configuration. Zero matching sessions are reported explicitly; check the recorded working directory.

## Connect an MCP client

Merge the JSON printed by setup with your client's existing MCP configuration, then restart or reconnect that client. The configuration includes absolute Node, CLI and database paths. `serve` waits for MCP requests over stdio; it is not an interactive terminal application.

Clients must support structured results in `structuredContent`. Confirm all four tools below are available, then try: **“Search my coding history for the SQLite decision, then expand the exact message that supports it.”**

For **ChatGPT**, follow the [tunnel setup guide](docs/chatgpt.md). Account and tunnel authorization remain separate from local setup. For custom policy files, redaction and physical rollout selection, see the [reference](docs/reference.md).

## Keep history up to date

`serve` reads the index; it does not refresh it. Use the exact refresh command printed by setup. For a [manual packaged installation](docs/manual-setup.md) with the variables from that guide, run:

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
