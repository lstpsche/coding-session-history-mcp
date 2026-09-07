import { policy, allows, redact, type Policy } from "./policy.js";
import Database from "better-sqlite3";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  readdirSync,
  realpathSync,
  mkdirSync,
  fchmodSync,
  lstatSync,
  type Stats,
} from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { normalize, PARSER_VERSION } from "./parser.js";
import { boundedPage, boundedResult } from "./response.js";

const MAX_LINE = 16 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const timestamp = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const filters = z.object({
  repo: z.string().max(4096).optional(),
  since: timestamp.optional(),
  until: timestamp.optional(),
});
export const searchInput = filters.extend({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(20).default(10),
  offset: z.number().int().min(0).default(0),
  corpus_revision: z.uuid().optional(),
  roles: z
    .array(z.enum(["user", "assistant"]))
    .min(1)
    .optional(),
});
export const listInput = filters.extend({
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).default(0),
  corpus_revision: z.uuid().optional(),
});
export const sessionInput = z.object({
  session_id: z.string().min(1).max(200),
  revision: z.uuid().optional(),
});
export const messagesInput = sessionInput
  .extend({
    after: z.number().int().min(-1).default(-1),
    message_id: z.number().int().min(0).optional(),
    before: z.number().int().min(0).max(10).default(0),
    through: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(20).default(10),
    byte_offset: z.number().int().min(0).default(0),
  })
  .strict();
type FileState = {
  path: string;
  offset: number;
  size: number;
  mtime: number;
  ctime: number;
  identity: string;
  session_id: string;
  anchor: string;
  digest: string;
};
type Session = {
  id: string;
  cwd: string;
  started_at: string;
  updated_at: string;
  revision: string;
};
type Removed = { revision: string; offset: number; digest: string };
type Message = {
  sequence: number;
  role: string;
  timestamp: string;
  bytes: number;
};
const SCHEMA_VERSION = 5;
const EMPTY_DIGEST = createHash("sha256").digest("hex");

function fingerprint(stat: Stats) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** Observe namespace and file metadata twice; never publish a detected concurrent change. */
function observe(root: string, rollouts?: string[]) {
  const files = new Map<string, string>();
  const directories = new Map<string, string>();
  const collections: string[] = [];
  const walk = (dir: string) => {
    const before = lstatSync(dir);
    if (!before.isDirectory())
      throw new Error(`Expected real directory: ${dir}`);
    directories.set(dir, fingerprint(before));
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Symlink in history source: ${path}`);
      if (entry.isDirectory()) walk(path);
      else if (
        entry.name.startsWith("rollout-") &&
        entry.name.endsWith(".jsonl")
      ) {
        const stat = lstatSync(path);
        if (!stat.isFile()) throw new Error(`Not a regular rollout: ${path}`);
        files.set(path, fingerprint(stat));
      }
    }
    if (fingerprint(lstatSync(dir)) !== fingerprint(before))
      throw new Error(
        `Source directory changed during discovery: ${dir}; retry index`,
      );
  };
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory())
    throw new Error("Source root must be a real directory");
  const entries = readdirSync(root);
  for (const name of ["sessions", "archived_sessions"]) {
    if (!entries.includes(name)) continue;
    collections.push(name);
    if (rollouts === undefined) walk(join(root, name));
  }
  if (rollouts !== undefined) {
    for (const rollout of [...rollouts].sort()) {
      const parts = rollout.split("/");
      let path = root;
      for (const [index, part] of parts.entries()) {
        path = join(path, part);
        const stat = lstatSync(path);
        if (index === parts.length - 1) {
          if (!stat.isFile()) throw new Error(`Not a regular rollout: ${path}`);
          files.set(path, fingerprint(stat));
        } else {
          if (!stat.isDirectory())
            throw new Error(`Expected real directory: ${path}`);
          // Unselected siblings may change without invalidating this observation.
          directories.set(path, `${stat.dev}:${stat.ino}`);
        }
      }
    }
  }
  return {
    files,
    collections,
    signature: JSON.stringify([
      `${rootStat.dev}:${rootStat.ino}`,
      [...directories],
      [...files],
    ]),
  };
}

export class History {
  readonly db: Database.Database;
  constructor(path: string, options: { readonly?: boolean } = {}) {
    const readonly = options.readonly === true;
    if (path !== ":memory:") {
      if (!readonly) {
        mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
        const fd = openSync(
          path,
          constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          if (!fstatSync(fd).isFile())
            throw new Error("Index must be a regular file");
          fchmodSync(fd, 0o600);
        } finally {
          closeSync(fd);
        }
      } else if (!lstatSync(path).isFile()) {
        throw new Error(
          "Index must be an existing regular file; run index first",
        );
      }
    }
    this.db = new Database(path, { readonly, fileMustExist: readonly });
    try {
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 5000");
      const version = this.db.pragma("user_version", { simple: true });
      if (version === 0 && !readonly) {
        if (this.db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get())
          throw new Error("Unrecognized database; choose a new --db path");
        this.db.transaction(() => {
          this.db.exec(`
      CREATE TABLE source(root TEXT NOT NULL, indexed_at TEXT, collections TEXT NOT NULL, revision TEXT NOT NULL);
      CREATE TABLE sessions(id TEXT PRIMARY KEY, cwd TEXT NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision TEXT NOT NULL);
      CREATE TABLE files(path TEXT PRIMARY KEY, offset INTEGER NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL, ctime REAL NOT NULL, identity TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE, anchor TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, timestamp TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, UNIQUE(session_id, sequence));
      CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id');
      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid,text) VALUES(new.id,new.text); END;
      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts,rowid,text) VALUES('delete',old.id,old.text); END;
      CREATE TABLE exposure(id INTEGER PRIMARY KEY CHECK(id=1), path TEXT, digest TEXT NOT NULL);
      CREATE TABLE refresh(id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL CHECK(state IN ('never','refreshing','ready','failed')), owner INTEGER, error_id TEXT);
      INSERT INTO refresh VALUES(1,'never',NULL,NULL);
      CREATE TABLE index_format(parser_version INTEGER NOT NULL);
      INSERT INTO index_format VALUES(${PARSER_VERSION});
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
        })();
      } else if (version !== SCHEMA_VERSION) {
        throw new Error(
          `Unsupported index schema ${String(version)}; rebuild with index --db <new-path>; existing data is unchanged`,
        );
      }
      const format = this.db
        .prepare("SELECT parser_version FROM index_format")
        .get() as { parser_version: number } | undefined;
      if (format?.parser_version !== PARSER_VERSION)
        throw new Error(
          "Incompatible index parser; rebuild with index --db <new-path>; existing data is unchanged",
        );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }

  private refreshState() {
    return this.db
      .prepare("SELECT state,owner,error_id FROM refresh WHERE id=1")
      .get() as {
      state: "never" | "refreshing" | "ready" | "failed";
      owner: number | null;
      error_id: string | null;
    };
  }

  index(source: string, policyPath: string | null = null) {
    if (this.db.readonly)
      throw new Error("Cannot index through a read-only database connection");
    this.db
      .transaction(() => {
        const refresh = this.refreshState();
        if (refresh.state === "refreshing" && refresh.owner !== null) {
          let alive = true;
          try {
            process.kill(refresh.owner, 0);
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !("code" in error) ||
              error.code !== "ESRCH"
            )
              throw error;
            alive = false;
          }
          if (alive) throw new Error("Another index writer is active");
        }
        this.db
          .prepare(
            "UPDATE refresh SET state='refreshing',owner=?,error_id=NULL WHERE id=1",
          )
          .run(process.pid);
      })
      .immediate();
    try {
      const result = this.reconcile(source, policy(policyPath));
      this.db
        .prepare(
          "UPDATE refresh SET state='ready',owner=NULL,error_id=NULL WHERE id=1",
        )
        .run();
      return { ...result, refresh: this.refreshState() };
    } catch (cause) {
      const id = randomUUID();
      this.db
        .prepare(
          "UPDATE refresh SET state='failed',owner=NULL,error_id=? WHERE id=1",
        )
        .run(id);
      throw new Error(
        `Index refresh failed [${id}]: ${cause instanceof Error ? cause.message : "non-Error failure"}`,
        { cause },
      );
    }
  }

  /** Reconcile the complete configured source set atomically, including moves and deletions. */
  private reconcile(source: string, exposure: Policy) {
    const root = realpathSync(source);
    if (this.db.readonly)
      throw new Error("Cannot index through a read-only database connection");
    const rollouts =
      exposure.value.mode === "selected" ? exposure.value.rollouts : undefined;
    const observation = observe(root, rollouts);
    const paths = [...observation.files.keys()];
    let changed = 0;
    this.db
      .transaction(() => {
        const configured = this.db
          .prepare("SELECT root, collections FROM source")
          .get() as { root: string; collections: string } | undefined;
        if (configured && configured.root !== root)
          throw new Error(
            "Index belongs to another source root; choose a separate database",
          );
        if (configured) {
          const previous = z
            .array(z.string())
            .parse(JSON.parse(configured.collections));
          for (const name of previous) {
            if (!observation.collections.includes(name))
              throw new Error(
                `Previously observed collection disappeared: ${name}; restore it (an empty directory confirms intentional deletion) and retry index`,
              );
          }
        } else
          this.db
            .prepare(
              "INSERT INTO source(root,collections,revision) VALUES(?,?,?)",
            )
            .run(root, JSON.stringify(observation.collections), randomUUID());
        const previousPolicy = this.db
          .prepare("SELECT path,digest FROM exposure WHERE id=1")
          .get() as { path: string | null; digest: string } | undefined;
        if (
          !previousPolicy ||
          previousPolicy.path !== exposure.path ||
          previousPolicy.digest !== exposure.digest
        ) {
          this.db.prepare("DELETE FROM sessions").run();
          this.db
            .prepare("INSERT OR REPLACE INTO exposure VALUES(1,?,?)")
            .run(exposure.path, exposure.digest);
        }
        const current = new Set(paths);
        const removed = new Map<string, Removed>();
        for (const row of this.db
          .prepare("SELECT * FROM files")
          .all() as FileState[]) {
          if (!current.has(row.path)) {
            const session = this.db
              .prepare("SELECT revision FROM sessions WHERE id=?")
              .get(row.session_id) as { revision: string };
            removed.set(row.session_id, {
              revision: session.revision,
              offset: row.offset,
              digest: row.digest,
            });
            this.db
              .prepare("DELETE FROM sessions WHERE id=?")
              .run(row.session_id);
          }
        }
        for (const path of paths.sort())
          if (
            this.ingest(
              path,
              root,
              observation.files.get(path)!,
              removed,
              exposure,
            )
          )
            changed++;
        if (policy(exposure.path).digest !== exposure.digest)
          throw new Error("Exposure policy changed during indexing; retry");
        if (observe(root, rollouts).signature !== observation.signature)
          throw new Error(
            "History source changed during indexing; retry index",
          );
        this.db
          .prepare("UPDATE source SET indexed_at=?, collections=?, revision=?")
          .run(
            new Date().toISOString(),
            JSON.stringify(observation.collections),
            randomUUID(),
          );
      })
      .immediate();
    return { files: paths.length, changed, ...this.status() };
  }

  private ingest(
    path: string,
    root: string,
    observed: string,
    removed: Map<string, Removed>,
    exposure: Policy,
  ): boolean {
    const rel = relative(root, realpathSync(path));
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Source escaped configured root");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error(`Not a regular rollout: ${path}`);
      if (fingerprint(stat) !== observed)
        throw new Error(
          `Rollout changed after discovery: ${path}; retry index`,
        );
      const identity = `${stat.dev}:${stat.ino}`;
      const old = this.db
        .prepare("SELECT * FROM files WHERE path=?")
        .get(path) as FileState | undefined;
      if (
        old &&
        old.identity === identity &&
        old.size === stat.size &&
        old.mtime === stat.mtimeMs &&
        old.ctime === stat.ctimeMs
      )
        return false;
      const anchor = (offset: number) => {
        const data = Buffer.alloc(Math.min(4096, offset));
        const bytes = readSync(fd, data, 0, data.length, offset - data.length);
        if (bytes !== data.length)
          throw new Error(`Rollout changed while reading: ${path}`);
        return createHash("sha256").update(data).digest("hex");
      };
      const append =
        old &&
        old.identity === identity &&
        stat.size > old.size &&
        old.offset <= stat.size &&
        anchor(old.offset) === old.anchor;
      if (old && !append)
        this.db.prepare("DELETE FROM sessions WHERE id=?").run(old.session_id);
      let offset = append ? old.offset : 0;
      let sessionId = append ? old.session_id : undefined;
      let digest = append ? old.digest : EMPTY_DIGEST;
      let moved: Removed | undefined;
      let pending: Buffer = Buffer.alloc(0);
      let position = offset;
      const chunk = Buffer.alloc(64 * 1024);
      while (position < stat.size) {
        const length = readSync(
          fd,
          chunk,
          0,
          Math.min(chunk.length, stat.size - position),
          position,
        );
        if (!length)
          throw new Error(`Rollout truncated while reading: ${path}`);
        position += length;
        pending = Buffer.concat([pending, chunk.subarray(0, length)]);
        let newline: number;
        while ((newline = pending.indexOf(10)) !== -1) {
          if (newline > MAX_LINE)
            throw new Error(
              `Rollout record exceeds ${MAX_LINE} bytes: ${path}`,
            );
          const line = pending.subarray(0, newline);
          digest = createHash("sha256")
            .update(digest)
            .update(line)
            .update("\n")
            .digest("hex");
          const sequence = offset;
          offset += newline + 1;
          pending = pending.subarray(newline + 1);
          let event;
          try {
            event = normalize(JSON.parse(decoder.decode(line)));
          } catch (cause) {
            throw new Error(`Invalid rollout record at ${path}:${sequence}`, {
              cause,
            });
          }
          if (
            sessionId &&
            moved &&
            offset === moved.offset &&
            digest === moved.digest
          )
            this.db
              .prepare("UPDATE sessions SET revision=? WHERE id=?")
              .run(moved.revision, sessionId);
          if (event.kind === "session") {
            if (!sessionId && !allows(exposure, event.id, event.cwd))
              return false;
            if (sessionId) {
              const session = this.db
                .prepare("SELECT cwd FROM sessions WHERE id=?")
                .get(sessionId) as { cwd: string };
              if (event.id !== sessionId || event.cwd !== session.cwd)
                throw new Error(
                  `Conflicting session metadata: ${path}:${sequence}; mixed ownership is unsupported`,
                );
              continue;
            }
            if (sequence !== 0)
              throw new Error(
                `Unexpected session metadata: ${path}:${sequence}`,
              );
            const duplicate = this.db
              .prepare("SELECT id FROM sessions WHERE id=?")
              .get(event.id);
            if (duplicate)
              throw new Error(
                `Duplicate session ID in source: ${path}; keep only one rollout copy`,
              );
            sessionId = event.id;
            moved = removed.get(sessionId);
            this.db
              .prepare("INSERT INTO sessions VALUES(?,?,?,?,?)")
              .run(
                sessionId,
                event.cwd,
                event.timestamp,
                event.timestamp,
                moved && moved.offset === offset && moved.digest === digest
                  ? moved.revision
                  : randomUUID(),
              );
          } else if (!sessionId)
            throw new Error(
              `Rollout does not begin with session metadata: ${path}`,
            );
          else if (event.kind === "message") {
            this.db
              .prepare(
                "INSERT INTO messages(session_id,sequence,timestamp,role,text) VALUES(?,?,?,?,?)",
              )
              .run(
                sessionId,
                sequence,
                event.timestamp,
                event.role,
                redact(exposure, event.text),
              );
            this.db
              .prepare(
                "UPDATE sessions SET updated_at=MAX(updated_at,?) WHERE id=?",
              )
              .run(event.timestamp, sessionId);
          }
        }
        if (pending.length > MAX_LINE)
          throw new Error(`Rollout record exceeds ${MAX_LINE} bytes: ${path}`);
      }
      const after = fstatSync(fd);
      if (fingerprint(after) !== observed)
        throw new Error(`Rollout changed while indexing: ${path}`);
      if (!sessionId) {
        if (offset === 0) return false; // No complete record has been published yet.
        throw new Error(`Missing session metadata: ${path}`);
      }
      this.db
        .prepare("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          path,
          offset,
          stat.size,
          stat.mtimeMs,
          stat.ctimeMs,
          identity,
          sessionId,
          anchor(offset),
          digest,
        );
      return true;
    } finally {
      closeSync(fd);
    }
  }

  status() {
    return {
      refresh: this.refreshState(),
      indexed_at:
        (
          this.db.prepare("SELECT indexed_at FROM source").get() as
            { indexed_at: string } | undefined
        )?.indexed_at ?? null,
      pending_bytes: (
        this.db
          .prepare("SELECT COALESCE(SUM(size-offset),0) AS n FROM files")
          .get() as { n: number }
      ).n,
      sessions: (
        this.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as {
          n: number;
        }
      ).n,
      messages: (
        this.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as {
          n: number;
        }
      ).n,
    };
  }
  private where(input: z.infer<typeof filters>, field: string) {
    if (input.since && input.until && input.since > input.until)
      throw new Error("since must not be later than until");
    const clauses: string[] = [];
    const values: string[] = [];
    if (input.repo) {
      clauses.push("s.cwd=?");
      values.push(input.repo);
    }
    if (input.since) {
      clauses.push(`${field}>=?`);
      values.push(input.since);
    }
    if (input.until) {
      clauses.push(`${field}<=?`);
      values.push(input.until);
    }
    return {
      sql: clauses.length ? " AND " + clauses.join(" AND ") : "",
      values,
    };
  }
  private observation(expected?: string) {
    const exposure = this.db
      .prepare("SELECT path,digest FROM exposure WHERE id=1")
      .get() as { path: string | null; digest: string } | undefined;
    if (exposure && policy(exposure.path).digest !== exposure.digest)
      throw new Error("Exposure policy changed; index again before retrieval");
    const refresh = this.refreshState();
    if (refresh.state === "failed")
      throw new Error(
        `Index refresh failed [${refresh.error_id}]; repair the source and run index again`,
      );
    if (refresh.state === "refreshing")
      throw new Error(
        "Index is refreshing or was interrupted; retry after a successful index",
      );
    const row = this.db
      .prepare("SELECT indexed_at,revision FROM source")
      .get() as { indexed_at: string | null; revision: string } | undefined;
    if (!row?.indexed_at)
      throw new Error(
        "Index is not ready; run index successfully before retrieving history",
      );
    if (expected && expected !== row.revision)
      throw new Error(
        "Stale corpus reference; repeat the search or session list",
      );
    return {
      ready: true as const,
      indexed_at: row.indexed_at,
      revision: row.revision,
    };
  }
  private session(id: string, revision?: string) {
    const session = this.db
      .prepare("SELECT * FROM sessions WHERE id=?")
      .get(id) as Session | undefined;
    if (!session)
      throw new Error(
        revision ? "Stale session reference; search again" : "Unknown session",
      );
    if (revision && revision !== session.revision)
      throw new Error("Stale session reference; search again");
    return session;
  }
  search(raw: unknown) {
    const input = searchInput.parse(raw);
    if (input.offset && !input.corpus_revision)
      throw new Error("Search continuation requires corpus_revision");
    const terms = input.query.match(/[\p{L}\p{N}_]+/gu);
    if (!terms?.length)
      throw new Error("Search query must contain letters or numbers");
    const query = terms.map((term) => `"${term}"`).join(" AND ");
    const filter = this.where(input, "m.timestamp");
    if (input.roles) {
      filter.sql += ` AND m.role IN (${input.roles.map(() => "?").join(",")})`;
      filter.values.push(...input.roles);
    }
    return this.db.transaction(() => {
      const observation = this.observation(input.corpus_revision);
      const rows = this.db
        .prepare(
          `SELECT s.id AS session_id,s.cwd AS repo,s.revision,m.sequence AS message_id,m.timestamp,m.role,bm25(messages_fts) AS score,substr(CAST(snippet(messages_fts,0,'[',']','…',32) AS BLOB),1,4001) AS excerpt FROM messages_fts JOIN messages m ON m.id=messages_fts.rowid JOIN sessions s ON s.id=m.session_id WHERE messages_fts MATCH ? ${filter.sql} ORDER BY score,s.id,m.sequence LIMIT ? OFFSET ?`,
        )
        .all(query, ...filter.values, input.limit + 1, input.offset) as Array<{
        session_id: string;
        repo: string;
        revision: string;
        message_id: number;
        timestamp: string;
        role: string;
        score: number;
        excerpt: Buffer;
      }>;
      function* entries() {
        for (let i = 0; i < Math.min(rows.length, input.limit); i++) {
          const { excerpt, ...row } = rows[i]!;
          const snippet = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(excerpt.subarray(0, 4000), { stream: true });
          yield {
            value: {
              ...row,
              snippet,
              snippet_truncated: excerpt.length > Buffer.byteLength(snippet),
              reference: {
                session_id: row.session_id,
                revision: row.revision,
                message_id: row.message_id,
              },
            },
            next:
              i + 1 < rows.length
                ? {
                    offset: input.offset + i + 1,
                    corpus_revision: observation.revision,
                  }
                : null,
          };
        }
      }
      return boundedPage(entries(), (results, next) => ({
        results,
        next,
        observation,
        content_trust: "untrusted historical text",
      }));
    })();
  }
  list(raw: unknown) {
    const input = listInput.parse(raw);
    if (input.offset && !input.corpus_revision)
      throw new Error("Session-list continuation requires corpus_revision");
    const filter = this.where(input, "s.updated_at");
    return this.db.transaction(() => {
      const observation = this.observation(input.corpus_revision);
      const rows = this.db
        .prepare(
          `SELECT s.* FROM sessions s WHERE 1=1 ${filter.sql} ORDER BY s.updated_at DESC,s.id LIMIT ? OFFSET ?`,
        )
        .all(...filter.values, input.limit + 1, input.offset) as Session[];
      function* entries() {
        for (let i = 0; i < Math.min(rows.length, input.limit); i++)
          yield {
            value: rows[i]!,
            next:
              i + 1 < rows.length
                ? {
                    offset: input.offset + i + 1,
                    corpus_revision: observation.revision,
                  }
                : null,
          };
      }
      return boundedPage(entries(), (sessions, next) => ({
        sessions,
        next,
        observation,
        content_trust: "untrusted historical text",
      }));
    })();
  }
  overview(raw: unknown) {
    const input = sessionInput.parse(raw);
    return this.db.transaction(() => {
      const observation = this.observation();
      const session = this.session(input.session_id, input.revision);
      const counts = this.db
        .prepare(
          "SELECT COUNT(*) AS message_count,MIN(sequence) AS first_message_id,MAX(sequence) AS last_message_id FROM messages WHERE session_id=?",
        )
        .get(session.id) as {
        message_count: number;
        first_message_id: number | null;
        last_message_id: number | null;
      };
      return boundedResult({
        session,
        ...counts,
        observation,
        next: counts.message_count
          ? {
              session_id: session.id,
              revision: session.revision,
              after: -1,
              byte_offset: 0,
            }
          : null,
        content_trust: "untrusted historical text",
      });
    })();
  }
  messages(raw: unknown) {
    const input = messagesInput.parse(raw);
    if (
      (input.after >= 0 ||
        input.message_id !== undefined ||
        input.byte_offset ||
        input.through !== undefined) &&
      !input.revision
    )
      throw new Error(
        "Message reference or continuation requires revision; search or get_session first",
      );
    if (
      input.message_id !== undefined &&
      (input.after !== -1 || input.byte_offset || input.through !== undefined)
    )
      throw new Error("message_id cannot be combined with continuation fields");
    if (
      input.before &&
      (input.message_id === undefined || input.before >= input.limit)
    )
      throw new Error("before requires message_id and must be less than limit");
    return this.db.transaction(() => {
      const observation = this.observation();
      const session = this.session(input.session_id, input.revision);
      let after = input.after;
      let through = input.through;
      if (input.message_id !== undefined) {
        if (
          !this.db
            .prepare("SELECT 1 FROM messages WHERE session_id=? AND sequence=?")
            .get(session.id, input.message_id)
        )
          throw new Error("Unknown message reference; search again");
        const preceding = this.db
          .prepare(
            "SELECT sequence FROM messages WHERE session_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?",
          )
          .all(session.id, input.message_id, input.before) as Array<{
          sequence: number;
        }>;
        after = (preceding.at(-1)?.sequence ?? input.message_id) - 1;
      }
      if (through !== undefined && through <= after)
        throw new Error("through must follow after");
      const rows = this.db
        .prepare(
          `SELECT sequence,role,timestamp,length(CAST(text AS BLOB)) AS bytes FROM messages WHERE session_id=? AND sequence>? ${through === undefined ? "" : "AND sequence<=?"} ORDER BY sequence LIMIT ?`,
        )
        .all(
          session.id,
          after,
          ...(through === undefined ? [] : [through]),
          input.limit + 1,
        ) as Message[];
      if (input.message_id !== undefined) {
        rows.splice(input.limit);
        through = rows.at(-1)!.sequence;
      }
      if (input.byte_offset && (!rows[0] || input.byte_offset >= rows[0].bytes))
        throw new Error("byte_offset is outside the next message");
      const db = this.db;
      function* entries() {
        for (let i = 0; i < Math.min(rows.length, input.limit); i++) {
          const row = rows[i]!;
          const start = i === 0 ? input.byte_offset : 0;
          const part = db
            .prepare(
              "SELECT substr(CAST(text AS BLOB),?,4000) AS bytes FROM messages WHERE session_id=? AND sequence=?",
            )
            .get(start + 1, session.id, row.sequence) as { bytes: Buffer };
          const text = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(part.bytes, { stream: true });
          const end = start + Buffer.byteLength(text);
          if (end <= start) throw new Error("Invalid UTF-8 message boundary");
          const truncated = end < row.bytes;
          const next =
            truncated || i + 1 < rows.length
              ? {
                  session_id: session.id,
                  revision: session.revision,
                  after: truncated
                    ? i === 0
                      ? after
                      : rows[i - 1]!.sequence
                    : row.sequence,
                  byte_offset: truncated ? end : 0,
                  ...(through === undefined ? {} : { through }),
                }
              : null;
          yield {
            value: {
              message_id: row.sequence,
              role: row.role,
              timestamp: row.timestamp,
              text,
              byte_offset: start,
              truncated,
              reference: {
                session_id: session.id,
                revision: session.revision,
                message_id: row.sequence,
              },
            },
            next,
          };
          if (truncated) return;
        }
      }
      return boundedPage(entries(), (messages, next) => ({
        session,
        messages,
        next,
        observation,
        content_trust: "untrusted historical text",
      }));
    })();
  }
}
