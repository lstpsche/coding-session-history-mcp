import { z } from "zod";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const exec = promisify(execFile);
const run = (cases: string) =>
  exec(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve("scripts/benchmark.ts"),
      "--source",
      resolve("test/fixtures"),
      "--cases",
      cases,
    ],
    { timeout: 10_000 },
  );

test("benchmark measures fixed evidence without printing source content", async () => {
  const { stdout, stderr } = await run(
    resolve("test/fixtures/retrieval-cases.json"),
  );
  assert.equal(stderr, "");
  const report = z
    .object({
      recall_at_5: z.number(),
      cases: z.array(z.object({ expansion_matches: z.boolean() })),
      corpus: z.object({ messages: z.number() }),
      unchanged_scan: z.object({ samples: z.number() }),
    })
    .parse(JSON.parse(stdout));
  assert.equal(report.recall_at_5, 1);
  assert.equal(report.cases.length, 2);
  assert.ok(
    report.cases.every(
      (item: { expansion_matches: boolean }) => item.expansion_matches,
    ),
  );
  assert.equal(report.corpus.messages, 4);
  assert.equal(report.unchanged_scan.samples, 5);
  assert.doesNotMatch(stdout, /Привет|top margin|EXCLUDED/);
});

test("benchmark rejects changed expected evidence rather than scoring another passage", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "history-benchmark-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cases = z
    .array(
      z
        .object({ expected: z.object({ sha256: z.string() }).passthrough() })
        .passthrough(),
    )
    .nonempty()
    .parse(
      JSON.parse(readFileSync("test/fixtures/retrieval-cases.json", "utf8")),
    );
  cases[0]!.expected.sha256 = "0".repeat(64);
  const path = join(root, "cases.json");
  writeFileSync(path, JSON.stringify(cases));
  await assert.rejects(run(path), (error) => {
    const failure = error as Error & {
      code: number;
      stdout: string;
      stderr: string;
    };
    assert.equal(failure.code, 1);
    assert.equal(failure.stdout, "");
    assert.match(failure.stderr, /Expected evidence changed or is absent/);
    return true;
  });
});
