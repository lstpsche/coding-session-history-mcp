import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";

const exec = promisify(execFile);
const cli = resolve("dist/cli.js");
const textResult = z.object({
  content: z
    .array(z.object({ type: z.literal("text"), text: z.string() }))
    .min(1),
  isError: z.boolean().optional(),
});
function payload(result: unknown): unknown {
  const parsed = textResult.parse(result);
  assert.notEqual(parsed.isError, true);
  return JSON.parse(parsed.content[0]!.text);
}

test(
  "built CLI and child-process stdio share persisted fixture evidence",
  { timeout: 20_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "history-cli-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const db = join(root, "index.sqlite");
    const run = (...args: string[]) =>
      exec(process.execPath, [cli, ...args, "--db", db], { timeout: 10_000 });
    assert.match((await run("--help")).stdout, /coding-session-history/);
    const indexed = await run("index", "--source", resolve("test/fixtures"));
    assert.equal(indexed.stderr, "");
    assert.equal(
      z.object({ messages: z.number() }).parse(JSON.parse(indexed.stdout))
        .messages,
      4,
    );
    assert.equal(
      z
        .object({ changed: z.number() })
        .parse(
          JSON.parse(
            (await run("index", "--source", resolve("test/fixtures"))).stdout,
          ),
        ).changed,
      0,
    );
    const search = z
      .object({
        results: z
          .array(
            z
              .object({
                session_id: z.string(),
                message_id: z.number(),
                revision: z.string(),
              })
              .passthrough(),
          )
          .nonempty(),
      })
      .passthrough()
      .parse(JSON.parse((await run("search", "lexical archive")).stdout));
    assert.equal(search.results[0]!.session_id, "fixture-current");
    assert.equal(
      z
        .object({ sessions: z.array(z.unknown()) })
        .parse(JSON.parse((await run("sessions")).stdout)).sessions.length,
      2,
    );
    assert.match((await run("messages", "fixture-current")).stdout, /Привет/);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "serve", "--db", db],
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const client = new Client({
      name: "history-fixture-client",
      version: "1.0.0",
    });
    try {
      await client.connect(transport);
      assert.ok(client.getNegotiatedProtocolVersion());
      t.diagnostic(
        `Negotiated MCP protocol: ${client.getNegotiatedProtocolVersion()}`,
      );
      assert.deepEqual(
        (await client.listTools()).tools.map((tool) => tool.name).sort(),
        [
          "codex_get_messages",
          "codex_get_session",
          "codex_list_sessions",
          "codex_search",
        ],
      );
      const found = payload(
        await client.callTool({
          name: "codex_search",
          arguments: { query: "lexical archive" },
        }),
      );
      assert.deepEqual(found, search);
      const page = payload(
        await client.callTool({
          name: "codex_get_messages",
          arguments: {
            session_id: search.results[0]!.session_id,
            message_id: search.results[0]!.message_id,
            revision: search.results[0]!.revision,
            limit: 1,
          },
        }),
      );
      assert.match(JSON.stringify(page), /Preserve complete UTF-8/);
      const overview = payload(
        await client.callTool({
          name: "codex_get_session",
          arguments: { session_id: "fixture-archived" },
        }),
      );
      assert.match(JSON.stringify(overview), /message_count/);
      assert.doesNotMatch(JSON.stringify(overview), /top margin/);
      const sessions = payload(
        await client.callTool({
          name: "codex_list_sessions",
          arguments: { repo: "/example/archive" },
        }),
      );
      assert.equal(
        z.object({ sessions: z.array(z.unknown()) }).parse(sessions).sessions
          .length,
        1,
      );
      const excluded = payload(
        await client.callTool({
          name: "codex_search",
          arguments: { query: "EXCLUDED" },
        }),
      );
      assert.deepEqual(
        z.object({ results: z.array(z.unknown()) }).parse(excluded).results,
        [],
      );
      const invalid = textResult.parse(
        await client.callTool({
          name: "codex_get_messages",
          arguments: { session_id: "missing" },
        }),
      );
      assert.equal(invalid.isError, true);
    } finally {
      await client.close();
    }
    assert.equal(stderr, "");
  },
);

test("CLI failures return nonzero exit, no successful JSON and a diagnostic", async () => {
  await assert.rejects(
    exec(process.execPath, [cli, "unsupported-command"], { timeout: 10_000 }),
    (error) => {
      const failure = error as Error & {
        code: number;
        stdout: string;
        stderr: string;
      };
      assert.equal(failure.code, 1);
      assert.equal(failure.stdout, "");
      assert.match(failure.stderr, /Unknown command/);
      return true;
    },
  );
});
