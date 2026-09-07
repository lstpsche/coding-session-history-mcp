import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";

test("setup creates a scoped index and usable config, resumes and preserves conflicting policy", (t) => {
  const root = mkdtempSync(join(tmpdir(), "history-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, "index.sqlite");
  const run = (...extra: string[]) =>
    spawnSync(
      process.execPath,
      [
        resolve("dist/cli.js"),
        "setup",
        "--repo",
        "/example/project",
        "--source",
        resolve("test/fixtures"),
        "--db",
        db,
        ...extra,
      ],
      { encoding: "utf8" },
    );
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /Indexed 1 sessions and 2 messages/);
  const config = z
    .object({
      mcpServers: z.object({
        "coding-session-history": z.object({
          command: z.string(),
          args: z.array(z.string()),
        }),
      }),
    })
    .parse(JSON.parse(first.stdout));
  assert.equal(
    config.mcpServers["coding-session-history"].command,
    process.execPath,
  );
  assert.deepEqual(config.mcpServers["coding-session-history"].args.slice(1), [
    "serve",
    "--db",
    db,
  ]);
  const path = join(root, "policy.json");
  const original = readFileSync(path);
  assert.equal(run().status, 0);
  assert.deepEqual(readFileSync(path), original);
  writeFileSync(
    path,
    JSON.stringify({
      mode: "selected",
      cwds: ["/example/project"],
      redact: ["lexical"],
    }),
  );
  assert.equal(run().status, 0);
  assert.match(readFileSync(path, "utf8"), /lexical/);
  writeFileSync(path, '{"mode":"all"}');
  const conflict = run();
  assert.notEqual(conflict.status, 0);
  assert.equal(conflict.stdout, "");
  assert.match(conflict.stderr, /different scope/);
  assert.equal(readFileSync(path, "utf8"), '{"mode":"all"}');
  assert.notEqual(run("--all").status, 0);
});

test("setup emits no successful config when indexing fails and supports retry", (t) => {
  const root = mkdtempSync(join(tmpdir(), "history-setup-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (source: string) =>
    spawnSync(
      process.execPath,
      [
        resolve("dist/cli.js"),
        "setup",
        "--repo",
        "/example/project",
        "--source",
        source,
        "--db",
        join(root, "index.sqlite"),
      ],
      { encoding: "utf8" },
    );
  const failed = run(join(root, "absent"));
  assert.notEqual(failed.status, 0);
  assert.equal(failed.stdout, "");
  assert.match(failed.stderr, /ENOENT/);
  assert.equal(run(resolve("test/fixtures")).status, 0);
});
