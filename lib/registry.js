// registry.js — the thing v1 does not have: MANY databases in one console.
//
// v1's identity is a single `DB_PATH` constant, so "open another database" means
// "start another server on another port". Six experiments meant six ports and
// six terminal tabs, and the tab you wanted was never the one in front.
//
// v2's identity is an `id` in the URL. Everything the console can show — a file
// you named on the command line, a file you dropped on the page, a schema with
// no data behind it, a snapshot pulled off a Fly volume, a clone — is a row in
// ONE registry, reached as `?db=<id>`.
//
// THE MANIFEST IS THE REASON A BOOKMARK SURVIVES A RESTART.
// The registry is written to `<workspace>/registry.json` on every change and read
// back at boot. Without it, `?db=orders-drop` after a restart is a blank page and
// a shrug. With it, the id resolves to a row that either still has its file — in
// which case it just opens — or does not, in which case the console can say
// exactly which path is missing and when it was last opened. A 410 that names
// the file is a debuggable state; a blank page is not.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Db, ServiceError } from "./db.js";
import { fetchSnapshot, integrityOf, looksLikeSqlite } from "./fly.js";
import { blankLiterals } from "./sqlite.js";

// Every file this tool writes lives under one directory.
export const DEFAULT_WORKSPACE = path.join(os.homedir(), ".sqlite-viewer");

const now = () => Math.floor(Date.now() / 1000);

/** Every file this tool writes lives under one directory, and the banner prints it. */
const SUBDIRS = ["derived", "uploads", "schemas", "snapshots", "clones", "outbox"];

const DB_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3", ".db3"]);

/** Semicolon-separated statements, with literals and comments blanked so a `;` in a string does not count. */
const countStatements = (sql) =>
  blankLiterals(sql)
    .split(";")
    .filter((part) => part.trim()).length;

/**
 * A SCHEMA IS A DIRECTORY NOW, NOT ONLY A FILE.
 *
 * A real schema is often several files — `00-plans.sql`, `01-users.sql`, … —
 * and no earlier version of this tool could
 * open it at all: both took a single path. That is not a nice-to-have, it is the
 * reason the current schema draft could not be looked at.
 *
 * ORDER IS THE FILENAME, sorted, and nothing else. The `NN-` prefixes exist
 * precisely so the order is visible in `ls`; inferring it from FK dependencies
 * instead would be a second, invisible ordering that disagrees with the one
 * written on the files. If `01-user.sql` references a table `00-plans.sql`
 * creates, the numbers already say so.
 *
 * WHAT THE ORDER ACTUALLY CONTROLS, measured (prove.mjs, "GESTURE 2"): SQLite
 * resolves FOREIGN KEY targets LAZILY, so a forward `REFERENCES` across files
 * builds fine either way. What breaks when the order is wrong is anything
 * resolved at statement time — an INSERT, a CREATE INDEX, a trigger. So the
 * numbering is not decoration, but it is not the FK graph either.
 *
 * NOT recursive: a directory of schema files is flat, and descending would
 * quietly pick up a `backup/` or `old/` subdirectory sitting next to the real
 * ones.
 */
export function sqlFilesIn(directory) {
  return fs
    .readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith(".sql"))
    .sort()
    .map((name) => path.join(directory, name));
}

/** `mtime:size` for every source file, in order — the whole directory's content identity. */
const stampOf = (files) =>
  files
    .map((file) => {
      const stat = fs.statSync(file);
      return `${path.basename(file)}@${Math.round(stat.mtimeMs)}:${stat.size}`;
    })
    .join("|");

/**
 * A zero-length file IS a valid empty SQLite database — sqlite creates one that
 * way — so the magic check has to allow it or dropping a freshly-created db is
 * refused for being empty. Everything else must carry the header, because
 * registering a text file as a database puts a row in the picker that cannot be
 * opened and gives no clue why.
 */
function assertSqlite(file, what) {
  if (fs.statSync(file).size === 0) return;
  if (looksLikeSqlite(file)) return;
  const head = fs.readFileSync(file).subarray(0, 80).toString("utf8");
  throw new Error(`${what} is not a SQLite database — it has no "SQLite format 3" header. First bytes: ${JSON.stringify(head)}`);
}

export class Registry {
  constructor({ workspace = DEFAULT_WORKSPACE, log = () => {} } = {}) {
    this.workspace = path.resolve(workspace);
    this.log = log;
    this.entries = [];
    this.handles = new Map();
    this.manifest = path.join(this.workspace, "registry.json");

    fs.mkdirSync(this.workspace, { recursive: true });
    for (const dir of SUBDIRS) fs.mkdirSync(path.join(this.workspace, dir), { recursive: true });

    this.load();
  }

  // -- persistence ------------------------------------------------------------

  load() {
    if (!fs.existsSync(this.manifest)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.manifest, "utf8"));
      this.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      this.log(`registry: ${this.entries.length} database${this.entries.length === 1 ? "" : "s"} remembered from ${this.manifest}`);
    } catch (error) {
      // A corrupt manifest must not stop the tool from starting — but it must
      // not be silently replaced either, or you lose the list and never know.
      const wrecked = `${this.manifest}.unreadable-${now()}`;
      fs.renameSync(this.manifest, wrecked);
      this.entries = [];
      this.log(`registry: ${this.manifest} was unreadable (${error.message}) — moved to ${wrecked} and started empty`);
    }
  }

  save() {
    // Write-then-rename: a manifest half-written by a crash is worse than a
    // slightly stale one, and rename is atomic on the same filesystem.
    const temporary = `${this.manifest}.writing`;
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, entries: this.entries }, null, 2)}\n`);
    fs.renameSync(temporary, this.manifest);
  }

  // -- ids --------------------------------------------------------------------

  /**
   * Stable, readable, and in the URL — so it is worth spending a moment on.
   * Derived from the file name, deduplicated with a counter, and never recycled
   * within a run, because two different databases answering the same `?db=` is
   * exactly the confusion this design exists to remove.
   */
  allocateId(base) {
    const slug =
      String(base)
        .toLowerCase()
        .replace(/\.[^.]+$/, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "db";
    if (!this.entries.some((entry) => entry.id === slug)) return slug;
    for (let n = 2; ; n++) {
      const candidate = `${slug}-${n}`;
      if (!this.entries.some((entry) => entry.id === candidate)) return candidate;
    }
  }

  find(id) {
    return this.entries.find((entry) => entry.id === id) ?? null;
  }

  // -- opening ----------------------------------------------------------------

  /** Story 1 — a database file that already exists, named by path. */
  openFile(file, { origin = "argv", kind = "file", extra = {} } = {}) {
    const absolute = path.resolve(file);

    // A missing file is the sqlite3 CLI's sharpest footgun: it silently CREATES
    // an empty database and hands you a working prompt, and you debug an empty
    // schema for ten minutes. Refuse loudly instead.
    if (!fs.existsSync(absolute)) {
      throw new Error(`No database at ${absolute} — refusing to create one; this tool never writes to a database you name.`);
    }
    // A directory is never a database, and the mistake it usually is has an
    // obvious right answer — say the answer rather than failing on the header.
    if (fs.statSync(absolute).isDirectory()) {
      throw new Error(`${absolute} is a directory. If it holds .sql files, open it with --schema ${file} instead.`);
    }
    assertSqlite(absolute, absolute);

    const already = this.entries.find((entry) => entry.path === absolute && entry.kind === kind);
    if (already) {
      this.log(`${absolute} is already open as "${already.id}"`);
      return already;
    }

    const entry = {
      id:       this.allocateId(path.basename(absolute)),
      kind,
      label:    path.basename(absolute),
      path:     absolute,
      origin,
      openedAt: now(),
      ...extra,
    };
    this.entries.push(entry);
    this.save();
    this.log(`opened ${entry.id} — ${kind} — ${absolute}  (${origin})`);
    return entry;
  }

  /**
   * Story 2 — a schema with no database behind it.
   *
   * The .sql is the source of truth and the .db is DERIVED: built into
   * `<workspace>/derived/<id>.db`, rebuilt whenever the .sql changes, and
   * throwaway by definition. That is a deliberate choice over `:memory:`. A real
   * file means one code path for freshness, download, clone and identity instead
   * of two, and it means `--schema SCHEMA_PROPOSED.sql` behaves exactly like a
   * database — including reopening when you edit the SQL in another window.
   */
  openSchema(target, { origin = "argv" } = {}) {
    const absolute = path.resolve(target);
    if (!fs.existsSync(absolute)) throw new Error(`No schema at ${absolute}.`);

    const isDirectory = fs.statSync(absolute).isDirectory();
    if (isDirectory && !sqlFilesIn(absolute).length) {
      // Registering it would put an id in the picker that resolves to an empty
      // database, and "V7 has no tables" is a much harder thing to debug than
      // "V7 has no .sql files in it".
      throw new Error(`${absolute} is a directory with no .sql files in it — nothing to build.`);
    }

    const already = this.entries.find((entry) => entry.kind === "schema" && entry.sourcePath === absolute);
    if (already) {
      this.log(`${absolute} is already open as "${already.id}"`);
      return already;
    }

    const id = this.allocateId(path.basename(absolute));
    const entry = {
      id,
      kind:        "schema",
      label:       path.basename(absolute),
      path:        path.join(this.workspace, "derived", `${id}.db`),
      sourcePath:  absolute,
      sourceKind:  isDirectory ? "directory" : "file",
      sourceFiles: [],
      origin,
      openedAt:    now(),
      sourceStamp: null,
      builtAt:     null,
      buildError:  null,
      statements:  null,
    };
    this.entries.push(entry);
    this.buildDerived(entry);
    this.save();
    return entry;
  }

  /**
   * Build (or rebuild) the derived database for a schema entry. Never throws —
   * the error becomes state, because a schema that does not compile is the most
   * ordinary thing that happens during a schema review and the SQLite message is
   * the single most useful thing on the screen.
   *
   * Files are applied ONE AT A TIME rather than concatenated, so a failure names
   * the file that failed. Against a five-file directory, "V7 did not build: near
   * FOREIGN" sends you reading all five; "V7/03-otp.sql did not build (file 4 of
   * 5): near FOREIGN" does not.
   */
  buildDerived(entry) {
    const directory = entry.sourceKind === "directory";
    const files = directory ? sqlFilesIn(entry.sourcePath) : [entry.sourcePath];
    entry.sourceFiles = files;

    // Remove the previous build outright rather than dropping objects out of it:
    // a rebuild that leaves last version's tables behind is a schema viewer
    // showing a schema that exists nowhere.
    for (const suffix of ["", "-journal", "-wal", "-shm"]) fs.rmSync(entry.path + suffix, { force: true });

    // A directory that has lost every .sql file must SAY so. Building on
    // through would produce an empty database that looks like a schema with no
    // tables — indistinguishable, on screen, from a schema that really has none.
    if (directory && !files.length) {
      entry.buildError = `${entry.sourcePath} has no .sql files in it any more — nothing to build.`;
      entry.statements = null;
      entry.failedFile = null;
      entry.builtAt = now();
      entry.sourceStamp = "";
      this.log(`${entry.id}: BUILD FAILED — ${entry.buildError}`);
      return;
    }

    let statements = 0;
    let failed = null;
    try {
      // FOREIGN KEYS ARE NOT ENFORCED DURING THE BUILD, ON PURPOSE.
      //
      // `node:sqlite` turns them ON by default, which means a schema whose seed
      // INSERTs are not in dependency order — or which carries one genuinely
      // orphaned row — DOES NOT BUILD AT ALL. Measured: pasting a two-table
      // schema with one bad row got `FOREIGN KEY constraint failed` and no
      // drawing, which is the worst of both worlds: the tool that exists to SHOW
      // you a broken reference refuses to show you anything.
      //
      // With enforcement off the build succeeds and the orphan survives into the
      // database, where `PRAGMA foreign_key_check` finds it and the map draws it
      // in red on the exact edge it broke. A violation is a fact to be reported,
      // not a reason to withhold the picture.
      //
      // Nothing is loosened by this: the handle every READ goes through is
      // opened separately and read-only (sqlite.js `openReadOnly`), and
      // foreign_key_check works whether or not enforcement is on.
      const handle = new DatabaseSync(entry.path, { enableForeignKeyConstraints: false });
      try {
        for (const [index, file] of files.entries()) {
          const sql = fs.readFileSync(file, "utf8");
          failed = { file, index };
          handle.exec(sql);
          statements += countStatements(sql);
        }
        failed = null;
      } finally {
        handle.close();
      }
      entry.buildError = null;
      entry.statements = statements;
      entry.failedFile = null;
      this.log(
        `${entry.id}: built ${statements} statements from ${files.length} file${files.length === 1 ? "" : "s"}` +
          ` (${files.map((file) => path.basename(file)).join(" → ")}) → ${entry.path}`,
      );
    } catch (error) {
      // The partial file is left on disk on purpose — it is diagnosable — but
      // `buildError` wins, so every request answers with the SQL error rather
      // than with a half-built schema that looks real.
      const where = failed
        ? `${path.basename(failed.file)}${files.length > 1 ? ` (file ${failed.index + 1} of ${files.length})` : ""}`
        : path.basename(entry.sourcePath);
      entry.buildError = `${where} did not build: ${error.message}`;
      entry.statements = null;
      entry.failedFile = failed?.file ?? null;
      this.log(`${entry.id}: BUILD FAILED — ${entry.buildError}`);
    }
    entry.builtAt = now();
    entry.sourceStamp = stampOf(files);
  }

  /**
   * The freshness hook handed to a schema-backed `Db`. Runs before every
   * identity check, so editing the .sql in another window shows up in the
   * console the same way a write to a real database does.
   */
  prepareSchema = (entry) => {
    let files;
    try {
      // RE-LIST every time rather than trusting `entry.sourceFiles`. Adding
      // `05-billing.sql` to a directory changes no existing file's mtime, so a
      // stamp over the remembered list would never notice the new table — the
      // exact failure a multi-file schema invites.
      files = entry.sourceKind === "directory" ? sqlFilesIn(entry.sourcePath) : [entry.sourcePath];
      for (const file of files) fs.statSync(file);
    } catch {
      // The source is gone. If a build survives, keep serving it — `status()`
      // reports `stale` and names the missing source. If it does not, the
      // identity check below 410s on the derived path, which is the truth.
      return null;
    }

    const stamp = stampOf(files);
    if (stamp === entry.sourceStamp && fs.existsSync(entry.path)) return null;

    const first = !entry.sourceStamp;
    this.buildDerived(entry);
    this.save();
    return first ? `built from ${entry.sourcePath}` : `schema source changed — rebuilt from ${entry.sourcePath}`;
  };

  /**
   * Story 3 — bytes arriving from a drop on the page, with no terminal involved.
   * The extension decides what it is, and the header has to agree: a `.db` with
   * no SQLite magic and a `.sql` that is secretly a database are both refused by
   * name rather than registered and left to fail later.
   */
  acceptUpload(filename, bytes) {
    const safe = path.basename(String(filename || "dropped"));
    const extension = path.extname(safe).toLowerCase();

    if (extension === ".sql") {
      if (bytes.subarray(0, 15).toString("binary") === "SQLite format 3") {
        throw new Error(`${safe} is named .sql but its bytes are a SQLite database — rename it .db and drop it again.`);
      }
      const id = this.allocateId(safe);
      const destination = path.join(this.workspace, "schemas", `${id}.sql`);
      fs.writeFileSync(destination, bytes);
      return this.openSchema(destination, { origin: `dropped as ${safe}` });
    }

    if (DB_EXTENSIONS.has(extension)) {
      const id = this.allocateId(safe);
      const destination = path.join(this.workspace, "uploads", `${id}.db`);
      fs.writeFileSync(destination, bytes);
      try {
        assertSqlite(destination, safe);
      } catch (error) {
        fs.rmSync(destination, { force: true });
        throw error;
      }
      // The dropped bytes are KEPT in the workspace, which is what makes the
      // resulting `?db=` bookmarkable: the browser's File object dies with the
      // page, so a registry pointing at it would be gone on reload.
      return this.openFile(destination, { kind: "upload", origin: `dropped as ${safe}`, extra: { droppedAs: safe } });
    }

    throw new Error(`Don't know what to do with ${safe} — drop a .db/.sqlite database or a .sql schema.`);
  }

  /**
   * GESTURE 1 — SQL pasted into the page.
   *
   * The text is written to a real file in the workspace and then opened exactly
   * like any other schema. That is the point: paste does not get its own code
   * path, its own error handling, or its own rules about what SQL is acceptable.
   * It becomes a `.sql` on disk and everything downstream — the build, the
   * rebuild-on-change, the derived database, the map, the grid, `?db=`,
   * download, clone — is the machinery that already existed.
   *
   * NOTHING PARSES THIS TEXT. schema-viz-v2 read pasted SQL with a hand-written
   * parser and drew whatever it thought it saw. Here SQLite compiles it, and if
   * SQLite refuses, the refusal IS the answer — `buildError` carries the engine's
   * own message to the screen. A picture of a schema that would not compile is
   * worse than no picture.
   */
  acceptPaste(sql, label = null) {
    const text = String(sql ?? "");
    if (!text.trim()) throw new Error("Nothing to build — that paste was empty.");
    if (text.slice(0, 15) === "SQLite format 3") {
      throw new Error("That looks like the bytes of a database, not SQL text. Drop the .db file instead.");
    }

    const base = String(label || "pasted").replace(/\.sql$/i, "");
    const id = this.allocateId(`${base}.sql`);
    const destination = path.join(this.workspace, "schemas", `${id}.sql`);
    fs.writeFileSync(destination, text.endsWith("\n") ? text : `${text}\n`);
    return this.openSchema(destination, { origin: `pasted into the console${label ? ` as ${label}` : ""}` });
  }

  /**
   * GESTURE 2, the hard half — a DIRECTORY of .sql files dropped on the page.
   *
   * A browser cannot hand over a path, only bytes, so a dropped directory
   * arrives as a list of {name, text} and is reconstituted as a real directory
   * in the workspace. From there it is an ordinary directory-backed schema and
   * every rule above applies unchanged, including filename ordering.
   *
   * Names are flattened to their basename: the drop may carry nested paths, and
   * writing those through would let a dropped `../../etc/x.sql` escape the
   * workspace. A schema directory is flat by definition anyway.
   */
  acceptBundle(name, files) {
    const list = (Array.isArray(files) ? files : []).filter((file) => file && typeof file.text === "string");
    if (!list.length) throw new Error(`${name || "that folder"} has no .sql files in it.`);

    const safe = path.basename(String(name || "dropped-schema"));
    const id = this.allocateId(safe);
    const directory = path.join(this.workspace, "schemas", id);
    fs.mkdirSync(directory, { recursive: true });

    const written = [];
    for (const file of list) {
      const leaf = path.basename(String(file.name || "part.sql"));
      if (!leaf.toLowerCase().endsWith(".sql")) continue;
      fs.writeFileSync(path.join(directory, leaf), file.text);
      written.push(leaf);
    }
    if (!written.length) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw new Error(`${safe} has no .sql files in it — nothing to build.`);
    }

    this.log(`${id}: received ${written.length} file${written.length === 1 ? "" : "s"} from a dropped folder — ${written.sort().join(", ")}`);
    return this.openSchema(directory, { origin: `dropped as the folder ${safe} (${written.length} files, applied in filename order)` });
  }

  /** Story 5 — a point-in-time copy off a Fly volume. See fly.js for what that does and does not mean. */
  openFlySnapshot({ app, remotePath, mode, mockRoot, origin = "argv" }) {
    const id = this.allocateId(`${app}-${path.basename(remotePath)}`);
    const destination = path.join(this.workspace, "snapshots", `${id}.db`);
    const result = fetchSnapshot({ app, remotePath, destination, mode, mockRoot, log: (line) => this.log(`snapshot: ${line}`) });

    const entry = {
      id,
      kind:     "snapshot",
      label:    `${app}:${path.basename(remotePath)}`,
      path:     destination,
      origin,
      openedAt: now(),
      fly:      { app, remotePath, mode, mockRoot: mockRoot ?? null, command: result.command },
      snapshot: {
        takenAt:     now(),
        ms:          Number(result.ms.toFixed(1)),
        bytes:       result.bytes,
        integrity:   result.integrity,
        consistency: "raw sftp file copy, not the SQLite backup API — point-in-time, verified with PRAGMA quick_check on arrival",
      },
    };
    this.entries.push(entry);
    this.save();
    this.log(
      `${id}: snapshot of ${app}:${remotePath} (${mode}) — ${result.bytes} bytes in ${result.ms.toFixed(1)} ms, quick_check=${result.integrity}`,
    );
    return entry;
  }

  /** Re-take an existing snapshot in place. A snapshot never updates itself; this is the only way it moves. */
  retakeSnapshot(id) {
    const entry = this.find(id);
    if (!entry) throw new ServiceError(`no database registered as "${id}"`, 404);
    if (entry.kind !== "snapshot") throw new ServiceError(`"${id}" is a ${entry.kind}, not a snapshot`, 400);

    const result = fetchSnapshot({
      app:         entry.fly.app,
      remotePath:  entry.fly.remotePath,
      destination: entry.path,
      mode:        entry.fly.mode,
      mockRoot:    entry.fly.mockRoot,
      log:         (line) => this.log(`snapshot: ${line}`),
    });
    entry.snapshot = {
      takenAt:     now(),
      ms:          Number(result.ms.toFixed(1)),
      bytes:       result.bytes,
      integrity:   result.integrity,
      consistency: entry.snapshot.consistency,
    };
    this.save();
    this.log(`${id}: re-taken — ${result.bytes} bytes, quick_check=${result.integrity}`);
    return entry;
  }

  /**
   * Story 8 — fork the current database to a scratch copy.
   *
   * `backup()` and not `fs.copyFile`, for the same reason as the download: a
   * byte copy of a database somebody is mid-write to can be torn. Cloning is not
   * a write to the SOURCE — the source handle stays `readOnly` and untouched —
   * which is what keeps the read-only promise intact while still producing a
   * file you could safely go and experiment on.
   */
  async clone(id) {
    const source = this.get(id);
    const cloneId = this.allocateId(`${id}-clone`);
    const destination = path.join(this.workspace, "clones", `${cloneId}.db`);
    const { pages, bytes } = await source.backupTo(destination);

    const entry = {
      id:       cloneId,
      kind:     "clone",
      label:    `${source.entry.label} (clone)`,
      path:     destination,
      origin:   `clone of ${id}`,
      openedAt: now(),
      clone:    { of: id, at: now(), pages, bytes, integrity: integrityOf(destination) },
    };
    this.entries.push(entry);
    this.save();
    this.log(`${cloneId}: cloned from ${id} — ${pages} pages, ${bytes} bytes, quick_check=${entry.clone.integrity}`);
    return entry;
  }

  /**
   * Drop a row from the picker WITHOUT deleting anything on disk, and log the
   * path so it can be reopened. A viewer that never forgets grows a graveyard of
   * gone entries; a viewer that deletes your file to tidy its own list is worse.
   */
  forget(id) {
    const entry = this.find(id);
    if (!entry) throw new ServiceError(`no database registered as "${id}"`, 404);
    this.handles.get(id)?.close();
    this.handles.delete(id);
    this.entries = this.entries.filter((candidate) => candidate.id !== id);
    this.save();
    this.log(`forgot ${id} — the file is still at ${entry.path}; nothing was deleted`);
    return entry;
  }

  // -- reading ----------------------------------------------------------------

  /** The `Db` for an id, created on first use. Throws a 404 that lists what DOES exist. */
  get(id) {
    const entry = this.find(id);
    if (!entry) {
      throw new ServiceError(`No database registered as "${id}".`, 404, {
        knownIds: this.entries.map((candidate) => candidate.id),
      });
    }
    let db = this.handles.get(id);
    if (!db) {
      db = new Db(entry, {
        log:     this.log,
        prepare: entry.kind === "schema" ? this.prepareSchema : null,
      });
      this.handles.set(id, db);
    }
    return db;
  }

  /** Everything in the picker, each row carrying its own reachability. One stat per database. */
  list() {
    return this.entries.map((entry) => ({ ...entry, ...this.get(entry.id).status() }));
  }

  /** What `/` opens when nobody said which. The first reachable database, else the first row, else nothing. */
  defaultId() {
    const rows = this.list();
    return (rows.find((row) => row.status === "ok") ?? rows[0])?.id ?? null;
  }
}
