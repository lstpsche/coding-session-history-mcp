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
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { normalize, PARSER_VERSION } from "./parser.js";

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
  roles: z
    .array(z.enum(["user", "assistant"]))
    .min(1)
    .optional(),
});
export const listInput = filters.extend({
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).default(0),
});
export const messagesInput = z.object({
  session_id: z.string().min(1).max(200),
  after: z.number().int().min(-1).default(-1),
  limit: z.number().int().min(1).max(20).default(10),
  char_offset: z.number().int().min(0).default(0),
});
type FileState = {
  path: string;
  offset: number;
  size: number;
  mtime: number;
  ctime: number;
  identity: string;
  session_id: string;
  anchor: string;
};
type Message = {
  sequence: number;
  role: string;
  text: string;
  timestamp: string;
};

const SCHEMA_VERSION = 2;

function fingerprint(stat: Stats) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** Observe namespace and file metadata twice; never publish a detected concurrent change. */
function observe(root: string) {
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
    walk(join(root, name));
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
      CREATE TABLE source(root TEXT NOT NULL, indexed_at TEXT, collections TEXT NOT NULL);
      CREATE TABLE sessions(id TEXT PRIMARY KEY, cwd TEXT NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE files(path TEXT PRIMARY KEY, offset INTEGER NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL, ctime REAL NOT NULL, identity TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE, anchor TEXT NOT NULL);
      CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, timestamp TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, UNIQUE(session_id, sequence));
      CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id');
      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid,text) VALUES(new.id,new.text); END;
      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts,rowid,text) VALUES('delete',old.id,old.text); END;
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

  /** Reconcile the complete configured source set atomically, including moves and deletions. */
  index(source: string) {
    const root = realpathSync(source);
    if (this.db.readonly)
      throw new Error("Cannot index through a read-only database connection");
    const observation = observe(root);
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
            .prepare("INSERT INTO source(root,collections) VALUES(?,?)")
            .run(root, JSON.stringify(observation.collections));
        const current = new Set(paths);
        for (const row of this.db
          .prepare("SELECT * FROM files")
          .all() as FileState[]) {
          if (!current.has(row.path))
            this.db
              .prepare("DELETE FROM sessions WHERE id=?")
              .run(row.session_id);
        }
        for (const path of paths.sort())
          if (this.ingest(path, root, observation.files.get(path)!)) changed++;
        if (observe(root).signature !== observation.signature)
          throw new Error(
            "History source changed during indexing; retry index",
          );
        this.db
          .prepare("UPDATE source SET indexed_at=?, collections=?")
          .run(
            new Date().toISOString(),
            JSON.stringify(observation.collections),
          );
      })
      .immediate();
    return { files: paths.length, changed, ...this.status() };
  }

  private ingest(path: string, root: string, observed: string): boolean {
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
          if (event.kind === "session") {
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
            this.db
              .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
              .run(sessionId, event.cwd, event.timestamp, event.timestamp);
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
                event.text,
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
        .prepare("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?,?,?)")
        .run(
          path,
          offset,
          stat.size,
          stat.mtimeMs,
          stat.ctimeMs,
          identity,
          sessionId,
          anchor(offset),
        );
      return true;
    } finally {
      closeSync(fd);
    }
  }

  status() {
    return {
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
  search(raw: unknown) {
    const input = searchInput.parse(raw);
    const terms = input.query.match(/[\p{L}\p{N}_]+/gu);
    if (!terms?.length)
      throw new Error("Search query must contain letters or numbers");
    const query = terms.map((term) => `"${term}"`).join(" AND ");
    const filter = this.where(input, "m.timestamp");
    if (input.roles) {
      filter.sql += ` AND m.role IN (${input.roles.map(() => "?").join(",")})`;
      filter.values.push(...input.roles);
    }
    return {
      results: this.db
        .prepare(
          `SELECT s.id AS session_id,s.cwd AS repo,m.sequence AS message_id,m.timestamp,m.role,bm25(messages_fts) AS score,snippet(messages_fts,0,'[',']','…',32) AS snippet FROM messages_fts JOIN messages m ON m.id=messages_fts.rowid JOIN sessions s ON s.id=m.session_id WHERE messages_fts MATCH ? ${filter.sql} ORDER BY score,s.id,m.sequence LIMIT ?`,
        )
        .all(query, ...filter.values, input.limit)
        .map((row) => {
          const result = row as { snippet: string };
          return { ...result, snippet: result.snippet.slice(0, 1500) };
        }),
      content_trust: "untrusted historical text",
    };
  }
  list(raw: unknown) {
    const input = listInput.parse(raw);
    const filter = this.where(input, "s.updated_at");
    const rows = this.db
      .prepare(
        `SELECT s.* FROM sessions s WHERE 1=1 ${filter.sql} ORDER BY s.updated_at DESC,s.id LIMIT ? OFFSET ?`,
      )
      .all(...filter.values, input.limit + 1, input.offset);
    return {
      sessions: rows.slice(0, input.limit),
      next_offset:
        rows.length > input.limit ? input.offset + input.limit : null,
    };
  }
  messages(raw: unknown) {
    const input = messagesInput.parse(raw);
    const session = this.db
      .prepare("SELECT * FROM sessions WHERE id=?")
      .get(input.session_id);
    if (!session) throw new Error(`Unknown session: ${input.session_id}`);
    const rows = this.db
      .prepare(
        "SELECT sequence,role,timestamp,text FROM messages WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?",
      )
      .all(input.session_id, input.after, input.limit + 1) as Message[];
    if (
      input.char_offset &&
      (!rows[0] || input.char_offset >= rows[0].text.length)
    )
      throw new Error("char_offset is outside the next message");
    const result: object[] = [];
    let next: { after: number; char_offset: number } | null = null;
    for (const row of rows.slice(0, input.limit)) {
      const start = result.length === 0 ? input.char_offset : 0;
      const end = Math.min(start + 4000, row.text.length);
      result.push({
        ...row,
        message_id: row.sequence,
        text: row.text.slice(start, end),
        char_offset: start,
        truncated: end < row.text.length,
      });
      if (end < row.text.length) {
        next = {
          after:
            result.length === 1
              ? input.after
              : (rows[result.length - 2] as Message).sequence,
          char_offset: end,
        };
        break;
      }
    }
    if (!next && rows.length > input.limit)
      next = {
        after: (rows[input.limit - 1] as Message).sequence,
        char_offset: 0,
      };
    return {
      session,
      messages: result,
      next,
      content_trust: "untrusted historical text",
    };
  }
}
