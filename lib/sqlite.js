// sqlite.js — everything about talking to SQLite safely, and about what a
// column MEANS. Carried over from the first version of this tool, with the
// module-level `db` handle lifted out into a parameter, because v2 holds MANY
// handles at once and none of them can be a module global any more.
//
// Nothing in here knows about HTTP, the registry, or the workspace. It is the
// half of v1 that was already right.
//
// WHAT v3 ADDED, AND WHY IT MATTERS MORE THAN IT LOOKS.
// `schema-viz-v2` drew its diagram by PARSING SQL text with a hand-written
// dialect guess: 400 lines that had to be told what a foreign key looks like.
// This file already had the answer — `PRAGMA foreign_key_list` is the engine's
// own catalog and cannot disagree with the database. So v3 deleted the parser
// outright and made this the single source of the drawing. Three things were
// added here to make that a strict upgrade rather than a trade:
//
//   1. INDEXES come from `PRAGMA index_list` + `index_info`, so a UNIQUE
//      CONSTRAINT (which creates an index with no CREATE statement of its own)
//      is drawn too — the text parser only ever saw explicit CREATE INDEX.
//      The partial `WHERE` predicate is lifted from the stored SQL, because it
//      exists nowhere else.
//   2. KEYS — the actual primary-key values of a small lookup table. v2 read
//      seed values out of INSERT statements; these are the rows that are
//      really there.
//   3. foreignKeyCheck — integrity is a property of DATA, so only a real
//      database can report it. No parser can.

import { DatabaseSync } from "node:sqlite";

// -- identifiers and 64-bit integers ------------------------------------------

/**
 * Quote an identifier. Doubling embedded quotes is the whole job, and skipping
 * it is not a style issue: a table genuinely named `we"ird` turns
 * `PRAGMA table_info("we"ird")` into a syntax error, which in v1 took the whole
 * SERVER DOWN AT STARTUP because the boot banner describes the schema.
 */
export const quoteId = (name) => `"${String(name).replaceAll('"', '""')}"`;

/**
 * SQLite integers are 64-bit; JavaScript numbers are not. `node:sqlite` refuses
 * to guess and THROWS past 2^53 — which crashed v1 on any database holding a
 * snowflake id or a hash. Reading as BigInt never throws, so we always do that
 * and narrow afterwards: back to a number when it fits exactly, otherwise to a
 * string that keeps every digit. Showing `9223372036854775807` beats refusing
 * to start.
 */
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
export const fromSqlite = (value) => {
  if (typeof value !== "bigint") return value;
  return value <= SAFE && value >= -SAFE ? Number(value) : value.toString();
};

/** Every row of a statement, with 64-bit integers made safe. */
export function readAll(statement, ...params) {
  statement.setReadBigInts(true);
  const rows = statement.all(...params);
  for (const row of rows) {
    for (const key of Object.keys(row)) row[key] = fromSqlite(row[key]);
  }
  return rows;
}

const isBytes = (v) => v instanceof Uint8Array || Buffer.isBuffer(v);

/**
 * `node:sqlite` hands BLOBs back as Uint8Array, and `JSON.stringify` turns one
 * into `{"0":222,"1":173,…}` — an object keyed by byte index, which renders as
 * garbage in every client. Convert to something a human can read, and say how
 * big it was, because the size is usually the only thing you wanted.
 */
export function normalize(rows) {
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const value = row[key];
      if (!isBytes(value)) continue;
      const hex = Buffer.from(value).toString("hex");
      row[key] = value.length <= 24 ? `x'${hex}'` : `x'${hex.slice(0, 48)}…' (${value.length} bytes)`;
    }
  }
  return rows;
}

// -- column meaning -----------------------------------------------------------

/**
 * What is this column, really? SQLite's declared type is a hint, not a promise
 * (type affinity lets any value into any column), so this reads the declared
 * type, the NAME, and a sample of actual VALUES together.
 *
 * This is v1's `inferKind` unchanged, on purpose. It is the one idea the whole
 * tool is built around and v2 has no quarrel with it — v2's argument is about
 * how many databases you can point it at, not about what a column means.
 */
export function inferKind(name, declaredType, samples) {
  const type = (declaredType || "").toUpperCase();
  const lower = name.toLowerCase();
  const nonNull = samples.filter((v) => v !== null && v !== undefined);

  // BLOB first: bytes are never a date, a number, or JSON, and the samples here
  // are still raw Uint8Arrays.
  if (type.includes("BLOB") || (nonNull.length > 0 && nonNull.every(isBytes))) return "blob";

  // Timestamps: unixepoch() seconds. 1e9 = 2001, 4e9 = 2096 — a range that
  // excludes counts, percentages and ids while covering any plausible date.
  // `^at$` earns its place: a log table reads best as `at | tbl | op`.
  const looksTemporal = /(_at|_on|_time|^at$|^created$|^updated$|^expires$)$/.test(lower);
  const allInEpochRange =
    nonNull.length > 0 && nonNull.every((v) => typeof v === "number" && v > 1_000_000_000 && v < 4_000_000_000);
  if (type.includes("INT") && looksTemporal && allInEpochRange) return "timestamp";

  // JSON payloads stored as TEXT.
  if (nonNull.length > 0 && nonNull.every((v) => typeof v === "string" && /^\s*[{[]/.test(v))) return "json";

  // Booleans: 0/1 only, and named like a predicate.
  const onlyBits = nonNull.length > 0 && nonNull.every((v) => v === 0 || v === 1);
  if (onlyBits && /^(is_|has_|can_)/.test(lower)) return "bool";

  // Identifiers — rendered quietly, because nobody reads a uuid.
  if (lower === "id" || lower.endsWith("_id")) return "id";

  if (type.includes("INT") || type.includes("REAL") || type.includes("NUM")) return "number";

  // VIEWS declare no column types at all — `PRAGMA table_info` returns "" for
  // every one — so without this fallback every computed count in a view renders
  // left-aligned as text. Trust the values when the schema has nothing to say.
  if (!type && nonNull.length > 0 && nonNull.every((v) => typeof v === "number")) {
    return onlyBits && /(^|_)(is|has|can)_/.test(lower) ? "bool" : "number";
  }

  return "text";
}

// -- describing a database ----------------------------------------------------

const OBJECT_COLUMNS = `SELECT name, type, sql FROM sqlite_master
   WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'`;

/** Hard ceiling on a hand-written query's result. See runQuery. */
export const MAX_QUERY_ROWS = 5000;

/**
 * Run a multi-statement read as ONE snapshot, so a writer committing between
 * two statements cannot make the two halves of a single response describe
 * different databases. `BEGIN` on a read-only handle is a read transaction.
 */
export function snapshot(handle, read) {
  handle.exec("BEGIN");
  try {
    return read();
  } finally {
    try {
      handle.exec("COMMIT");
    } catch {
      /* nothing was written; ending the read transaction is best-effort */
    }
  }
}

/**
 * One table or view as it exists RIGHT NOW.
 *
 * NEVER THROWS. A broken object — classically a view whose underlying table a
 * migration dropped — used to take down `/api/schema` entirely, so ONE bad view
 * hid every healthy table and the console would not boot. Objects fail
 * individually: the bad one carries an `error` and the rest stays browsable.
 */
export function describeObject(handle, object) {
  try {
    return describeObjectOrThrow(handle, object);
  } catch (error) {
    return {
      name:    object.name,
      type:    object.type,
      sql:     object.sql,
      count:   null,
      columns: [],
      indexes: [],
      error:   String(error.message || error),
    };
  }
}

/**
 * The partial predicate of a `CREATE INDEX … WHERE …`.
 *
 * It lives ONLY in the stored SQL — no PRAGMA reports it, and `index_list`
 * says nothing beyond `partial: 1`. Dropping it is what generic viewers do and
 * it is exactly the interesting half: "unique(user_id)" and
 * "unique(user_id) where revoked_at IS NULL" are different rules.
 *
 * Scanned against `blankLiterals`, so a `WHERE` inside a quoted default cannot
 * be mistaken for the clause. An UNQUOTED bare `WHERE` cannot appear anywhere
 * else in a CREATE INDEX statement — it is a reserved word — so the first hit
 * is the predicate.
 */
function partialPredicate(sql) {
  if (!sql) return null;
  const match = /\bWHERE\b/i.exec(blankLiterals(sql));
  return match ? sql.slice(match.index + "WHERE".length).trim() : null;
}

/**
 * Every index on a table, INCLUDING the ones with no CREATE statement.
 *
 * `sqlite_master` only holds indexes you wrote by hand. A `UNIQUE` constraint
 * inside a CREATE TABLE builds a real index with `origin: "u"` and no SQL of
 * its own, and it is just as much a rule of the schema — the text parser in
 * schema-viz-v2 had to reconstruct those from the column definition. Here they
 * are simply listed.
 *
 * `origin: "pk"` is skipped: the primary key is already marked on its column
 * and repeating it in the footer of every node is noise.
 */
function indexesOf(handle, object) {
  if (object.type !== "table") return [];
  const id = quoteId(object.name);

  const written = new Map(
    handle
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=?`)
      .all(object.name)
      .map((row) => [row.name, row.sql]),
  );

  const out = [];
  for (const index of handle.prepare(`PRAGMA index_list(${id})`).all()) {
    if (index.origin === "pk") continue;
    const sql = written.get(index.name) ?? null;
    out.push({
      name:    index.name,
      sql,
      unique:  Boolean(index.unique),
      partial: Boolean(index.partial),
      origin:  index.origin === "c" ? "created" : "constraint",
      columns: handle
        .prepare(`PRAGMA index_info(${quoteId(index.name)})`)
        .all()
        // cid -1 is rowid and -2 an expression; neither has a column name, and
        // `null` in that slot would render as the word "null" in the drawing.
        .map((part) => part.name ?? (part.cid === -2 ? "(expression)" : "rowid")),
      where:   partialPredicate(sql),
    });
  }
  return out;
}

/**
 * The primary-key values of a SMALL table, verbatim.
 *
 * A lookup table — plan tiers, delivery kinds, channel types — is the one place
 * where the rows ARE the schema, and reading `('rush','standard')` off the node
 * answers a question the column list cannot. schema-viz-v2 showed this by
 * scraping INSERT statements out of the .sql; these are the rows that actually
 * exist, which is the whole reason v3 talks to a database instead of to text.
 *
 * Bounded hard at 12 and to a single text key, so it can never turn into a
 * data dump inside a diagram.
 */
function lookupKeys(columns, sample, count) {
  if (!count || count > 12 || sample.length !== count) return [];
  const keys = columns.filter((column) => column.primaryKey);
  if (keys.length !== 1) return [];
  const key = keys[0];
  if (!/CHAR|CLOB|TEXT/i.test(key.type || "")) return [];
  return sample.map((row) => String(row[key.name])).filter((value) => value !== "null");
}

function describeObjectOrThrow(handle, object) {
  const id = quoteId(object.name);
  const info = handle.prepare(`PRAGMA table_info(${id})`).all();
  // 200 rows is enough to infer a column's nature and cheap on any table.
  const sample = readAll(handle.prepare(`SELECT * FROM ${id} LIMIT 200`));
  const count = handle.prepare(`SELECT COUNT(*) AS n FROM ${id}`).get().n;

  const foreignKeys = {};
  if (object.type === "table") {
    for (const fk of handle.prepare(`PRAGMA foreign_key_list(${id})`).all()) {
      foreignKeys[fk.from] = { table: fk.table, to: fk.to };
    }
  }

  const columns = info.map((column) => ({
    name:       column.name,
    type:       column.type,
    notNull:    Boolean(column.notnull),
    primaryKey: Boolean(column.pk),
    references: foreignKeys[column.name] ?? null,
    kind:       inferKind(
      column.name,
      column.type,
      sample.map((row) => row[column.name]),
    ),
  }));

  return {
    name: object.name,
    type: object.type,
    sql:  object.sql,
    count,
    columns,
    indexes: indexesOf(handle, object),
    keys:    lookupKeys(columns, sample, count),
  };
}

/**
 * `PRAGMA foreign_key_check` — every row whose parent does not exist.
 *
 * This is the one thing in the whole tool that NEITHER prototype could do
 * alone. schema-viz-v2 has the picture and no data; sql-console-v2 has the data
 * and no picture. Drawing a violation on the edge it belongs to is the entire
 * argument for combining them.
 *
 * It runs whether or not `PRAGMA foreign_keys` is ON — a database built from a
 * schema file with enforcement off is precisely the one worth checking, because
 * nothing stopped the bad row going in.
 *
 * The pragma reports `fkid`, an index into that table's `foreign_key_list`, so
 * the child COLUMN has to be looked back up; a violation reported against a
 * table with three foreign keys is useless without knowing which one broke.
 */
export function foreignKeyCheck(handle) {
  return snapshot(handle, () => {
    const rows = handle.prepare("PRAGMA foreign_key_check").all();
    const lists = new Map();
    const out = new Map();

    for (const row of rows) {
      if (!lists.has(row.table)) {
        lists.set(row.table, handle.prepare(`PRAGMA foreign_key_list(${quoteId(row.table)})`).all());
      }
      const fk = lists.get(row.table).find((candidate) => candidate.id === row.fkid);
      const column = fk?.from ?? "(unknown column)";
      const key = `${row.table}.${column}`;
      const seen = out.get(key);
      if (seen) {
        seen.rows += 1;
        continue;
      }
      out.set(key, {
        table:  row.table,
        column,
        parent: row.parent ?? fk?.table ?? null,
        to:     fk?.to ?? null,
        rows:   1,
        // One example rowid, because "3 orphans in orders.customer_id" is a
        // headline and `SELECT * FROM orders WHERE rowid = 41` is the fix.
        example: row.rowid ?? null,
      });
    }
    return [...out.values()];
  });
}

/** Every table and view. Computed per request — nothing here is cached. */
export function describe(handle) {
  return snapshot(handle, () =>
    handle
      .prepare(`${OBJECT_COLUMNS} ORDER BY type DESC, name`)
      .all()
      .map((object) => describeObject(handle, object)),
  );
}

export function describeOne(handle, name) {
  const object = handle.prepare(`${OBJECT_COLUMNS} AND name = ?`).get(name);
  return object ? describeObject(handle, object) : null;
}

// -- reads --------------------------------------------------------------------

export function readRows(handle, name, { limit = 50, offset = 0, orderBy = null, dir = "ASC" } = {}) {
  // One snapshot, so `count` and `rows` cannot describe different databases.
  return snapshot(handle, () => {
    const object = describeOne(handle, name);
    if (!object) throw new Error(`no such table or view: ${name}`);
    if (object.error) throw new Error(object.error);

    // Identifiers are validated against the real schema AND quoted. The
    // allowlist stops an invented name reaching SQL; the quoting stops a real
    // name containing a double quote from breaking the statement.
    let order = "";
    if (orderBy && object.columns.some((column) => column.name === orderBy)) {
      order = ` ORDER BY ${quoteId(orderBy)} ${dir === "DESC" ? "DESC" : "ASC"}`;
    }

    const statement = handle.prepare(`SELECT * FROM ${quoteId(name)}${order} LIMIT ? OFFSET ?`);
    const rows = normalize(readAll(statement, Math.min(Number(limit) || 50, 500), Number(offset) || 0));

    return { name, count: object.count, columns: object.columns, rows };
  });
}

/**
 * Blank out the CONTENTS of string literals and comments, keeping the length
 * and everything outside them intact. Guards that scan for punctuation need
 * this: `SELECT 'a;b'` contains a semicolon that is data, not a separator.
 */
export function blankLiterals(sql) {
  let out = "";
  for (let i = 0; i < sql.length; ) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (sql[i] === "'" || sql[i] === '"' || sql[i] === "`") {
      const quote = sql[i];
      let j = i + 1;
      // A doubled quote inside a literal is an escaped quote, not the end of it.
      while (j < sql.length) {
        if (sql[j] === quote && sql[j + 1] === quote) j += 2;
        else if (sql[j] === quote) break;
        else j += 1;
      }
      const stop = Math.min(j + 1, sql.length);
      out += quote + " ".repeat(stop - i - 1);
      i = stop;
    } else {
      out += sql[i];
      i += 1;
    }
  }
  return out;
}

/**
 * Arbitrary SQL, read-only. The handle itself is opened `readOnly: true`, so
 * this guard is defence in depth — but it fails with a sentence a human
 * understands instead of SQLITE_READONLY.
 */
export function runQuery(handle, sql) {
  const trimmed = sql.trim().replace(/;+\s*$/, "");

  // Test the guard against the statement with LEADING COMMENTS STRIPPED, so
  // ordinary commented SQL runs. The comments still go to SQLite; only the
  // check ignores them.
  let head = trimmed;
  for (;;) {
    const before = head;
    head = head
      .replace(/^\s*--[^\n]*\n?/, "")
      .replace(/^\s*\/\*[\s\S]*?\*\//, "")
      .trimStart();
    if (head === before) break;
  }

  if (!/^(SELECT|WITH|EXPLAIN|PRAGMA)\b/i.test(head)) {
    throw new Error("Read-only: statements must begin with SELECT, WITH, EXPLAIN or PRAGMA.");
  }

  // Everything below is tested against `code` — the statement with the CONTENTS
  // of literals and comments blanked — so a semicolon inside a quoted value
  // cannot be mistaken for syntax.
  const code = blankLiterals(trimmed);

  // `prepare()` compiles ONE statement and silently ignores what follows, so
  // `SELECT * FROM a; SELECT * FROM b` returned only `a` with no hint that half
  // the request was dropped. Say it out loud instead.
  const semicolon = code.indexOf(";");
  if (semicolon !== -1 && code.slice(semicolon + 1).trim() !== "") {
    throw new Error("One statement at a time: everything after the first ';' would be ignored.");
  }

  // `PRAGMA busy_timeout = 0` is not a read: it mutates the SHARED connection
  // and sticks there, silently undoing the busy timeout for every later request.
  // Read-only protects the database, not the connection.
  if (/^\s*PRAGMA\b[^=]*=/i.test(blankLiterals(head))) {
    throw new Error("PRAGMA assignments change this shared connection and are refused; reading a PRAGMA is fine.");
  }

  const started = process.hrtime.bigint();
  // Iterate and break rather than `.all()`: `truncated` must mean "we stopped
  // early", and a synchronous `SELECT * FROM huge_table` otherwise pins the
  // event loop and freezes every other tab's polling.
  const statement = handle.prepare(trimmed);
  statement.setReadBigInts(true);
  const rows = [];
  let truncated = false;
  for (const row of statement.iterate()) {
    if (rows.length >= MAX_QUERY_ROWS) {
      truncated = true;
      break;
    }
    for (const key of Object.keys(row)) row[key] = fromSqlite(row[key]);
    rows.push(row);
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  // ORDER MATTERS: infer BEFORE normalize(). normalize() turns a BLOB's
  // Uint8Array into the string `x'deadbeef'`, and once it has, inferKind sees a
  // string and calls it text.
  const names = rows.length ? Object.keys(rows[0]) : [];
  const columns = names.map((name) => ({
    name,
    type: "",
    kind: inferKind(
      name,
      typeof rows[0]?.[name] === "number" ? "INTEGER" : "TEXT",
      rows.slice(0, 200).map((row) => row[name]),
    ),
  }));

  return { rows: normalize(rows), columns, ms, truncated };
}

/** The one place a handle is created, so `readOnly` and the busy timeout are not optional. */
export function openReadOnly(file) {
  const handle = new DatabaseSync(file, { readOnly: true });
  // A PRAGMA, not the constructor's `timeout` option: `DatabaseSync` accepts
  // unknown options SILENTLY, so `{ timeout: 5000 }` did nothing while looking
  // right. "The constructor did not throw" proves nothing.
  handle.exec("PRAGMA busy_timeout = 5000");
  return handle;
}
