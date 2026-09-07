# Coding Session History

A local, read-only MCP server for indexing and retrieving OpenAI Codex session history. TypeScript, SQLite FTS5, and the official MCP SDK. No external service receives history during indexing or search.

Requires Node.js 24 or later and npm. Install and build:

```sh
npm ci
npm run check
```

Run the CLI:

```sh
node dist/cli.js index
node dist/cli.js status
node dist/cli.js search "SQLite architecture"
node dist/cli.js sessions --repo /absolute/recorded/working/directory
node dist/cli.js show SESSION_ID
node dist/cli.js messages SESSION_ID --revision REVISION --message-id MESSAGE_ID --before 1 --limit 3
```

`index` reads `CODEX_HOME`, or `~/.codex`, and maintains a separate database at `~/.local/share/coding-session-history-mcp/index.sqlite`. Override these with `--source` and `--db`. The source is never modified. One database belongs to exactly one source root. Database files are created with owner-only permissions. Only `index` initializes storage. `status`, `search`, `sessions`, `show`, `messages`, and `serve` open an existing database read-only; a missing index is an error.

Schema and parser versions (currently 3) are checked on every open. Incompatible indexes are rejected without replacing their data. To rebuild, run `index --source <source> --db <new-path>` with a new database path, verify the result, then configure retrieval with that path. A failed rebuild leaves the previous database intact. There is no automatic migration or in-place destructive rebuild.

Run `index` again to refresh. Unchanged files are skipped; appended files resume at the last committed newline. The whole reconciliation is transactional: malformed complete records or inaccessible sources fail the command without publishing partial updates. An unfinished trailing record waits for its newline. `status` reports the last successful indexing time and pending bytes for known sessions. Files with no complete metadata record are not yet indexed.

Archiving and deletion are reconciled against both `sessions/` and `archived_sessions/`. These collections may be absent in a new Codex home. Once observed, a disappearing collection is an error. Restore it before retrying; an explicitly empty directory allows intentional deletion to reconcile. Symlinks within collections are rejected. Replacements and truncations are reindexed. Discovery records directory and rollout identity, size, modification time, and change time. The source is checked again before publication; detected appends, moves, replacements, or other changes abort the transaction and require another explicit `index`. This is an optimistic observation, not a filesystem snapshot or a lock on Codex: changes after the final check await the next index. A continuously changing corpus may require a quiet interval. Append detection also checks a 4 KiB boundary digest; it assumes earlier bytes of an appended rollout are immutable. It is not a full-file tamper detector.

For a local MCP client, configure:

```json
{
  "mcpServers": {
    "coding-session-history": {
      "command": "node",
      "args": ["/absolute/path/coding-session-history-mcp/dist/cli.js", "serve"]
    }
  }
}
```

For HTTP, provide a private random bearer token of at least 32 characters through `CSH_TOKEN`, then run:

```sh
node dist/cli.js serve --http --port 7432
```

The endpoint is `http://127.0.0.1:7432/mcp`. Every request requires `Authorization: Bearer <token>`. The server binds only to loopback, validates Host, rejects browser Origin headers, and caps request bodies at 64 KiB. Stdio does not use the HTTP token. Tunnel installation, public hosting, OAuth, and ChatGPT connection setup are not included. Do not expose this endpoint publicly as-is.

The four tools are:

| Tool | Behavior |
|---|---|
| `codex_search` | AND search over literal lexical terms; up to 20 snippets capped at 4,000 UTF-8 bytes |
| `codex_list_sessions` | Up to 50 session metadata rows with offset pagination |
| `codex_get_session` | Metadata, message count, first/last message IDs and a starting cursor |
| `codex_get_messages` | Direct reference expansion, bounded neighbors and byte continuation |

`repo` matches the exact recorded session `cwd`, not an inferred Git root. Search date filters apply to messages; list date filters apply to the last indexed message. Dates require ISO timestamps with timezone. FTS5 BM25 scores sort ascending. Punctuation separates query terms; raw FTS syntax is not accepted.

Every content response includes `observation` with `ready`, `indexed_at`, and the corpus `revision`, captured in the same SQLite read transaction as the content. Retrieval before a successful index is an error; a successfully indexed empty corpus is explicitly ready. Each successful index creates a new corpus revision. Search/list `next` contains `offset` and `corpus_revision`; repeat the original query and filters alongside these fields. A refresh invalidates these corpus cursors, so restart the query after a stale-reference error.

Search hits include `reference: {session_id, revision, message_id}`. Pass that object directly to `codex_get_messages` (or use the corresponding CLI flags) without arithmetic. `before` adds up to 10 preceding canonical messages; `limit` is the total neighborhood size, at most 20 and greater than `before`. Returned `next` fields continue that neighborhood without extending beyond its last message. `codex_get_session`/`show` provides an overview with a starting cursor for reading the full session. For ordinary message browsing, omit `message_id` and use the overview's `next`.

Message IDs are byte positions in the source file. Session revisions survive verified appends and archive moves. Rewrites or replacements at the same path create a new revision; removed sessions return a stale-reference error. Moves retain a revision only when a chained digest proves that all previously indexed complete records are the same prefix of the moved file. Append detection still relies on the documented immutable-prefix assumption. Direct references and continuation require the session revision; a bare session ID starts a new read of current data.

All content results fit within 64 KiB serialized as an MCP tool result, including its text wrapper and JSON escaping (excluding the JSON-RPC transport envelope). The shared budget may shorten a page; `next` identifies the first unread content. Message text is fetched from SQLite in at most 4,000-byte slices, preserving complete UTF-8 characters and embedded NULs. Pass message `next` unchanged to continue. `byte_offset` replaces the old UTF-16 `char_offset`; old continuations must be restarted. Snippets are excerpts; `snippet_truncated` reports the additional byte cap. Exact message text is available through the reference. Oversized metadata fails explicitly rather than returning an empty success.

Only `response_item` user and assistant text is indexed. Duplicate event messages, system/developer instructions, reasoning, images, and tool calls/outputs are excluded. Unknown event types are ignored; malformed supported records fail indexing with a source byte position. Records larger than 16 MiB are rejected. Indexed text, session IDs and cwd must contain well-formed Unicode; lone surrogates are rejected rather than silently replaced by SQLite. The local rollout format is an external, evolving contract. Repeated metadata with the same session ID and cwd is accepted; the first header retains ownership and the start time. Conflicting IDs or cwd values, including inherited histories with mixed IDs, are rejected. Duplicate session IDs in separate files are rejected even when the files are identical: complete an archive move instead of keeping two copies. Legacy unwrapped records are explicitly unsupported because message timestamps and cwd are unavailable. Parser and JSON diagnostics include the source byte position and failure category without echoing record bodies. One such file aborts the entire reconciliation; do not assume a successful small sample qualifies the full history collection.

History can still contain secrets and private data in ordinary messages. This implementation does not redact text or claim to detect secrets. Connecting an MCP client grants it access to the indexed user/assistant history. Returned text is explicitly identified as untrusted historical content and must not be treated as instructions.

The parser is independent of storage and MCP. `src/parser.ts` owns Codex normalization; `src/history.ts` owns ingestion and retrieval; `src/response.ts` owns the shared serialized-result budget; `src/server.ts` owns the MCP contract and HTTP boundary; `src/cli.ts` owns local configuration. Tests exercise UTF-8 append boundaries, rollback, FTS reconciliation, archive movement, continuation, and actual MCP transport calls using synthetic data.

Run the reproducible synthetic retrieval benchmark:

```sh
npm run benchmark -- --source test/fixtures --cases test/fixtures/retrieval-cases.json
```

For a private benchmark, provide a fixed source snapshot and a JSON array of cases using the same schema: `id`, `question`, `query`, optional `repo`, and `expected` containing `session_id`, byte-position `message_id`, and the SHA-256 of the full normalized message text. Freeze questions and expected evidence before tuning. The runner rejects missing or changed expected evidence, measures a fresh database index, five unchanged scans and five searches per case, and checks exact expansion. It prints counts, timings and case ranks without message text or questions. Fresh-database timing does not imply a cold filesystem cache. The temporary database is removed on completion or ordinary failure.

Use `tmp/` for private snapshots, benchmark cases and reports; it is excluded from Git. Never put actual conversations in test fixtures. `npm test` builds the CLI before exercising child-process transport tests.

Automatic watching, session titles/model metadata, opt-in tool output, redaction, and remote-client setup remain future work. Embeddings and generated summaries are intentionally absent until retrieval evidence justifies them.

This project is independent and is not affiliated with or endorsed by OpenAI.
