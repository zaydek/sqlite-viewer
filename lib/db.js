// db.js — ONE open database and its handle lifecycle.
//
// v1 held exactly one handle in a module global. v2 holds many, so the whole
// freshness mechanism — the part of v1 that is genuinely hard-won — becomes an
// instance instead of a set of module variables. The logic is v1's; the shape
// is not.
//
// THE TRAP THIS EXISTS TO KILL (v1's words, still true):
// `rm` on Unix unlinks the NAME. An already-open file descriptor keeps the old
// inode alive and readable. So a server holding one handle serves the DELETED
// database, forever, with no error and no log line — while every writer talks to
// the new file. Silently confident, permanently wrong.

import fs from "node:fs";
import { backup } from "node:sqlite";
import { describe, describeOne, foreignKeyCheck, openReadOnly, readRows, runQuery } from "./sqlite.js";

/** An error the HTTP layer answers with a specific status rather than a blanket 400. */
export class ServiceError extends Error {
  constructor(message, status, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

/**
 * `dev:ino:birthtime` identifies the FILE. `size:mtime` identifies its CONTENT.
 * Both are load-bearing, for different attacks on the truth:
 *
 *   dev   inode numbers are only unique per filesystem
 *   ino   the `rm` + rebuild case (`just db`)
 *   birth a filesystem may recycle an inode number for a new file
 *   size  \ `cp other.db the.db` leaves the inode ALONE, and an open handle
 *   mtime / then serves the OLD contents forever with no error at all
 */
const identityOf = (stat) =>
  `${stat.dev}:${stat.ino}:${Math.round(stat.birthtimeMs)}:${stat.size}:${Math.round(stat.mtimeMs)}`;

/** Did the FILE change, or only its contents? Only the former is worth a log line. */
const isSameFile = (a, b) => a && b && a.split(":").slice(0, 3).join(":") === b.split(":").slice(0, 3).join(":");

/**
 * Copy the WHOLE database in one backup step. Not a tuning knob — a correctness
 * fix, and the single most surprising thing found while building this.
 *
 * `backup()` defaults to 100 pages per step, and SQLite's online backup RESTARTS
 * FROM PAGE 1 whenever the source is written between two steps. Against a
 * database somebody is actively writing, that never converges: measured on a
 * 20,000-row fixture with one writer committing in a loop, the default rate
 * TIMED OUT AFTER 6 SECONDS having produced nothing, while a single-step copy of
 * the same database under the same writer finished in 39 ms. It does not fail —
 * it hangs, and it hangs inside an HTTP handler, which is worse.
 *
 * One step takes a shared lock for the duration of that step, so a writer waits
 * a few milliseconds instead of a reader waiting forever. `2147483647` is the
 * ceiling: `node:sqlite` requires an int32, and 2147483648 is rejected outright.
 */
const ONE_STEP = 2_147_483_647;

export class Db {
  /**
   * @param entry   the registry record — see registry.js
   * @param options.log      where to say things out loud
   * @param options.prepare  called before every freshness check. For a schema-built
   *                         database this is what rebuilds the derived file when the
   *                         .sql source moved; for a plain file it does nothing.
   *                         Returning a string logs it as the reason for a rebuild.
   */
  constructor(entry, { log, prepare = null } = {}) {
    this.entry = entry;
    this.log = log ?? (() => {});
    this.prepare = prepare;
    this.handle = null;
    this.identity = null;
    this.generation = 0;
  }

  get id() {
    return this.entry.id;
  }

  /**
   * Is this database reachable, without opening it? Answers `/api/dbs` for every
   * registered database on one page load, so it must stay a stat and nothing more.
   *
   * `gone` is a first-class state, not an error: a bookmarked `?db=` for a file
   * that has since been deleted must say WHICH file and WHEN it was opened. A
   * blank page is the failure this whole prototype is arguing against.
   */
  status() {
    if (this.entry.buildError) return { status: "error", detail: this.entry.buildError };

    const built = fs.existsSync(this.entry.path);
    if (this.entry.kind === "schema") {
      // Two files, two different absences, two different sentences. The derived
      // build going missing is recoverable (rebuild); the .sql going missing is
      // not, but what was built from it is still worth showing — labelled.
      if (fs.existsSync(this.entry.sourcePath)) return { status: "ok" };
      if (built) {
        return {
          status: "stale",
          detail: `the schema source ${this.entry.sourcePath} is gone — showing the last build, taken ${new Date(
            this.entry.builtAt * 1000,
          ).toISOString()}`,
        };
      }
      return { status: "gone", detail: `neither ${this.entry.sourcePath} nor its build ${this.entry.path} is on disk` };
    }

    if (!built) return { status: "gone", detail: `${this.entry.path} is no longer on disk` };
    return { status: "ok", bytes: fs.statSync(this.entry.path).size };
  }

  /**
   * Bind to whatever file is at `entry.path` right now. Called at the top of
   * every API request that touches this database. Returns silently in the
   * common case; every other outcome is logged, because a handle swap is
   * exactly the kind of invisible state change that costs an hour at 2am.
   */
  ensureFresh() {
    // Derived databases (a .sql with no data behind it) rebuild here, before the
    // identity check, so editing SCHEMA_PROPOSED.sql shows up in the console the
    // same way editing a real database does.
    if (this.prepare) {
      const reason = this.prepare(this.entry);
      if (reason) this.log(`${this.entry.id}: ${reason}`);
    }
    if (this.entry.buildError) {
      throw new ServiceError(`${this.entry.id}: ${this.entry.buildError}`, 503, { kind: this.entry.kind });
    }

    let stat;
    try {
      stat = fs.statSync(this.entry.path);
    } catch {
      if (this.handle) {
        this.log(`${this.entry.id}: DELETED at ${this.entry.path} — closing the handle rather than serving the unlinked file`);
        this.close();
      }
      throw new ServiceError(
        `No database at ${this.entry.path} — it was deleted while this server was running.`,
        410,
        { gone: true, id: this.entry.id, kind: this.entry.kind, path: this.entry.path, openedAt: this.entry.openedAt },
      );
    }

    const current = identityOf(stat);
    if (this.handle && current === this.identity) return;

    const previous = this.identity;
    if (this.handle) {
      // An ordinary write changes size/mtime many times a minute; reopening on
      // it must stay quiet or the log becomes noise nobody reads. A change of
      // FILE is the rare, surprising event worth saying.
      if (!isSameFile(this.identity, current)) {
        this.log(`${this.entry.id}: REPLACED — reopening  (was ${this.identity}, now ${current})`);
      }
      try {
        this.handle.close();
      } catch {
        /* the old inode may already be unlinked */
      }
      this.handle = null;
    }

    try {
      this.handle = openReadOnly(this.entry.path);
    } catch (error) {
      // The likely cause is catching the file mid-rebuild. Stay unbound and say
      // so; the next request retries and succeeds.
      this.handle = null;
      this.identity = null;
      this.log(`${this.entry.id}: cannot open ${this.entry.path}: ${error.message}`);
      throw new ServiceError(`Cannot open ${this.entry.path}: ${error.message}`, 503);
    }

    this.identity = current;
    this.generation += 1;
    if (!isSameFile(previous, current)) {
      this.log(`${this.entry.id}: opened ${this.entry.path}  (generation ${this.generation}, identity ${this.identity})`);
    }
  }

  close() {
    if (!this.handle) return;
    try {
      this.handle.close();
    } catch {
      /* already gone */
    }
    this.handle = null;
    this.identity = null;
  }

  // -- the API surface, one database at a time --------------------------------

  schema() {
    return describe(this.handle);
  }

  one(name) {
    return describeOne(this.handle, name);
  }

  rows(name, options) {
    return readRows(this.handle, name, options);
  }

  query(sql) {
    return runQuery(this.handle, sql);
  }

  /** Orphan rows, grouped by the foreign key they broke. See sqlite.js. */
  fkCheck() {
    return foreignKeyCheck(this.handle);
  }

  /**
   * The freshness beacon. Deliberately the cheapest thing this server can
   * answer, so the UI can poll it on a timer without being a load source.
   *
   * `data_version` is SQLite's own answer to "has another connection committed
   * since I last looked". It cannot see our own writes, which is perfect: this
   * process never writes to an opened database, so every bump is somebody else.
   */
  version() {
    return {
      id:            this.entry.id,
      generation:    this.generation,
      identity:      this.identity,
      dataVersion:   this.handle.prepare("PRAGMA data_version").get().data_version,
      schemaVersion: this.handle.prepare("PRAGMA schema_version").get().schema_version,
    };
  }

  /**
   * A CONSISTENT copy, via SQLite's online backup API — not `fs.copyFile`.
   *
   * This is the whole difference between story 7 being real and being a lie.
   * Copying the bytes of a database somebody is mid-write to gives you a file
   * with a torn page or a hot journal it knows nothing about; the backup API
   * takes a read lock per step and produces a file that opens cleanly. The one
   * that looks identical in the happy case is the one that hands you a corrupt
   * download exactly when the database was busy — which is exactly when you
   * were trying to capture it.
   */
  async backupTo(destination) {
    this.ensureFresh();
    const pages = await backup(this.handle, destination, { rate: ONE_STEP });
    return { pages, bytes: fs.statSync(destination).size };
  }
}
