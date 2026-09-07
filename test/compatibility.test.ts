import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { History } from "../src/history.js";

const current = readFileSync(
  new URL("fixtures/sessions/rollout-current.jsonl", import.meta.url),
);
const first = current.subarray(0, current.indexOf(10) + 1);
const fixtureRoot = resolve("test/fixtures");

test("current and archived fixtures index canonical multiline Unicode text only", () => {
  const history = new History(":memory:");
  try {
    assert.equal(history.index(fixtureRoot).messages, 4);
    assert.equal(history.status().sessions, 2);
    assert.equal(history.search({ query: "EXCLUDED" }).results.length, 0);
    assert.equal(
      history.search({ query: "renderer margin" }).results.length,
      1,
    );
    const page = history.messages({ session_id: "fixture-current" });
    assert.match(JSON.stringify(page), /Привет/);
    assert.match(JSON.stringify(page), /🦀/);
    assert.doesNotMatch(JSON.stringify(page), /EXCLUDED/);
  } finally {
    history.close();
  }
});

test("unfinished first metadata is retried after restart and completion", (t) => {
  const root = mkdtempSync(join(tmpdir(), "history-metadata-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "sessions"));
  const path = join(root, "sessions/rollout-partial.jsonl");
  writeFileSync(path, first.subarray(0, 30));
  const db = join(root, "index.sqlite");
  const initial = new History(db);
  try {
    assert.equal(initial.index(root).sessions, 0);
  } finally {
    initial.close();
  }
  appendFileSync(path, first.subarray(30));
  const resumed = new History(db);
  try {
    assert.equal(resumed.index(root).sessions, 1);
    assert.equal(resumed.index(root).changed, 0);
  } finally {
    resumed.close();
  }
});

for (const [name, records, error] of [
  [
    "legacy unwrapped metadata",
    JSON.stringify({
      id: "legacy",
      timestamp: "2025-01-01T00:00:00Z",
      instructions: "synthetic",
    }) + "\n",
    /Invalid rollout record/,
  ],
  [
    "repeated same-session metadata",
    Buffer.concat([current, first]),
    /Unexpected session metadata/,
  ],
  [
    "different-session metadata in one file",
    Buffer.concat([
      current,
      Buffer.from(
        first.toString().replaceAll("fixture-current", "other-session"),
      ),
    ]),
    /Unexpected session metadata/,
  ],
  [
    "malformed supported message",
    first +
      JSON.stringify({
        timestamp: "2026-09-06T10:00:00Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text" }],
        },
      }) +
      "\n",
    /Invalid rollout record/,
  ],
  [
    "invalid UTF-8 complete record",
    Buffer.concat([first, Buffer.from([0xff, 10])]),
    /Invalid rollout record/,
  ],
] as const) {
  test(`${name} fails atomically instead of publishing partial evidence`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "history-format-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "sessions"));
    writeFileSync(join(root, "sessions/rollout-format.jsonl"), records);
    const history = new History(":memory:");
    try {
      assert.throws(() => history.index(root), error);
      assert.equal(history.status().sessions, 0);
      assert.equal(history.status().messages, 0);
      assert.equal(history.status().indexed_at, null);
    } finally {
      history.close();
    }
  });
}
