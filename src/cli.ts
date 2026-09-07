#!/usr/bin/env node
import { z } from "zod";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { launchd } from "./launchd.js";
import { policy } from "./policy.js";
import { join, resolve } from "node:path";
import { watch } from "./watch.js";
import { History } from "./history.js";
import { makeServer, serveHttp } from "./server.js";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      source: { type: "string" },
      policy: { type: "string" },
      all: { type: "boolean" },
      "interval-ms": { type: "string" },
      db: { type: "string" },
      repo: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      limit: { type: "string" },
      after: { type: "string" },
      "byte-offset": { type: "string" },
      revision: { type: "string" },
      "message-id": { type: "string" },
      before: { type: "string" },
      through: { type: "string" },
      offset: { type: "string" },
      "corpus-revision": { type: "string" },
      port: { type: "string" },
      http: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const [command, argument] = positionals;
  if (values.help || !command) {
    console.log(
      "coding-session-history index|watch|launchd|status|search <query>|sessions|show <id>|messages <id>|serve [--http]\nOptions: --policy <JSON path> | --all (required for writers) --interval-ms <100..300000> --source <Codex home> --db <path> --repo <exact cwd> --since <ISO timestamp> --until <ISO timestamp> --limit <n> --after <message id> --revision <id> --message-id <n> --before <n> --through <n> --byte-offset <n> --offset <n> --corpus-revision <id> --port <n>\nHTTP requires CSH_TOKEN (at least 32 characters) and binds to 127.0.0.1. Run index explicitly to refresh.",
    );
    return;
  }
  if (
    ![
      "index",
      "watch",
      "launchd",
      "status",
      "search",
      "sessions",
      "show",
      "messages",
      "serve",
    ].includes(command)
  )
    throw new Error(`Unknown command: ${command}`);
  if (command === "launchd") {
    if (!values.policy || !values.source || !values.db || values.all)
      throw new Error("launchd requires --source, --db and --policy");
    policy(values.policy);
    console.log(
      launchd(
        resolve(values.source),
        resolve(values.db),
        resolve(values.policy),
      ),
    );
    return;
  }
  if (
    (command === "index" || command === "watch") &&
    Boolean(values.policy) === Boolean(values.all)
  )
    throw new Error(
      "Choose exactly one local scope: --policy <JSON path> or --all",
    );
  if (command === "watch") {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await watch(
        values.source ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"),
        values.db ??
          join(
            homedir(),
            ".local/share/coding-session-history-mcp/index.sqlite",
          ),
        Number(values["interval-ms"] ?? 15000),
        controller.signal,
        values.policy ?? null,
      );
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    return;
  }
  const history = new History(
    values.db ??
      join(homedir(), ".local/share/coding-session-history-mcp/index.sqlite"),
    { readonly: command !== "index" },
  );
  const number = (value: string | undefined) =>
    value === undefined ? undefined : Number(value);
  const input = {
    repo: values.repo,
    offset: number(values.offset),
    corpus_revision: values["corpus-revision"],
    since: values.since,
    until: values.until,
    limit: values.limit === undefined ? undefined : Number(values.limit),
  };
  let serving = false;
  try {
    let output: unknown;
    switch (command) {
      case "index":
        output = history.index(
          values.source ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"),
          values.policy ?? null,
        );
        break;
      case "status":
        output = history.status();
        break;
      case "search":
        output = history.search({ ...input, query: argument });
        break;
      case "sessions":
        output = history.list(input);
        break;
      case "show":
        output = history.overview({
          session_id: argument,
          revision: values.revision,
        });
        break;
      case "messages":
        output = history.messages({
          session_id: argument,
          limit: input.limit,
          after: values.after === undefined ? undefined : Number(values.after),
          revision: values.revision,
          message_id: number(values["message-id"]),
          before: number(values.before),
          through: number(values.through),
          byte_offset: number(values["byte-offset"]),
        });
        break;
      case "serve": {
        const port = Number(values.port ?? 7432);
        if (!Number.isInteger(port) || port < 1 || port > 65535)
          throw new Error("port must be between 1 and 65535");
        const service = values.http
          ? await serveHttp(history, process.env.CSH_TOKEN ?? "", port)
          : serveStdio(() => makeServer(history));
        serving = true;
        let closing = false;
        const shutdown = () => {
          if (closing) return;
          closing = true;
          service
            .close()
            .catch((error: unknown) => {
              console.error(
                error instanceof Error ? error.message : "Shutdown failed",
              );
              process.exitCode = 1;
            })
            .finally(() => history.close());
        };
        process.once("SIGINT", () => {
          shutdown();
        });
        process.once("SIGTERM", () => {
          shutdown();
        });
        if (!values.http) process.stdin.once("end", shutdown);
        return;
      }
    }
    console.log(JSON.stringify(output));
  } finally {
    if (!serving) history.close();
  }
}
function describeFailure(error: unknown): string {
  if (error instanceof SyntaxError)
    return "Invalid JSON syntax (record content omitted)";
  if (error instanceof z.ZodError)
    return (
      "Invalid record or argument schema: " +
      error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.code}`)
        .join(", ")
    );
  if (!(error instanceof Error)) return "Non-Error failure";
  const code =
    "code" in error && typeof error.code === "string" ? ` [${error.code}]` : "";
  return (
    error.message +
    code +
    (error.cause === undefined
      ? ""
      : `; caused by: ${describeFailure(error.cause)}`)
  );
}
main().catch((error: unknown) => {
  console.error(describeFailure(error));
  process.exitCode = 1;
});
