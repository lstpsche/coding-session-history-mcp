import { z } from "zod";

export const PARSER_VERSION = 2;

const envelope = z.object({
  timestamp: z.iso.datetime({ offset: true }),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
const metadata = z.object({
  id: z.string().min(1).max(200),
  cwd: z.string().max(4096),
});
const message = z.object({
  type: z.literal("message"),
  role: z.enum(["user", "assistant"]),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});
type Normalized =
  | { kind: "session"; id: string; cwd: string; timestamp: string }
  | {
      kind: "message";
      role: "user" | "assistant";
      text: string;
      timestamp: string;
    }
  | { kind: "ignored" };

/** Only response_item messages are canonical; event_msg can repeat their contents. */
export function normalize(raw: unknown): Normalized {
  if (
    typeof raw === "object" &&
    raw !== null &&
    "id" in raw &&
    !("payload" in raw)
  )
    throw new Error(
      "Unsupported legacy unwrapped rollout: message timestamps and cwd are unavailable",
    );
  const event = envelope.parse(raw);
  const timestamp = new Date(event.timestamp).toISOString();
  if (event.type === "session_meta") {
    const value = metadata.parse(event.payload);
    return { kind: "session", ...value, timestamp };
  }
  if (
    event.type !== "response_item" ||
    event.payload.type !== "message" ||
    !["user", "assistant"].includes(String(event.payload.role))
  )
    return { kind: "ignored" };
  const value = message.parse(event.payload);
  const text = value.content
    .filter((part) => ["input_text", "output_text"].includes(part.type))
    .map((part) => {
      if (part.text === undefined)
        throw new Error("Text content block is missing text");
      return part.text;
    })
    .join("\n");
  return text
    ? { kind: "message", role: value.role, text, timestamp }
    : { kind: "ignored" };
}
