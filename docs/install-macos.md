# Install on macOS

Use Node.js 24 or later. Build and validate the checkout, then create a private local package:

```sh
npm ci
npm run check
npm pack --dry-run
npm pack --pack-destination /absolute/private/artifacts
```

The package contains compiled JavaScript, usage documentation and package metadata. It excludes source rollouts, databases, tests, temporary files and local policy. Registry publication is disabled. Install the tarball into a dedicated directory; npm installs the native SQLite dependency for the current Node runtime:

```sh
csh_install="$HOME/.local/share/coding-session-history-runtime"
npm install --prefix "$csh_install" /absolute/private/artifacts/coding-session-history-mcp-0.1.0.tgz
```

Choose a source and create an owner-readable policy using the [scope contract](../README.md). Use a dedicated private data directory. Index and preview before starting a service:

```sh
csh_data="$HOME/.local/share/coding-session-history-mcp"
mkdir -p "$csh_data"
chmod 700 "$csh_data"
chmod 600 "$csh_data/policy.json"
csh_cli="$csh_install/node_modules/coding-session-history-mcp/dist/cli.js"
node "$csh_cli" index --source "$HOME/.codex" --policy "$csh_data/policy.json" --db "$csh_data/index.sqlite"
node "$csh_cli" status --db "$csh_data/index.sqlite"
node "$csh_cli" sessions --db "$csh_data/index.sqlite"
```

Generate and inspect the writer's LaunchAgent. The generator requires explicit source, database and policy paths and does not install anything. It records the absolute Node and installed CLI paths, passes arguments directly without a shell, uses a private umask and writes errors to `writer.log` beside the database. The data directory must already exist. Keep source, database and policy at stable paths.

```sh
csh_agent="$HOME/Library/LaunchAgents/local.coding-session-history.writer.plist"
mkdir -p "$HOME/Library/LaunchAgents"
test ! -e "$csh_agent" && node "$csh_cli" launchd \
  --source "$HOME/.codex" --policy "$csh_data/policy.json" \
  --db "$csh_data/index.sqlite" > "$csh_agent"
chmod 600 "$csh_agent"
plutil -lint "$csh_agent"
launchctl bootstrap "gui/$(id -u)" "$csh_agent"
launchctl print "gui/$(id -u)/local.coding-session-history.writer"
node "$csh_cli" status --db "$csh_data/index.sqlite"
```

If the plist already exists, inspect its ownership/configuration and follow the upgrade procedure; do not overwrite an unrelated service. `RunAtLoad` and `KeepAlive` start the writer at user login and restart it after exit. Refreshes run every 15 seconds after the preceding run completes. Launchd throttles process restarts to 30 seconds. `status` distinguishes failed refreshes from successful observations; check the timestamp rather than assuming a running process means fresh history. Read `writer.log` for the matching error ID and retain or rotate this local diagnostic file as needed.

Configure retrieval against the same installed CLI and database, using [the tunnel client's own supervisor](chatgpt.md). Do not add another LaunchAgent around its managed runtime. A writer alone does not establish remote readiness.

For a writer restart:

```sh
launchctl kickstart -k "gui/$(id -u)/local.coding-session-history.writer"
node "$csh_cli" status --db "$csh_data/index.sqlite"
```

For upgrades, stop the writer with `launchctl bootout "gui/$(id -u)" "$csh_agent"` and stop the tunnel runtime. Retain the old package and database. Install the new tarball into a new dedicated runtime directory and run its `status` against the existing database. Supported indexes remain usable; unsupported schema/parser versions fail without replacement. Rebuild incompatible indexes into a new database path with the same source and policy, then preview the new index. A failed rebuild must not trigger automatic use of the old index. Restore the prior application deliberately only after checking that its policy remains appropriate.

After verification, remove the stopped application's plist, regenerate it using the new installed CLI and database, and bootstrap it. Update the tunnel command and verify its health before reconnecting. Regenerate the plist after Node upgrades too: its recorded Node executable may refer to a removed version. Native SQLite bindings must match the installed Node ABI.

To uninstall, stop the tunnel runtime and revoke remote access, then stop the writer:

```sh
launchctl bootout "gui/$(id -u)" "$csh_agent"
rm "$csh_agent"
npm uninstall --prefix "$csh_install" coding-session-history-mcp
```

These commands remove only the named application service and installed package. The policy, derived database and local log remain for explicit retention or deletion. Never remove the Codex source directory. Confirm that `launchctl print` reports the writer absent and that remote requests no longer succeed. A local stop does not erase data already returned to clients.
