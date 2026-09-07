import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  rmSync,
  renameSync,
  copyFileSync,
  existsSync,
  statSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { History } from "../src/history.js";

const meta = (id = "session", cwd = "/example") =>
  JSON.stringify({
    timestamp: "2026-09-07T10:00:00Z",
    type: "session_meta",
    payload: { id, cwd },
  }) + "\n";
const message = (text: string) =>
  JSON.stringify({
    timestamp: "2026-09-07T10:01:00Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  }) + "\n";
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "history-storage-"));
  const source = join(root, "source");
  mkdirSync(join(source, "sessions"), { recursive: true });
  const file = join(source, "sessions/rollout-example.jsonl");
  const db = join(root, "index.sqlite");
  writeFileSync(file, meta() + message("original"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const history = new History(db);
  history.index(source);
  history.close();
  return { root, source, file, db };
}
function snapshot(history: History) {
  return [
    history.db.prepare("SELECT * FROM source").all(),
    history.db.prepare("SELECT * FROM messages").all(),
    history.db.prepare("SELECT * FROM files").all(),
    history.db
      .prepare(
        "SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'original'",
      )
      .all(),
  ];
}

test("read connections neither create a missing index nor write to an existing one", (t) => {
  const { root, db } = fixture(t);
  const missing = join(root, "missing/index.sqlite");
  assert.throws(() => new History(missing, { readonly: true }), /ENOENT/);
  assert.equal(existsSync(join(root, "missing")), false);
  const before = readFileSync(db);
  chmodSync(db, 0o400);
  const history = new History(db, { readonly: true });
  try {
    assert.equal(history.db.readonly, true);
    assert.equal(history.search({ query: "original" }).results.length, 1);
    assert.throws(
      () => history.db.exec("CREATE TABLE forbidden(x)"),
      /readonly/,
    );
    assert.throws(() => history.index(root), /read-only/);
  } finally {
    history.close();
  }
  assert.deepEqual(readFileSync(db), before);
  assert.equal(statSync(db).mode & 0o777, 0o400);
  for (const command of ["status", "search", "sessions", "show", "serve"]) {
    const result = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), command, "--db", missing],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.status, 1, command);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(join(root, "missing")), false);
  }
});

for (const incompatible of [
  "old schema",
  "previous schema",
  "future schema",
  "parser",
] as const) {
  test(`${incompatible} incompatibility preserves persisted data and requires explicit rebuild`, (t) => {
    const { db } = fixture(t);
    const connection = new Database(db);
    if (incompatible === "parser")
      connection.exec("UPDATE index_format SET parser_version=999");
    else
      connection.pragma(
        `user_version=${incompatible === "old schema" ? 1 : incompatible === "previous schema" ? 2 : 999}`,
      );
    connection.close();
    const before = readFileSync(db);
    for (const readonly of [true, false])
      assert.throws(
        () => new History(db, { readonly }),
        /rebuild with index --db/,
      );
    assert.deepEqual(readFileSync(db), before);
  });
}

test("matching repeated metadata resumes across restart without duplicating text", (t) => {
  const { db, source, file } = fixture(t);
  appendFileSync(file, meta() + message("resumed"));
  const history = new History(db);
  try {
    assert.equal(history.index(source).messages, 2);
    assert.equal(history.index(source).changed, 0);
    appendFileSync(file, meta("session", "/changed"));
    assert.throws(() => history.index(source), /Conflicting session metadata/);
    assert.equal(history.status().messages, 2);
  } finally {
    history.close();
  }
});

test("vanished collections fail while explicit empty collections reconcile deletion", (t) => {
  const { db, source, file } = fixture(t);
  const history = new History(db);
  try {
    const before = snapshot(history);
    renameSync(join(source, "sessions"), join(source, "unavailable"));
    assert.throws(() => history.index(source), /collection disappeared/);
    assert.deepEqual(snapshot(history), before);
    mkdirSync(join(source, "sessions"));
    assert.equal(history.index(source).messages, 0);
    assert.equal(history.search({ query: "original" }).results.length, 0);
    assert.equal(existsSync(file), false);
    mkdirSync(join(source, "archived_sessions"));
    history.index(source);
    rmSync(join(source, "archived_sessions"), { recursive: true });
    assert.throws(() => history.index(source), /collection disappeared/);
  } finally {
    history.close();
  }
});

test("archive copies are ambiguous and moves preserve message IDs after reopen", (t) => {
  const { db, source, file } = fixture(t);
  const history = new History(db);
  const archive = join(source, "archived_sessions");
  mkdirSync(archive);
  const moved = join(archive, "rollout-example.jsonl");
  try {
    const before = snapshot(history);
    copyFileSync(file, moved);
    assert.throws(() => history.index(source), /Duplicate session ID/);
    assert.deepEqual(snapshot(history), before);
    rmSync(file);
    assert.equal(history.index(source).messages, 1);
  } finally {
    history.close();
  }
  const reopened = new History(db, { readonly: true });
  try {
    assert.equal(
      reopened.messages({ session_id: "session" }).messages.length,
      1,
    );
  } finally {
    reopened.close();
  }
});

for (const failure of ["before offset", "commit"] as const) {
  test(`${failure} failure rolls back messages, FTS and offsets; restart replays once`, (t) => {
    const { db, source, file } = fixture(t);
    const history = new History(db);
    const before = snapshot(history);
    appendFileSync(file, message("unpublished"));
    if (failure === "before offset")
      history.db.exec(
        "CREATE TEMP TRIGGER fail BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT,'injected offset failure'); END",
      );
    else
      history.db.exec(
        "CREATE TABLE fault(id TEXT REFERENCES sessions(id) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER fail AFTER INSERT ON messages BEGIN INSERT INTO fault VALUES('missing'); END",
      );
    assert.throws(
      () => history.index(source),
      /injected offset failure|FOREIGN KEY/,
    );
    assert.deepEqual(snapshot(history), before);
    assert.throws(
      () => history.search({ query: "unpublished" }),
      /refresh failed/,
    );
    history.close();
    const resumed = new History(db);
    try {
      assert.deepEqual(snapshot(resumed), before);
      assert.equal(resumed.index(source).messages, 2);
      assert.equal(resumed.index(source).changed, 0);
      assert.equal(resumed.search({ query: "unpublished" }).results.length, 1);
    } finally {
      resumed.close();
    }
  });
}

test("SIGKILL inside a write transaction recovers the prior committed index", (t) => {
  const { db, source, file } = fixture(t);
  appendFileSync(file, message("aftercrash"));
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { History } from './dist/history.js';
    const history = new History(process.argv[1]);
    history.db.function('terminate_writer', () => process.kill(process.pid, 'SIGKILL'));
    history.db.exec('CREATE TEMP TRIGGER terminate BEFORE INSERT ON files BEGIN SELECT terminate_writer(); END');
    history.index(process.argv[2]);
  `,
      db,
      source,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(child.signal, "SIGKILL", child.stderr);
  const recovered = new History(db);
  try {
    assert.equal(recovered.status().messages, 1);
    assert.throws(
      () => recovered.search({ query: "aftercrash" }),
      /refreshing|interrupted/,
    );
    assert.equal(recovered.index(source).messages, 2);
    assert.equal(recovered.index(source).changed, 0);
    assert.equal(
      recovered.db.pragma("integrity_check", { simple: true }),
      "ok",
    );
  } finally {
    recovered.close();
  }
});

for (const race of [
  "append",
  "truncate",
  "replace",
  "archive",
  "new file",
  "directory symlink",
] as const) {
  test(`concurrent ${race} aborts publication and preserves the previous snapshot`, (t) => {
    const { db, source, file } = fixture(t);
    const history = new History(db);
    const before = snapshot(history);
    appendFileSync(file, message("racing"));
    history.db.function("change_source", () => {
      if (race === "append") appendFileSync(file, message("later"));
      if (race === "truncate") writeFileSync(file, meta());
      if (race === "replace") {
        rmSync(file);
        writeFileSync(file, meta() + message("replacement"));
      }
      if (race === "archive") {
        mkdirSync(join(source, "archived_sessions"));
        renameSync(
          file,
          join(source, "archived_sessions/rollout-example.jsonl"),
        );
      }
      if (race === "new file")
        writeFileSync(join(source, "sessions/rollout-new.jsonl"), meta("new"));
      if (race === "directory symlink") {
        renameSync(join(source, "sessions"), join(source, "saved"));
        symlinkSync(join(source, "saved"), join(source, "sessions"));
      }
      return 0;
    });
    history.db.exec(
      "CREATE TEMP TRIGGER race AFTER INSERT ON messages BEGIN SELECT change_source(); END",
    );
    try {
      assert.throws(() => history.index(source), /changed|real directory/);
      assert.deepEqual(snapshot(history), before);
      assert.throws(
        () => history.search({ query: "racing" }),
        /refresh failed/,
      );
    } finally {
      history.close();
    }
  });
}

test("CLI diagnostics preserve failure category and byte position without record contents", (t) => {
  const { db, source, file } = fixture(t);
  appendFileSync(file, '{"secret":"PRIVATE_SENTINEL", invalid}\n');
  const result = spawnSync(
    process.execPath,
    [resolve("dist/cli.js"), "index", "--all", "--source", source, "--db", db],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /Invalid rollout record at .*:\d+; caused by: Invalid JSON syntax/,
  );
  assert.doesNotMatch(result.stderr, /PRIVATE_SENTINEL/);
  assert.equal(result.stderr.trim().split("\n").length, 1);
});

test("unreadable source aborts without publishing deletion", (t) => {
  const { db, source } = fixture(t);
  const history = new History(db);
  const before = snapshot(history);
  const directory = join(source, "sessions");
  chmodSync(directory, 0);
  try {
    assert.throws(() => history.index(source), /EACCES/);
    assert.deepEqual(snapshot(history), before);
  } finally {
    chmodSync(directory, 0o700);
    history.close();
  }
});

test("writer contention fails visibly and can be retried after releasing the lock", (t) => {
  const { db, source, file } = fixture(t);
  appendFileSync(file, message("contended"));
  const writer = new History(db);
  const blocker = new Database(db);
  writer.db.pragma("busy_timeout=1");
  blocker.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => writer.index(source), /locked/);
    assert.equal(writer.status().messages, 1);
    blocker.exec("ROLLBACK");
    assert.equal(writer.index(source).messages, 2);
  } finally {
    blocker.close();
    writer.close();
  }
});

test("changes to an already skipped rollout are caught at publication", (t) => {
  const { db, source, file } = fixture(t);
  const last = join(source, "sessions/rollout-z.jsonl");
  writeFileSync(last, meta("last") + message("lastmessage"));
  const history = new History(db);
  const before = snapshot(history);
  history.db.function("change_skipped_file", () => {
    appendFileSync(file, message("late"));
    return 0;
  });
  history.db.exec(
    "CREATE TEMP TRIGGER race AFTER INSERT ON messages BEGIN SELECT change_skipped_file(); END",
  );
  try {
    assert.throws(() => history.index(source), /source changed/);
    assert.deepEqual(snapshot(history), before);
  } finally {
    history.close();
  }
});
