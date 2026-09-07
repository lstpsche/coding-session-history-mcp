import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { History } from "../src/history.js";
import { makeServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { z } from "zod";

const line = (type: string, payload: object) =>
  JSON.stringify({ timestamp: "2026-09-07T10:00:00Z", type, payload }) + "\n";
const meta = (id = "s", cwd = "/example") => line("session_meta", { id, cwd });
const msg = (text: string, role = "user") =>
  line("response_item", {
    type: "message",
    role,
    content: [{ type: "input_text", text }],
  });
function fixture(
  t: TestContext,
  text = meta() + msg("before") + msg("needle") + msg("after"),
) {
  const root = mkdtempSync(join(tmpdir(), "history-retrieval-"));
  mkdirSync(join(root, "sessions"));
  const file = join(root, "sessions/rollout-example.jsonl");
  writeFileSync(file, text);
  const db = join(root, "index.sqlite");
  const history = new History(db);
  history.index(root);
  t.after(() => {
    history.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, file, db, history };
}
function size(value: object) {
  return Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(value) }],
    }),
  );
}

test("unindexed retrieval fails; successful empty observation is explicitly ready", (t) => {
  const root = mkdtempSync(join(tmpdir(), "history-unready-"));
  const history = new History(":memory:");
  t.after(() => {
    history.close();
    rmSync(root, { recursive: true, force: true });
  });
  for (const action of [
    () => history.search({ query: "needle" }),
    () => history.list({}),
    () => history.overview({ session_id: "s" }),
    () => history.messages({ session_id: "s" }),
  ])
    assert.throws(action, /not ready/);
  history.index(root);
  const found = history.search({ query: "needle" });
  assert.deepEqual(found.results, []);
  assert.equal(found.observation.ready, true);
  assert.ok(found.observation.indexed_at);
});

test("direct references select exact messages and bounded canonical neighbors", (t) => {
  const { history } = fixture(t);
  const hit = history.search({ query: "needle" }).results[0]!;
  assert.equal(
    history.messages({ ...hit.reference, limit: 1 }).messages[0]!.text,
    "needle",
  );
  const context = history.messages({ ...hit.reference, before: 1, limit: 3 });
  assert.deepEqual(
    context.messages.map((x) => x.text),
    ["before", "needle", "after"],
  );
  assert.equal(context.next, null);
  const overview = history.overview({ session_id: "s" });
  assert.equal(overview.message_count, 3);
  assert.equal("messages" in overview, false);
  assert.ok(overview.next);
  assert.equal(history.messages(overview.next).messages.length, 3);
  assert.throws(
    () => history.messages({ session_id: "s", message_id: hit.message_id }),
    /requires revision/,
  );
  assert.throws(
    () => history.messages({ ...hit.reference, message_id: 0 }),
    /Unknown message/,
  );
});

test("append and verified archive movement preserve references; rewrite invalidates them", (t) => {
  const { root, file, history } = fixture(t);
  const reference = history.search({ query: "needle" }).results[0]!.reference;
  const first = history.messages({ session_id: "s", limit: 1 });
  assert.ok(first.next);
  appendFileSync(file, msg("appended"));
  history.index(root);
  assert.equal(
    history.messages({ ...reference, limit: 1 }).messages[0]!.text,
    "needle",
  );
  assert.equal(history.messages(first.next).messages[0]!.text, "needle");
  mkdirSync(join(root, "archived_sessions"));
  const archive = join(root, "archived_sessions/rollout-example.jsonl");
  renameSync(file, archive);
  history.index(root);
  assert.equal(
    history.messages({ ...reference, limit: 1 }).messages[0]!.text,
    "needle",
  );
  writeFileSync(archive, meta() + msg("changed"));
  history.index(root);
  assert.throws(() => history.messages(first.next), /Stale session reference/);
  assert.throws(() => history.messages(reference), /Stale session reference/);
  assert.throws(
    () => history.overview({ session_id: "s", revision: reference.revision }),
    /Stale session reference/,
  );
});

test("move plus modified prefix cannot inherit a previous session revision", (t) => {
  const { root, file, history } = fixture(t);
  const reference = history.search({ query: "needle" }).results[0]!.reference;
  const moved = join(root, "sessions/rollout-moved.jsonl");
  renameSync(file, moved);
  writeFileSync(moved, meta() + msg("edited") + msg("needle") + msg("after"));
  history.index(root);
  assert.throws(() => history.messages(reference), /Stale session reference/);
});

test("corpus pagination rejects refreshes and continuations without a revision", (t) => {
  const { root, history } = fixture(
    t,
    meta() + msg("needle one") + msg("needle two"),
  );
  const first = history.search({ query: "needle", limit: 1 });
  assert.ok(first.next);
  const second = history.search({ query: "needle", limit: 1, ...first.next });
  assert.notEqual(first.results[0]!.message_id, second.results[0]!.message_id);
  assert.throws(
    () => history.search({ query: "needle", offset: 1 }),
    /requires corpus_revision/,
  );
  history.index(root);
  assert.throws(
    () => history.search({ query: "needle", ...first.next }),
    /Stale corpus reference/,
  );
  assert.throws(() => history.list({ offset: 1 }), /requires corpus_revision/);
});

test("UTF-8 byte continuation preserves NUL, escaping and multibyte boundaries", (t) => {
  const text =
    "\uFEFF" +
    "a".repeat(3997) +
    "\uFEFF" +
    "a".repeat(3996) +
    '🦀\0Привет\n"\\'.repeat(1800);
  const { history } = fixture(t, meta() + msg(text));
  let page = history.messages({ session_id: "s" });
  let collected = "";
  let calls = 0;
  while (true) {
    assert.ok(size(page) <= 65536);
    assert.ok(page.messages[0]!.text.isWellFormed());
    collected += page.messages.map((x) => x.text).join("");
    if (!page.next) break;
    assert.ok(++calls < 100);
    page = history.messages(page.next);
  }
  assert.equal(collected, text);
  const revision = history.overview({ session_id: "s" }).session.revision;
  assert.throws(
    () => history.messages({ session_id: "s", revision, byte_offset: 8000 }),
    /encoded data|UTF-8/,
  );
});

test("maximum escaped metadata and long text paginate under the MCP byte ceiling", (t) => {
  const id = "\u0001".repeat(200);
  const cwd = "\u0002".repeat(4096);
  const text = "needle " + "\u0003".repeat(9000);
  const { root, history } = fixture(
    t,
    meta(id, cwd) + Array.from({ length: 12 }, () => msg(text)).join(""),
  );
  for (let i = 0; i < 5; i++)
    writeFileSync(
      join(root, `sessions/rollout-${i}.jsonl`),
      meta(String(i) + id.slice(1), cwd) + msg("needle"),
    );
  history.index(root);
  let page = history.messages({ session_id: id, limit: 20 });
  const collected: string[] = [];
  while (true) {
    assert.ok(size(page) <= 65536);
    collected.push(...page.messages.map((x) => x.text));
    if (!page.next) break;
    page = history.messages({ ...page.next, limit: 20 });
  }
  assert.equal(collected.join(""), text.repeat(12));
  let listing = history.list({ limit: 50 });
  let count = 0;
  while (true) {
    assert.ok(size(listing) <= 65536);
    count += listing.sessions.length;
    if (!listing.next) break;
    listing = history.list({ limit: 50, ...listing.next });
  }
  assert.equal(count, 6);
  const search = history.search({ query: "needle", repo: cwd, limit: 20 });
  assert.ok(size(search) <= 65536);
  assert.ok(search.results.length > 0);
  assert.ok(search.next);
  assert.ok(size(history.overview({ session_id: id })) <= 65536);
});

test("malformed Unicode is rejected rather than silently changed by SQLite", (t) => {
  const { root, file, history } = fixture(t);
  appendFileSync(file, msg("broken\ud800"));
  assert.throws(() => history.index(root), /Invalid rollout record/);
  assert.equal(history.status().messages, 3);
});

test("CLI direct expansion and neighbors use the same revision contract", (t) => {
  const { db } = fixture(t);
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [resolve("dist/cli.js"), ...args, "--db", db], {
      encoding: "utf8",
      timeout: 5000,
    });
  const searched = run("search", "needle");
  assert.equal(searched.status, 0, searched.stderr);
  const result = z
    .object({
      results: z.array(
        z.object({
          session_id: z.string(),
          revision: z.string(),
          message_id: z.number(),
        }),
      ),
    })
    .parse(JSON.parse(searched.stdout));
  const hit = result.results[0]!;
  const expanded = run(
    "messages",
    hit.session_id,
    "--revision",
    hit.revision,
    "--message-id",
    String(hit.message_id),
    "--before",
    "1",
    "--limit",
    "3",
  );
  assert.equal(expanded.status, 0, expanded.stderr);
  const page = z
    .object({ messages: z.array(z.object({ text: z.string() })) })
    .parse(JSON.parse(expanded.stdout));
  assert.deepEqual(
    page.messages.map((x) => x.text),
    ["before", "needle", "after"],
  );
});

test("actual MCP calls expose freshness, exact references and stale errors", async (t) => {
  const { history, root, file } = fixture(
    t,
    meta() +
      msg("before") +
      msg("needle " + "🦀".repeat(3000)) +
      msg("after") +
      msg("EXCLUDED", "developer"),
  );
  const server = makeServer(history);
  const client = new Client({ name: "retrieval-contract", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
    assert.notEqual(result.isError, true);
    const parsed = z
      .object({
        content: z.array(
          z.object({ type: z.literal("text"), text: z.string() }),
        ),
      })
      .parse(result);
    return JSON.parse(parsed.content[0]!.text) as unknown;
  }
  const found = z
    .object({
      results: z.array(
        z.object({
          reference: z.object({
            session_id: z.string(),
            revision: z.string(),
            message_id: z.number(),
          }),
        }),
      ),
      observation: z.object({
        ready: z.literal(true),
        indexed_at: z.string(),
        revision: z.string(),
      }),
    })
    .parse(await call("codex_search", { query: "needle" }));
  const reference = found.results[0]!.reference;
  const pageSchema = z.object({
    messages: z.array(z.object({ text: z.string() })),
    next: z.record(z.string(), z.unknown()).nullable(),
  });
  let page = pageSchema.parse(
    await call("codex_get_messages", { ...reference, before: 1, limit: 3 }),
  );
  let text = page.messages.map((x) => x.text).join("");
  while (page.next) {
    page = pageSchema.parse(await call("codex_get_messages", page.next));
    text += page.messages.map((x) => x.text).join("");
  }
  assert.equal(text, "before" + "needle " + "🦀".repeat(3000) + "after");
  assert.doesNotMatch(text, /EXCLUDED/);
  writeFileSync(file, meta() + msg("replacement"));
  history.index(root);
  const stale = await client.callTool({
    name: "codex_get_messages",
    arguments: reference,
  });
  assert.equal(stale.isError, true);
  assert.match(JSON.stringify(stale), /Stale session reference/);
});

test("CLI continuation reconstructs long neighbors and rejects a rewritten session", (t) => {
  const long = "needle " + "🦀\0\\\n".repeat(2200);
  const { root, file, db, history } = fixture(
    t,
    meta() + msg("before") + msg(long) + msg("after"),
  );
  const reference = history.search({ query: "needle" }).results[0]!.reference;
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), "messages", "s", "--db", db, ...args],
      { encoding: "utf8", timeout: 5000 },
    );
  const schema = z.object({
    messages: z.array(z.object({ text: z.string() })),
    next: z
      .object({
        revision: z.string(),
        after: z.number(),
        byte_offset: z.number(),
        through: z.number().optional(),
      })
      .nullable(),
  });
  const initial = run(
    "--revision",
    reference.revision,
    "--message-id",
    String(reference.message_id),
    "--before",
    "1",
    "--limit",
    "3",
  );
  assert.equal(initial.status, 0, initial.stderr);
  let page = schema.parse(JSON.parse(initial.stdout));
  assert.ok(page.next);
  const saved = page.next;
  let text = page.messages.map((x) => x.text).join("");
  while (page.next) {
    const cursor = page.next;
    const result = run(
      "--revision",
      cursor.revision,
      "--after",
      String(cursor.after),
      "--byte-offset",
      String(cursor.byte_offset),
      ...(cursor.through === undefined
        ? []
        : ["--through", String(cursor.through)]),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Buffer.byteLength(result.stdout) <= 65536);
    page = schema.parse(JSON.parse(result.stdout));
    text += page.messages.map((x) => x.text).join("");
  }
  assert.equal(text, "before" + long + "after");
  writeFileSync(file, meta() + msg("rewritten"));
  history.index(root);
  const stale = run(
    "--revision",
    saved.revision,
    "--after",
    String(saved.after),
    "--byte-offset",
    String(saved.byte_offset),
  );
  assert.equal(stale.status, 1);
  assert.equal(stale.stdout, "");
  assert.match(stale.stderr, /Stale session reference/);
});
