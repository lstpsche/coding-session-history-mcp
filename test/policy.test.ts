import { z } from "zod";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { History } from "../src/history.js";
import { policy, redact } from "../src/policy.js";

test("local policy scopes all content paths and invalidates reads immediately when tightened", (t) => {
  const root = mkdtempSync(join(tmpdir(), "history-policy-"));
  const path = join(root, "policy.json");
  const history = new History(join(root, "index.sqlite"));
  t.after(() => {
    history.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = resolve("test/fixtures");
  writeFileSync(path, JSON.stringify({ mode: "all" }));
  history.index(source, path);
  const reference = history.search({ query: "lexical" }).results[0]!.reference;
  writeFileSync(
    path,
    JSON.stringify({ mode: "selected", sessions: ["fixture-archived"] }),
  );
  const blocked = [
    () => history.search({ query: "lexical" }),
    () => history.list({}),
    () => history.overview({ session_id: "fixture-current" }),
    () => history.messages(reference),
  ];
  for (const call of blocked) assert.throws(call, /policy changed/);
  history.index(source, path);
  assert.equal(history.list({}).sessions.length, 1);
  assert.equal(history.search({ query: "lexical" }).results.length, 0);
  assert.throws(
    () => history.overview({ session_id: "fixture-current" }),
    /Unknown session|stale/i,
  );
  assert.throws(() => history.messages(reference), /Unknown session|stale/i);
  assert.equal(
    history.db
      .prepare(
        "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'lexical'",
      )
      .pluck()
      .get(),
    0,
  );
  assert.equal(history.index(source, path).changed, 0);
  rmSync(path);
  for (const call of blocked) assert.throws(call, /ENOENT/);
});

test("selected cwd policy stores only redacted message text and refresh revokes old references", (t) => {
  const root = mkdtempSync(join(tmpdir(), "history-redact-"));
  const path = join(root, "policy.json");
  const history = new History(join(root, "index.sqlite"));
  t.after(() => {
    history.close();
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(
    path,
    JSON.stringify({
      mode: "selected",
      cwds: ["/example/project"],
      redact: ["lexical", "café", "Привет"],
    }),
  );
  history.index(resolve("test/fixtures"), path);
  assert.equal(history.list({}).sessions.length, 1);
  assert.equal(history.search({ query: "lexical" }).results.length, 0);
  const page = history.messages({ session_id: "fixture-current" });
  assert.doesNotMatch(JSON.stringify(page), /lexical|café|Привет/);
  assert.match(JSON.stringify(page), /REDACTED/);
  writeFileSync(path, JSON.stringify({ mode: "selected" }));
  history.index(resolve("test/fixtures"), path);
  assert.equal(history.status().messages, 0);
  assert.equal(history.list({}).sessions.length, 0);
});

test("redaction treats metacharacters literally, prioritizes longest match and preserves other Unicode", (t) => {
  const root = mkdtempSync(join(tmpdir(), "history-literals-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "policy.json");
  writeFileSync(
    path,
    JSON.stringify({ mode: "all", redact: ["a", "abc", "$.*", "REDACTED"] }),
  );
  assert.equal(
    redact(policy(path), "abc $.* 🦀\0 café"),
    "[REDACTED] [REDACTED] 🦀\0 c[REDACTED]fé",
  );
});

test("MCP cannot widen local scope and all tools refuse a changed policy", async (t) => {
  const { makeServer } = await import("../src/server.js");
  const { Client } = await import("@modelcontextprotocol/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const root = mkdtempSync(join(tmpdir(), "history-policy-mcp-"));
  const path = join(root, "policy.json");
  const history = new History(join(root, "index.sqlite"));
  writeFileSync(
    path,
    JSON.stringify({ mode: "selected", sessions: ["fixture-archived"] }),
  );
  history.index(resolve("test/fixtures"), path);
  const server = makeServer(history);
  const client = new Client({ name: "policy-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
    history.close();
    rmSync(root, { recursive: true, force: true });
  });
  await server.connect(a);
  await client.connect(b);
  const widen = await client.callTool({
    name: "codex_search",
    arguments: { query: "lexical", policy: { mode: "all" } },
  });
  const text = z
    .object({
      content: z
        .array(z.object({ type: z.literal("text"), text: z.string() }))
        .nonempty(),
    })
    .parse(widen).content[0]!.text;
  assert.deepEqual(
    z.object({ results: z.array(z.unknown()) }).parse(JSON.parse(text)).results,
    [],
  );
  writeFileSync(path, JSON.stringify({ mode: "selected" }));
  for (const [name, args] of [
    ["codex_search", { query: "archive" }],
    ["codex_list_sessions", {}],
    ["codex_get_session", { session_id: "fixture-archived" }],
    ["codex_get_messages", { session_id: "fixture-archived" }],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /policy changed/);
  }
});
