import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

const literal = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => s.isWellFormed());
const schema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("all"),
      redact: z.array(literal).max(100).default([]),
    })
    .strict(),
  z
    .object({
      mode: z.literal("selected"),
      cwds: z.array(literal).max(1000).default([]),
      sessions: z.array(literal).max(1000).default([]),
      rollouts: z
        .array(
          literal.refine((path) => {
            const parts = path.split("/");
            return (
              /^(sessions|archived_sessions)$/.test(parts[0]!) &&
              parts.length >= 2 &&
              parts.every(
                (part) =>
                  part !== "" &&
                  part !== "." &&
                  part !== ".." &&
                  !part.includes("\\") &&
                  !part.includes("\0"),
              ) &&
              /^rollout-.+\.jsonl$/.test(parts.at(-1)!)
            );
          }),
        )
        .max(1000)
        .refine((paths) => new Set(paths).size === paths.length)
        .optional(),
      redact: z.array(literal).max(100).default([]),
    })
    .strict(),
]);
export function policy(path: string | null) {
  const absolute = path === null ? null : resolve(path);
  const bytes =
    absolute === null ? Buffer.from('{"mode":"all"}') : readFileSync(absolute);
  if (bytes.length > 1024 * 1024) throw new Error("Policy exceeds 1 MiB");
  let value: z.infer<typeof schema>;
  try {
    value = schema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch (cause) {
    throw new Error(
      "Invalid exposure policy; check its JSON schema and UTF-8 encoding (values omitted)",
      { cause },
    );
  }
  return {
    path: absolute,
    digest: createHash("sha256").update(bytes).digest("hex"),
    value,
  };
}
export type Policy = ReturnType<typeof policy>;
export function allows(config: Policy, id: string, cwd: string) {
  return (
    config.value.mode === "all" ||
    config.value.sessions.includes(id) ||
    config.value.cwds.includes(cwd)
  );
}
export function redact(config: Policy, text: string) {
  // One pass over the original string prevents replacement text matching another rule.
  const literals = [...config.value.redact].sort((a, b) => b.length - a.length);
  if (literals.length === 0) return text;
  const pattern = new RegExp(
    literals.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "gu",
  );
  return text.replace(pattern, "[REDACTED]");
}
