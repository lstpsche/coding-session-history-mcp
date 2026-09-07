import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { History } from "../src/history.js";

test(
  "periodic child writer blocks failed reads and recovers without duplicate messages",
  { timeout: 15000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "history-watch-"));
    const source = join(root, "source");
    mkdirSync(join(source, "sessions"), { recursive: true });
    const path = join(source, "sessions", "rollout-one.jsonl");
    const db = join(root, "index.sqlite");
    const line = (type: string, payload: unknown) =>
      JSON.stringify({ timestamp: "2026-09-06T10:00:00Z", type, payload }) +
      "\n";
    const initial =
      line("session_meta", { id: "watch", cwd: "/example" }) +
      line("response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "original" }],
      });
    writeFileSync(path, initial);
    const initialized = new History(db);
    initialized.close();
    const writer = spawn(
      process.execPath,
      [
        resolve("dist/cli.js"),
        "watch",
        "--all",
        "--source",
        source,
        "--db",
        db,
        "--interval-ms",
        "100",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let diagnostic = "";
    writer.stderr.on("data", (chunk: Buffer) => {
      diagnostic += chunk.toString();
    });
    t.after(async () => {
      if (writer.exitCode === null && writer.signalCode === null) {
        const exit = once(writer, "exit");
        writer.kill("SIGTERM");
        await exit;
      }
      rmSync(root, { recursive: true, force: true });
    });
    async function until(check: () => boolean) {
      const deadline = Date.now() + 7000;
      while (!check()) {
        assert.equal(writer.exitCode, null, diagnostic);
        assert.ok(
          Date.now() < deadline,
          "writer did not reach expected state: " + diagnostic,
        );
        await delay(20);
      }
    }
    const reader = new History(db, { readonly: true });
    t.after(() => reader.close());
    await until(
      reader.db.transaction(() => {
        if (reader.status().refresh.state !== "ready") return false;
        assert.equal(reader.search({ query: "original" }).results.length, 1);
        return true;
      }),
    );
    appendFileSync(path, "malformed\n");
    await until(() => reader.status().refresh.state === "failed");
    assert.throws(
      () => reader.search({ query: "original" }),
      /refresh failed|refreshing/,
    );
    writeFileSync(
      path,
      initial +
        line("response_item", {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "recovered" }],
        }),
    );
    await until(
      reader.db.transaction(() => {
        const status = reader.status();
        if (status.refresh.state !== "ready" || status.messages !== 2)
          return false;
        assert.equal(reader.search({ query: "recovered" }).results.length, 1);
        return true;
      }),
    );
    assert.match(diagnostic, /Index refresh failed/);
    assert.doesNotMatch(diagnostic, /malformed/);
  },
);

test("a live writer owner blocks another writer and every content endpoint", () => {
  const root = mkdtempSync(join(tmpdir(), "history-owner-"));
  const history = new History(join(root, "index.sqlite"));
  try {
    history.index(resolve("test/fixtures"));
    history.db
      .prepare("UPDATE refresh SET state='refreshing',owner=?")
      .run(process.pid);
    assert.throws(
      () => history.index(resolve("test/fixtures")),
      /Another index writer/,
    );
    assert.throws(() => history.search({ query: "archive" }), /refreshing/);
    assert.throws(() => history.list({}), /refreshing/);
    assert.throws(
      () => history.overview({ session_id: "fixture-current" }),
      /refreshing/,
    );
    assert.throws(
      () => history.messages({ session_id: "fixture-current" }),
      /refreshing/,
    );
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});
