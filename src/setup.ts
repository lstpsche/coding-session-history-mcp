import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { History } from "./history.js";
import { policy } from "./policy.js";

/** Set up one explicitly selected project without overwriting local scope. */
export function setup(repo: string, source: string, database: string) {
  const cwd = resolve(repo);
  const db = resolve(database);
  const policyPath = resolve(dirname(db), "policy.json");
  mkdirSync(dirname(db), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(
      policyPath,
      JSON.stringify({ mode: "selected", cwds: [cwd], redact: [] }, null, 2) +
        "\n",
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error;
    const existing = policy(policyPath).value;
    if (
      existing.mode !== "selected" ||
      existing.cwds.length !== 1 ||
      existing.cwds[0] !== cwd ||
      existing.sessions.length !== 0 ||
      existing.rollouts !== undefined
    )
      throw new Error(
        `Existing policy selects a different scope: ${policyPath}; use index with that policy or choose a separate --db directory`,
      );
  }
  const history = new History(db);
  try {
    const status = history.index(resolve(source), policyPath);
    const cli = fileURLToPath(new URL("cli.js", import.meta.url));
    return {
      status,
      config: {
        mcpServers: {
          "coding-session-history": {
            command: process.execPath,
            args: [cli, "serve", "--db", db],
          },
        },
      },
      refresh: [
        process.execPath,
        cli,
        "watch",
        "--source",
        resolve(source),
        "--policy",
        policyPath,
        "--db",
        db,
      ],
    };
  } finally {
    history.close();
  }
}
