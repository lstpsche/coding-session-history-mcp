/** Budget includes MCP's text-content wrapper and its extra JSON escaping. */
const MAX_RESULT_BYTES = 64 * 1024;
function fits(value: object) {
  return (
    Buffer.byteLength(
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify(value) }],
      }),
    ) <= MAX_RESULT_BYTES
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
