import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { History } from "../src/history.js";

const caseSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  query: z.string().min(1),
  repo: z.string().optional(),
  expected: z.object({
    session_id: z.string(),
    message_id: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const hitSchema = z.object({
  session_id: z.string(),
  message_id: z.number().int(),
});
const pageSchema = z.object({
  messages: z.array(
    z.object({
      text: z.string(),
      message_id: z.number().int(),
      truncated: z.boolean(),
    }),
  ),
  next: z.object({ after: z.number(), char_offset: z.number() }).nullable(),
});
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50_ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

function main() {
  const { values } = parseArgs({
    options: { source: { type: "string" }, cases: { type: "string" } },
  });
  if (!values.source || !values.cases)
    throw new Error(
      "Usage: npm run benchmark -- --source <Codex home> --cases <cases.json>",
    );
  const cases = z
    .array(caseSchema)
    .min(1)
    .parse(JSON.parse(readFileSync(values.cases, "utf8")));
  if (new Set(cases.map((item) => item.id)).size !== cases.length)
    throw new Error("Benchmark case IDs must be unique");
  const temp = mkdtempSync(join(tmpdir(), "history-benchmark-"));
  let history: History | undefined;
  try {
    history = new History(join(temp, "index.sqlite"));
    const coldStart = performance.now();
    const indexed = history.index(values.source);
    const coldMs = performance.now() - coldStart;
    const bytes = z
      .object({ bytes: z.number() })
      .parse(
        history.db
          .prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM files")
          .get(),
      ).bytes;
    const unchanged: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const scanned = history.index(values.source);
      if (
        scanned.changed !== 0 ||
        scanned.files !== indexed.files ||
        scanned.sessions !== indexed.sessions ||
        scanned.messages !== indexed.messages ||
        scanned.pending_bytes !== indexed.pending_bytes
      )
        throw new Error(
          "Benchmark source changed during measurement; use a fixed snapshot",
        );
      unchanged.push(performance.now() - start);
    }
    const searches: number[] = [];
    const results = [];
    for (const item of cases) {
      const row = history.db
        .prepare("SELECT text FROM messages WHERE session_id=? AND sequence=?")
        .get(item.expected.session_id, item.expected.message_id);
      if (
        !row ||
        hash(z.object({ text: z.string() }).parse(row).text) !==
          item.expected.sha256
      )
        throw new Error(
          `Expected evidence changed or is absent for benchmark case ${item.id}`,
        );
      let hits: z.infer<typeof hitSchema>[] = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        hits = z
          .array(hitSchema)
          .parse(
            history.search({ query: item.query, repo: item.repo, limit: 5 })
              .results,
          );
        searches.push(performance.now() - start);
      }
      const index = hits.findIndex(
        (hit) =>
          hit.session_id === item.expected.session_id &&
          hit.message_id === item.expected.message_id,
      );
      let expansionMatches = false;
      if (index !== -1) {
        let cursor = { after: item.expected.message_id - 1, char_offset: 0 };
        let text = "";
        while (true) {
          const page = pageSchema.parse(
            history.messages({
              session_id: item.expected.session_id,
              ...cursor,
              limit: 1,
            }),
          );
          const message = page.messages[0];
          if (!message || message.message_id !== item.expected.message_id)
            throw new Error(`Expansion lost expected message for ${item.id}`);
          text += message.text;
          if (!message.truncated) break;
          if (!page.next || page.next.char_offset <= cursor.char_offset)
            throw new Error(`Expansion did not advance for ${item.id}`);
          cursor = page.next;
        }
        expansionMatches = hash(text) === item.expected.sha256;
      }
      results.push({
        id: item.id,
        expected_rank: index === -1 ? null : index + 1,
        expansion_matches: expansionMatches,
      });
    }
    console.log(
      JSON.stringify(
        {
          runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
          },
          corpus: {
            files: indexed.files,
            bytes,
            sessions: indexed.sessions,
            messages: indexed.messages,
          },
          cold_index_ms: coldMs,
          unchanged_scan: distribution(unchanged),
          search: distribution(searches),
          peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
          recall_at_5:
            results.filter((item) => item.expected_rank !== null).length /
            results.length,
          cases: results,
        },
        null,
        2,
      ),
    );
  } finally {
    history?.close();
    rmSync(temp, { recursive: true, force: true });
  }
}
try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Benchmark failed");
  process.exitCode = 1;
}
