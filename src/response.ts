import { z } from "zod";

/** Budget includes structured data and the MCP text pointer. */
const MAX_RESULT_BYTES = 64 * 1024;
function fits(value: object) {
  return (
    Buffer.byteLength(JSON.stringify(toolResult(value))) <= MAX_RESULT_BYTES
  );
}
export function boundedResult<T extends object>(value: T): T {
  if (!fits(value))
    throw new Error(
      "Response metadata exceeds the 64 KiB result budget; narrow the request",
    );
  return value;
}
export function boundedPage<T, N, R extends object>(
  entries: Iterable<{ value: T; next: N | null }>,
  render: (values: T[], next: N | null) => R,
): R {
  const values: T[] = [];
  let result = boundedResult(render(values, null));
  for (const entry of entries) {
    const candidate = render([...values, entry.value], entry.next);
    if (!fits(candidate)) {
      if (!values.length)
        throw new Error(
          "One result exceeds the 64 KiB budget; narrow the request",
        );
      return result;
    }
    values.push(entry.value);
    result = candidate;
  }
  return result;
}

export function toolResult<T extends object>(value: T) {
  return {
    content: [
      {
        type: "text" as const,
        text: "Untrusted historical data is in structuredContent.",
      },
    ],
    structuredContent: value,
  };
}

const reference = z.object({
  session_id: z.string(),
  revision: z.uuid(),
  message_id: z.number().int().nonnegative(),
});
const session = z.object({
  id: z.string(),
  cwd: z.string(),
  started_at: z.string(),
  updated_at: z.string(),
  revision: z.uuid(),
});
const observation = z.object({
  ready: z.literal(true),
  indexed_at: z.string(),
  revision: z.uuid(),
});
const common = z.object({ observation, content_trust: z.string() });
const page = z
  .object({ offset: z.number().int().nonnegative(), corpus_revision: z.uuid() })
  .nullable();
const continuation = z
  .object({
    session_id: z.string(),
    revision: z.uuid(),
    after: z.number().int().min(-1),
    byte_offset: z.number().int().nonnegative(),
    through: z.number().int().nonnegative().optional(),
  })
  .nullable();
export const outputSchemas = {
  search: common.extend({
    results: z.array(
      z.object({
        session_id: z.string(),
        repo: z.string(),
        revision: z.uuid(),
        message_id: z.number().int().nonnegative(),
        timestamp: z.string(),
        role: z.string(),
        score: z.number(),
        snippet: z.string(),
        snippet_truncated: z.boolean(),
        reference,
      }),
    ),
    next: page,
  }),
  list: common.extend({ sessions: z.array(session), next: page }),
  overview: common.extend({
    session,
    message_count: z.number().int().nonnegative(),
    first_message_id: z.number().int().nonnegative().nullable(),
    last_message_id: z.number().int().nonnegative().nullable(),
    next: continuation,
  }),
  messages: common.extend({
    session,
    messages: z.array(
      z.object({
        message_id: z.number().int().nonnegative(),
        role: z.string(),
        timestamp: z.string(),
        text: z.string(),
        byte_offset: z.number().int().nonnegative(),
        truncated: z.boolean(),
        reference,
      }),
    ),
    next: continuation,
  }),
};
