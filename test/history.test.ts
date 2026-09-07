import { test, type TestContext } from "node:test";
import { request } from "node:http";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { History } from "../src/history.js";
import { makeServer, serveHttp } from "../src/server.js";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

const time = "2026-09-07T10:00:00Z";
const record = (type: string, payload: object) =>
  JSON.stringify({ type, timestamp: time, payload }) + "\n";
const meta = (id = "s1") =>
  record("session_meta", { id, cwd: "/work/example" });
const msg = (text: string, role = "user") =>
  record("response_item", {
    type: "message",
    role,
    content: [{ type: "input_text", text }],
  });
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "history-test-"));
  mkdirSync(join(root, "sessions"));
  const file = join(root, "sessions/rollout-test.jsonl");
  const history = new History(":memory:");
  t.after(() => {
    history.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, file, history };
}

test("canonical records, lexical search, filters and idempotency", (t) => {
  const { root, file, history } = fixture(t);
  writeFileSync(
    file,
    meta() +
      msg("SQLite search architecture") +
      record("event_msg", {
        type: "user_message",
        message: "SQLite duplicate",
      }) +
      msg("hidden system", "developer") +
      record("response_item", {
        type: "function_call_output",
        output: "secret tool output",
      }),
  );
  assert.equal(history.index(root).messages, 1);
  assert.equal(history.index(root).changed, 0);
  assert.equal(
    history.search({ query: "SQLite architecture" }).results.length,
    1,
  );
  assert.equal(
    history.search({ query: "SQLite", repo: "/other" }).results.length,
    0,
  );
  assert.equal(
    history.search({ query: "SQLite", since: "2026-09-08T00:00:00Z" }).results
      .length,
    0,
  );
  assert.equal(
    history.search({ query: "SQLite", roles: ["assistant"] }).results.length,
    0,
  );
  assert.throws(() => history.search({ query: "!!!" }));
});

test("partial UTF-8 line advances only after newline", (t) => {
  const { root, file, history } = fixture(t);
  const line = Buffer.from(msg("Привет SQLite"));
  const split = line.indexOf(Buffer.from("П")) + 1;
  writeFileSync(
    file,
    Buffer.concat([Buffer.from(meta()), line.subarray(0, split)]),
  );
  assert.equal(history.index(root).messages, 0);
  appendFileSync(file, line.subarray(split));
  assert.equal(history.index(root).messages, 1);
  assert.equal(history.search({ query: "Привет" }).results.length, 1);
});

test("malformed complete record rolls back entire reconciliation", (t) => {
  const { root, file, history } = fixture(t);
  writeFileSync(file, meta() + msg("before"));
  history.index(root);
  appendFileSync(file, msg("after") + "{invalid}\n");
  assert.throws(() => history.index(root), /Invalid rollout record/);
  assert.equal(history.status().messages, 1);
  assert.equal(history.search({ query: "after" }).results.length, 0);
});

test("rewrite, archive and removal reconcile FTS and stable IDs", (t) => {
  const { root, file, history } = fixture(t);
  writeFileSync(file, meta() + msg("old"));
  history.index(root);
  writeFileSync(file, meta() + msg("replacement"));
  history.index(root);
  assert.equal(history.search({ query: "old" }).results.length, 0);
  const before = history.search({ query: "replacement" }).results;
  mkdirSync(join(root, "archived_sessions"));
  const archive = join(root, "archived_sessions/rollout-test.jsonl");
  renameSync(file, archive);
  history.index(root);
  assert.deepEqual(history.search({ query: "replacement" }).results, before);
  rmSync(archive);
  history.index(root);
  assert.equal(history.status().sessions, 0);
  assert.equal(history.search({ query: "replacement" }).results.length, 0);
});

test("reject duplicate IDs, symlinks, missing roots and root switching", (t) => {
  const { root, file, history } = fixture(t);
  writeFileSync(file, meta());
  history.index(root);
  writeFileSync(join(root, "sessions/rollout-copy.jsonl"), meta());
  assert.throws(() => history.index(root), /UNIQUE/);
  rmSync(join(root, "sessions/rollout-copy.jsonl"));
  symlinkSync(file, join(root, "sessions/rollout-link.jsonl"));
  assert.throws(() => history.index(root), /Symlink/);
  assert.throws(() => history.index(join(root, "missing")));
  mkdirSync(join(root, "another"));
  assert.throws(
    () => history.index(join(root, "another")),
    /another source root/,
  );
});

test("long-message continuation reconstructs exact content", (t) => {
  const { root, file, history } = fixture(t);
  const long = "x".repeat(9500);
  writeFileSync(file, meta() + msg("first") + msg(long) + msg("last"));
  history.index(root);
  let next: { after: number; char_offset: number } | null = {
    after: -1,
    char_offset: 0,
  };
  const collected: string[] = [];
  while (next) {
    const page = history.messages({ session_id: "s1", ...next, limit: 2 });
    collected.push(
      ...page.messages.map((row) => (row as { text: string }).text),
    );
    next = page.next;
  }
  assert.equal(collected.join(""), "first" + long + "last");
  assert.throws(
    () => history.messages({ session_id: "absent" }),
    /Unknown session/,
  );
  assert.throws(() => history.messages({ session_id: "s1", char_offset: 999 }));
});

test("MCP client discovers four read-only tools and retrieves indexed evidence", async (t) => {
  const { root, file, history } = fixture(t);
  writeFileSync(file, meta() + msg("SQLite evidence"));
  history.index(root);
  const server = makeServer(history);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 4);
  assert.ok(listed.tools.every((tool) => tool.annotations?.readOnlyHint));
  const result = await client.callTool({
    name: "codex_search",
    arguments: { query: "SQLite" },
  });
  assert.match(JSON.stringify(result), /SQLite.*evidence/);
  const invalid = await client.callTool({
    name: "codex_search",
    arguments: { query: "SQLite", limit: 999 },
  });
  assert.equal(invalid.isError, true);
});

test("HTTP enforces token, host, origin, request size and serves MCP", async (t) => {
  const { history } = fixture(t);
  const token = "a".repeat(32);
  const service = await serveHttp(history, token, 0);
  t.after(() => service.close());
  const port = (service.server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/mcp`;
  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { ...headers, origin: "https://evil.test" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        url,
        { method: "POST", headers: { ...headers, host: "evil.test" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end("{}");
    }),
    403,
  );
  assert.equal(
    (await fetch(url, { method: "POST", headers, body: "x".repeat(70000) }))
      .status,
    413,
  );
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /coding-session-history/);
});
