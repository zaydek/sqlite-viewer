#!/usr/bin/env -S node --no-warnings
// prove.mjs — the receipts. Every user story, exercised against a real server.
//
//   node prove.mjs
//
// EXTENDED, NOT REPLACED. Everything the earlier console proved is still proved here
// unchanged — the command line, the registry, freshness, snapshots, clones, the
// consistent download. What is added, at the bottom, is what v3 claims on top:
// the two gestures (paste, drop-a-folder), the directory-backed schema and its
// filename ordering, the PRAGMA-derived graph the map is drawn from, and
// `foreign_key_check`. If a v3 assertion passes but a v2 one broke, nothing was
// subsumed — it was replaced, which is the failure this file exists to catch.
//
// Self-contained: builds its own hostile fixtures in a temp directory, uses its
// own workspace (so it never touches ~/.sqlite-viewer), asks the OS for a free
// port, spawns real `node server.js` processes, and tears everything down. A
// suite that needs some other project's database checked out is a suite nobody
// runs.
//
// It prints a transcript, not just dots: the point is that RECEIPTS.md can quote
// observed output rather than assert that something worked.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "server.js");

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-viewer-prove-"));
const FIX = path.join(RUN, "fixtures");
const WS = path.join(RUN, "workspace");
const VOLUME = path.join(RUN, "fake-fly-volume");
fs.mkdirSync(FIX, { recursive: true });
fs.mkdirSync(path.join(VOLUME, "data"), { recursive: true });

let passed = 0;
let failed = 0;
const failures = [];

const say = (...parts) => console.log(...parts);
const head = (title) => say(`\n${"─".repeat(78)}\n${title}\n${"─".repeat(78)}`);
const show = (label, value) => say(`    ${label.padEnd(22)} ${value}`);

function ok(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    say(`  ✓ ${label}${detail ? `   ${detail}` : ""}`);
  } else {
    failed += 1;
    failures.push(label);
    say(`  ✗ ${label}${detail ? `   ${detail}` : ""}`);
  }
}

// -- fixtures -----------------------------------------------------------------

const NOW = 1785524191; // a fixed epoch so the transcript is reproducible

function buildOrdersDb(file) {
  fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE customers (
      id         INTEGER PRIMARY KEY,
      email      TEXT NOT NULL,
      is_active  INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      profile    TEXT
    );
    CREATE TABLE orders (
      id          INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      cents       INTEGER NOT NULL,
      percent_at  INTEGER NOT NULL,          -- the trap: named like a date, holds 22
      snowflake   INTEGER NOT NULL,          -- past 2^53
      receipt     BLOB,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX orders_open ON orders(customer_id) WHERE cents > 0;
    CREATE TABLE "we""ird" (n INTEGER);      -- a legal name that breaks naive quoting
    CREATE TABLE 顧客 (名前 TEXT);
    CREATE VIEW order_totals AS
      SELECT c.email, COUNT(o.id) AS orders, SUM(o.cents) AS cents FROM customers c
      LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.email;
  `);
  const customer = db.prepare("INSERT INTO customers (email, is_active, created_at, profile) VALUES (?,?,?,?)");
  for (let i = 1; i <= 6; i++) {
    customer.run(`person${i}@example.com`, i % 2, NOW - i * 3600, JSON.stringify({ tier: i % 3 ? "free" : "paid" }));
  }
  const order = db.prepare("INSERT INTO orders (customer_id, cents, percent_at, snowflake, receipt, created_at) VALUES (?,?,?,?,?,?)");
  for (let i = 1; i <= 25; i++) {
    order.run(((i - 1) % 6) + 1, i * 1250, 22, 9223372036854775807n, Buffer.from(`receipt-${i}`), NOW - i * 900);
  }
  db.prepare("INSERT INTO \"we\"\"ird\" (n) VALUES (1)").run();
  db.close();
}

const SCHEMA_SQL = `-- SCHEMA_PROPOSED_tanks.sql — a schema with no data behind it yet.
CREATE TABLE tank_connections (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  serial      TEXT NOT NULL UNIQUE,
  percent_at  INTEGER,
  last_seen_at INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE deliveries (
  id        INTEGER PRIMARY KEY,
  tank_id   INTEGER NOT NULL REFERENCES tank_connections(id),
  gallons   REAL NOT NULL,
  is_rush   INTEGER NOT NULL DEFAULT 0,
  payload   TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX deliveries_recent ON deliveries(created_at) WHERE is_rush = 1;

-- A real schema file carries seed rows for its lookup tables, and the build
-- runs every statement — so this table arrives populated and the data tables
-- do not. Both halves are asserted below.
CREATE TABLE delivery_kinds (id TEXT PRIMARY KEY, label TEXT NOT NULL);
INSERT INTO delivery_kinds (id, label) VALUES ('rush', 'Rush'), ('standard', 'Standard');
`;

// -- v3 fixtures ---------------------------------------------------------------

/** GESTURE 1. A self-reference, a partial unique index, and seed rows. */
const PASTE_SQL = `CREATE TABLE authors (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE books (
  id        INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES authors(id),
  title     TEXT NOT NULL,
  sequel_to INTEGER REFERENCES books(id)
);
CREATE UNIQUE INDEX books_title ON books(title) WHERE author_id IS NOT NULL;
INSERT INTO authors (id, name) VALUES (1, 'Ursula'), (2, 'Gene');
INSERT INTO books (id, author_id, title) VALUES (1, 1, 'A Wizard'), (2, 1, 'The Tombs');
`;

/** The same, with two rows pointing at an author that does not exist. */
const ORPHAN_SQL = `CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE books (
  id        INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES authors(id),
  title     TEXT NOT NULL
);
INSERT INTO authors (id, name) VALUES (1, 'Ursula');
INSERT INTO books (id, author_id, title) VALUES (1, 1, 'A Wizard'), (2, 99, 'Orphan One'), (3, 98, 'Orphan Two');
`;

/**
 * A MULTI-FILE schema whose order is load-bearing: 01 references a table that
 * 00 creates, and 02 seeds it. Reversing the filenames must break the build —
 * that is what proves the ordering is the filename and not a dependency walk.
 */
const PARTS = path.join(FIX, "V-parts");
fs.mkdirSync(PARTS, { recursive: true });
fs.writeFileSync(path.join(PARTS, "00-base.sql"), `CREATE TABLE region (
  id    TEXT PRIMARY KEY,
  label TEXT NOT NULL
);
`);
fs.writeFileSync(path.join(PARTS, "01-child.sql"), `CREATE TABLE depot (
  id        INTEGER PRIMARY KEY,
  region_id TEXT NOT NULL REFERENCES region(id),
  name      TEXT NOT NULL
);
CREATE INDEX depot_by_region ON depot(region_id);
`);
fs.writeFileSync(path.join(PARTS, "02-seed.sql"), `INSERT INTO region (id, label) VALUES ('west', 'West'), ('east', 'East');
`);
fs.writeFileSync(path.join(PARTS, "notes.md"), "not sql; must be ignored\n");

const ordersDb = path.join(FIX, "orders.db");
const schemaSql = path.join(FIX, "SCHEMA_PROPOSED_tanks.sql");
const brokenSql = path.join(FIX, "broken.sql");
const dropDb = path.join(FIX, "dropped-by-hand.db");
const volumeDb = path.join(VOLUME, "data", "app.db");

buildOrdersDb(ordersDb);
fs.writeFileSync(schemaSql, SCHEMA_SQL);
fs.writeFileSync(brokenSql, "CREATE TABLE fine (a INTEGER);\nCREATE TABEL oops (b INTEGER);\n");
buildOrdersDb(dropDb);
buildOrdersDb(volumeDb);
// Give the mock volume a little more in it, so a snapshot is visibly not the same file.
{
  const db = new DatabaseSync(volumeDb);
  db.exec("CREATE TABLE prod_only (note TEXT)");
  db.prepare("INSERT INTO prod_only (note) VALUES (?)").run("this row exists only on the volume");
  db.close();
}

/**
 * A fake `flyctl` ON PATH.
 *
 * This exists so the REAL `--fly-mode real` branch is EXECUTED rather than
 * argued about: the `spawnSync`, the exit-code handling, the stderr quoting and
 * the arrival checks all run for real. The only thing it cannot cover is the
 * network call to Fly's own servers, and covering that would mean touching a
 * live app — which this run is not allowed to do.
 *
 * `FAKE_FLY_BEHAVIOUR` picks success / failure / a transfer that "succeeds" and
 * writes an error message into the file, which is the failure mode that would
 * otherwise put a row in the picker that is not a database.
 */
const SHIM = path.join(RUN, "bin");
fs.mkdirSync(SHIM, { recursive: true });
const FLY_SHIM = path.join(SHIM, "fly");
fs.writeFileSync(
  FLY_SHIM,
  `#!/bin/sh
if [ "$1" != "sftp" ] || [ "$2" != "get" ]; then
  echo "fake fly: unexpected invocation" >&2
  exit 64
fi
REMOTE="$3"; DEST="$4"; APP="$6"
case "$FAKE_FLY_BEHAVIOUR" in
  fail)
    echo "Error: Could not find App '$APP'" >&2
    exit 1
    ;;
  garbage)
    printf 'Error: no such volume\\n' > "$DEST"
    exit 0
    ;;
  *)
    cp "$FAKE_FLY_ROOT$REMOTE" "$DEST"
    ;;
esac
`,
);
fs.chmodSync(FLY_SHIM, 0o755);

const flyEnv = (behaviour) => ({
  ...process.env,
  PATH:                `${SHIM}:${process.env.PATH}`,
  FAKE_FLY_ROOT:       VOLUME,
  FAKE_FLY_BEHAVIOUR:  behaviour,
});

// -- server control -----------------------------------------------------------

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function start(args, { label = "server", env = process.env, workspace = WS } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ["--no-warnings", SERVER, "--port", String(port), "--workspace", workspace, ...args], {
    cwd: FIX,
    env,
  });
  const out = [];
  child.stdout.on("data", (chunk) => out.push(chunk.toString()));
  child.stderr.on("data", (chunk) => out.push(chunk.toString()));

  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`${label} exited ${child.exitCode}:\n${out.join("")}`);
    try {
      const response = await fetch(`${base}/api/dbs`);
      const body = await response.json();
      // Confirm the server that answered is OURS, by workspace. A derived port
      // range once had one run in eight talking to somebody else's dev server.
      if (body.workspace === path.resolve(workspace)) return { child, port, base, log: () => out.join("") };
    } catch {
      /* not up yet */
    }
    await sleep(50);
  }
  throw new Error(`${label} never came up:\n${out.join("")}`);
}

async function stop(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill("SIGTERM");
  for (let i = 0; i < 40 && server.child.exitCode === null; i++) await sleep(25);
  if (server.child.exitCode === null) server.child.kill("SIGKILL");
}

/**
 * Run the CLI to completion and report how it exited — the command-line receipts.
 *
 * `--workspace` is injected unless the caller set one. Without it, every
 * invocation that gets past argument parsing builds a Registry at the DEFAULT
 * workspace and creates `~/.sqlite-viewer/` on the machine running the suite —
 * a suite that litters the home directory of anyone who runs it, which is the
 * exact class of invisible side effect this tool is supposed to be against.
 */
function run(args, env = process.env) {
  const scoped = args.includes("--workspace") ? args : [...args, "--workspace", WS];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", SERVER, ...scoped], { cwd: FIX, env });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("exit", (code) => resolve({ code, out }));
  });
}

const get = async (base, route) => {
  const response = await fetch(base + route);
  return { status: response.status, headers: response.headers, body: await response.json().catch(() => ({})) };
};
const post = async (base, route, body) => {
  const response = await fetch(base + route, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

/**
 * Open a copy and decide whether it is a usable database: does it open, does
 * `quick_check` pass, and does its own COUNT(*) agree with the rows it can
 * actually read? The last one catches the specific way a torn copy lies —
 * a page count that no longer matches the pages present.
 */
function checkCopy(file) {
  try {
    const handle = new DatabaseSync(file, { readOnly: true });
    try {
      const check = String(Object.values(handle.prepare("PRAGMA quick_check").get())[0]);
      const counted = handle.prepare("SELECT COUNT(*) AS n FROM orders").get().n;
      const scanned = handle.prepare("SELECT COUNT(*) AS n FROM (SELECT id FROM orders)").get().n;
      return { ok: check === "ok", why: check, consistent: counted === scanned, rows: counted };
    } finally {
      handle.close();
    }
  } catch (error) {
    return { ok: false, why: error.message, consistent: false };
  }
}

const kindOf = (objects, table, column) =>
  objects.find((o) => o.name === table)?.columns.find((c) => c.name === column)?.kind ?? "(missing)";

// =============================================================================

let server;
try {
  say(`\nsqlite-viewer — receipts`);
  say(`run dir    ${RUN}`);
  say(`workspace  ${WS}`);
  say(`node       ${process.version}`);

  // ==========================================================================
  head("COMMAND LINE — nothing is guessed (v1's two rules, kept)");
  // ==========================================================================
  {
    const help = await run(["--help"]);
    ok("--help exits 0", help.code === 0, `exit ${help.code}`);

    const typo = await run(["--prot", "6060"]);
    ok("a typo'd flag exits 2, never a silent default", typo.code === 2, `exit ${typo.code} — ${typo.out.trim().split("\n")[0]}`);

    const badPort = await run([ordersDb, "--port", "banana"]);
    ok("a non-integer port is refused, not coerced", badPort.code === 2, badPort.out.trim().split("\n")[0]);

    const missing = await run([path.join(FIX, "no-such.db")]);
    ok("a missing database is a hard refusal, never a silent create", missing.code === 1, missing.out.trim().split("\n")[0]);

    const flyNoMode = await run(["--fly", "someapp:/data/x.db"]);
    ok("--fly without --fly-mode exits 2", flyNoMode.code === 2, flyNoMode.out.trim().split("\n")[0]);

    const notADb = path.join(FIX, "notes.db");
    fs.writeFileSync(notADb, "this is a text file wearing a .db extension\n");
    const refused = await run([notADb]);
    ok("a .db with no SQLite header is refused by name", refused.code === 1, refused.out.trim().split("\n")[0]);
  }

  // ==========================================================================
  head("STORY 1 — open a local db file");
  // ==========================================================================
  server = await start([ordersDb, "--schema", schemaSql, "--fly", "example-app:/data/app.db", "--fly-mode", "mock", "--fly-mock-root", VOLUME]);
  say(`  server     ${server.base}\n`);
  {
    const dbs = await get(server.base, "/api/dbs");
    show("registry", dbs.body.databases.map((d) => `${d.id}(${d.kind}/${d.status})`).join("  "));
    ok("orders.db is in the registry as a file", dbs.body.databases.some((d) => d.id === "orders" && d.kind === "file"));

    const schema = await get(server.base, "/api/schema?db=orders");
    const names = schema.body.objects.map((o) => o.name);
    show("objects", names.join(", "));
    // 4 tables + 1 view: customers, orders, we"ird, 顧客, order_totals.
    ok("every table and view is described", names.length === 5, `${names.length} objects`);
    ok('the hostile name `we"ird` did not crash the boot banner', names.includes('we"ird'));

    // The one idea, still working: created_at is a date and percent_at is not.
    show("created_at kind", kindOf(schema.body.objects, "orders", "created_at"));
    show("percent_at kind", kindOf(schema.body.objects, "orders", "percent_at"));
    show("profile kind", kindOf(schema.body.objects, "customers", "profile"));
    show("is_active kind", kindOf(schema.body.objects, "customers", "is_active"));
    show("receipt kind", kindOf(schema.body.objects, "orders", "receipt"));
    show("customer_id kind", kindOf(schema.body.objects, "orders", "customer_id"));
    ok("created_at → timestamp", kindOf(schema.body.objects, "orders", "created_at") === "timestamp");
    ok("percent_at → number (the trap holds)", kindOf(schema.body.objects, "orders", "percent_at") === "number");
    ok("profile → json", kindOf(schema.body.objects, "customers", "profile") === "json");
    ok("is_active → bool", kindOf(schema.body.objects, "customers", "is_active") === "bool");
    ok("receipt → blob", kindOf(schema.body.objects, "orders", "receipt") === "blob");

    const view = schema.body.objects.find((o) => o.name === "order_totals");
    show("view orders kind", view.columns.find((c) => c.name === "orders").kind);
    ok("a view's computed count is a number despite declaring no type",
       view.columns.find((c) => c.name === "orders").kind === "number");

    const rows = await get(server.base, "/api/rows/orders?db=orders&limit=3");
    show("first row", JSON.stringify(rows.body.rows[0]));
    ok("rows come back with a count from the same snapshot", rows.body.count === 25, `count=${rows.body.count}`);
    ok("an integer past 2^53 is a string, not a crash",
       rows.body.rows[0].snowflake === "9223372036854775807", String(rows.body.rows[0].snowflake));
    ok("a BLOB renders as hex, not {\"0\":114,…}", String(rows.body.rows[0].receipt).startsWith("x'"), String(rows.body.rows[0].receipt));

    const fk = rows.body.columns.find((c) => c.name === "customer_id");
    ok("the foreign key is reported for linking", fk.references?.table === "customers", JSON.stringify(fk.references));

    // Read-only, proven through the API on a real database.
    const drop = await post(server.base, "/api/query?db=orders", { sql: "DROP TABLE orders" });
    ok("DROP is refused with a sentence, at 200 not 400", drop.status === 200 && /Read-only/.test(drop.body.error), drop.body.error);
    const two = await post(server.base, "/api/query?db=orders", { sql: "SELECT 1; SELECT 2" });
    ok("a second statement is refused, not silently dropped", /One statement at a time/.test(two.body.error), two.body.error);
    const semi = await post(server.base, "/api/query?db=orders", { sql: "SELECT 'a;b' AS s" });
    ok("a ';' inside a string literal is read as data", semi.body.rows?.[0]?.s === "a;b", JSON.stringify(semi.body.rows));
    const pragmaSet = await post(server.base, "/api/query?db=orders", { sql: "PRAGMA busy_timeout = 0" });
    ok("a PRAGMA assignment is refused (it poisons the shared connection)", /refused/.test(pragmaSet.body.error), pragmaSet.body.error);
    const pragmaRead = await post(server.base, "/api/query?db=orders", { sql: "PRAGMA busy_timeout" });
    show("busy_timeout", JSON.stringify(pragmaRead.body.rows));
    ok("busy_timeout is really 5000, asserted through the API", pragmaRead.body.rows[0].timeout === 5000);
    const commented = await post(server.base, "/api/query?db=orders", { sql: "-- a note\nSELECT COUNT(*) AS n FROM orders" });
    ok("ordinary commented SQL runs", commented.body.rows?.[0]?.n === 25, JSON.stringify(commented.body.rows));
  }

  // ==========================================================================
  head("STORY 2 — open a schema with no db behind it");
  // ==========================================================================
  {
    const schema = await get(server.base, "/api/schema?db=schema-proposed-tanks");
    const names = schema.body.objects.map((o) => o.name);
    show("built from", schema.body.entry.sourcePath);
    show("derived db", schema.body.entry.path);
    show("statements", String(schema.body.entry.statements));
    show("objects", names.join(", "));
    ok("the .sql became a browsable database", names.includes("tank_connections") && names.includes("deliveries"));
    ok("it is labelled ephemeral, not pretended to be a file", schema.body.entry.kind === "schema");
    ok("the data tables are empty, because nothing has ever written to them",
       schema.body.objects.filter((o) => o.name !== "delivery_kinds").every((o) => o.count === 0));
    ok("but seed INSERTs in the .sql really run — a lookup table arrives populated",
       schema.body.objects.find((o) => o.name === "delivery_kinds").count === 2,
       "so the UI must not claim 'no data has ever been written'");
    show("created_at kind", kindOf(schema.body.objects, "deliveries", "created_at"));
    show("is_rush kind", kindOf(schema.body.objects, "deliveries", "is_rush"));
    show("tank_id kind", kindOf(schema.body.objects, "deliveries", "tank_id"));
    ok("column kinds are inferred with no data at all (name + declared type)",
       kindOf(schema.body.objects, "deliveries", "tank_id") === "id" &&
       kindOf(schema.body.objects, "deliveries", "created_at") === "number",
       "created_at is `number` here — honest: with zero rows the epoch-range check cannot fire");

    const indexed = schema.body.objects.find((o) => o.name === "deliveries");
    show("partial index", indexed.indexes.map((i) => i.sql).join(" | "));
    ok("the partial index predicate survives verbatim", /WHERE is_rush = 1/.test(indexed.indexes[0].sql));

    // The v2 property v1 has no place for: edit the .sql, the console follows.
    fs.writeFileSync(schemaSql, SCHEMA_SQL + "\nCREATE TABLE routes (id INTEGER PRIMARY KEY, label TEXT);\n");
    await sleep(30);
    const after = await get(server.base, "/api/schema?db=schema-proposed-tanks");
    show("after editing .sql", after.body.objects.map((o) => o.name).join(", "));
    ok("editing the .sql rebuilds the ephemeral db — no restart",
       after.body.objects.some((o) => o.name === "routes"));
    ok("the rebuild is logged, not silent", /rebuilt from/.test(server.log()), (server.log().match(/.*rebuilt from.*/) ?? [""])[0].trim());

    // A schema that does not compile must say WHY, in SQLite's own words.
    const broken = await post(server.base, "/api/open/path", { path: brokenSql });
    show("broken.sql entry", `${broken.body.entry.id} buildError=${Boolean(broken.body.entry.buildError)}`);
    const brokenSchema = await get(server.base, `/api/schema?db=${broken.body.entry.id}`);
    show("the error", brokenSchema.body.error);
    ok("a schema that will not compile reports the SQLite error, at 503",
       brokenSchema.status === 503 && /TABEL|syntax/i.test(brokenSchema.body.error));
  }

  // ==========================================================================
  head("STORY 3 — drag-and-drop (the exact request the drop handler makes)");
  // ==========================================================================
  {
    const bytes = fs.readFileSync(dropDb);
    const response = await fetch(`${server.base}/api/open/upload`, {
      method:  "POST",
      headers: { "x-sql-filename": encodeURIComponent("dropped-by-hand.db"), "content-type": "application/octet-stream" },
      body:    bytes,
    });
    const data = await response.json();
    show("POST /api/open/upload", `${bytes.length} bytes → ${JSON.stringify({ id: data.entry.id, kind: data.entry.kind })}`);
    show("stored at", data.entry.path);
    ok("dropping a .db registers it and returns its id", data.entry.kind === "upload" && data.entry.id === "dropped-by-hand");
    ok("the bytes are kept in the workspace, so the id outlives the page",
       fs.existsSync(data.entry.path) && data.entry.path.startsWith(path.resolve(WS)));

    const browsable = await get(server.base, `/api/rows/orders?db=${data.entry.id}&limit=1`);
    ok("the dropped database is immediately browsable", browsable.body.count === 25, `count=${browsable.body.count}`);

    // A dropped .sql takes the story-2 path, which is the point of accepting both.
    const sqlUpload = await fetch(`${server.base}/api/open/upload`, {
      method:  "POST",
      headers: { "x-sql-filename": encodeURIComponent("dropped-schema.sql") },
      body:    "CREATE TABLE dropped_thing (id INTEGER PRIMARY KEY, created_at INTEGER);",
    });
    const sqlEntry = (await sqlUpload.json()).entry;
    show("dropped .sql", `${sqlEntry.id} (${sqlEntry.kind}) ← ${sqlEntry.sourcePath}`);
    ok("dropping a .sql builds an ephemeral database from it", sqlEntry.kind === "schema");

    // Refusals, by name, rather than a row in the picker that cannot be opened.
    const garbage = await fetch(`${server.base}/api/open/upload`, {
      method:  "POST",
      headers: { "x-sql-filename": encodeURIComponent("not-really.db") },
      body:    "just some text",
    });
    const garbageBody = await garbage.json();
    show("refusal", garbageBody.error);
    ok("a .db with no SQLite header is refused, not registered", /not a SQLite database/.test(garbageBody.error));

    const mislabelled = await fetch(`${server.base}/api/open/upload`, {
      method:  "POST",
      headers: { "x-sql-filename": encodeURIComponent("secretly.sql") },
      body:    fs.readFileSync(dropDb),
    });
    const mislabelledBody = await mislabelled.json();
    show("refusal", mislabelledBody.error);
    ok("a .sql that is really a database is refused", /named .sql but its bytes are a SQLite database/.test(mislabelledBody.error));

    const wrongKind = await fetch(`${server.base}/api/open/upload`, {
      method:  "POST",
      headers: { "x-sql-filename": encodeURIComponent("notes.txt") },
      body:    "hello",
    });
    ok("an unknown extension is refused with what to drop instead", /drop a .db/.test((await wrongKind.json()).error));
  }

  // ==========================================================================
  head("STORY 5 — inspect prod: a snapshot off a Fly volume (MOCK mode)");
  // ==========================================================================
  {
    const dbs = await get(server.base, "/api/dbs");
    const snap = dbs.body.databases.find((d) => d.kind === "snapshot");
    show("id", snap.id);
    show("command", snap.fly.command);
    show("mode", snap.fly.mode);
    show("taken", `${new Date(snap.snapshot.takenAt * 1000).toISOString()} · ${snap.snapshot.bytes} bytes · ${snap.snapshot.ms} ms`);
    show("quick_check", snap.snapshot.integrity);
    show("consistency", snap.snapshot.consistency);
    ok("the snapshot exists and is labelled a snapshot", snap.kind === "snapshot");
    ok("it records the exact command that produced it", /MOCK cp .*stands in for: fly sftp get/.test(snap.fly.command));
    ok("it was integrity-checked on arrival, not assumed good", snap.snapshot.integrity === "ok");
    ok("it never claims to be live", /point-in-time/.test(snap.snapshot.consistency));

    const schema = await get(server.base, `/api/schema?db=${snap.id}`);
    ok("it carries the volume's data, not the local file's",
       schema.body.objects.some((o) => o.name === "prod_only"));

    // A snapshot is a moment. Prove it does NOT follow the source, and that
    // re-taking is the only thing that moves it.
    const volume = new DatabaseSync(volumeDb);
    volume.prepare("INSERT INTO prod_only (note) VALUES (?)").run("written to the volume AFTER the snapshot");
    volume.close();
    await sleep(30);
    const still = await get(server.base, `/api/rows/prod_only?db=${snap.id}`);
    show("rows after volume write", String(still.body.count));
    ok("writing to the volume does NOT change the snapshot", still.body.count === 1);

    const retaken = await post(server.base, `/api/snapshot/${snap.id}/retake`);
    const afterRetake = await get(server.base, `/api/rows/prod_only?db=${snap.id}`);
    show("rows after re-take", String(afterRetake.body.count));
    show("re-take quick_check", retaken.body.entry.snapshot.integrity);
    ok("re-taking it picks the new row up", afterRetake.body.count === 2);

    // The real path is reachable but was NOT run: no live Fly app was touched.
    const realMode = await run(["--fly", "example-app:/data/x.db", "--fly-mode", "real", "--fly-mock-root", VOLUME]);
    ok("real mode refuses to also carry a mock root (half-meaning both)", realMode.code === 2, realMode.out.trim().split("\n")[0]);
    // Every mention of `fly sftp get` anywhere in this server's log must be the
    // MOCK line quoting what it stands in for. One that is not would mean a real
    // transfer was attempted, which this run is not allowed to do.
    const flyLines = server.log().split("\n").filter((line) => /fly sftp get/.test(line));
    ok("no live Fly app was contacted — every `fly sftp get` in the log is a MOCK stand-in",
       flyLines.length > 0 && flyLines.every((line) => /MOCK cp/.test(line)),
       `${flyLines.length} matching log lines, all of them MOCK`);
  }

  // ==========================================================================
  head("STORY 5b — the REAL --fly-mode branch, EXECUTED against a fake flyctl on PATH");
  // ==========================================================================
  // Everything in lib/fly.js's real path runs here: spawnSync, the exit code
  // check, the stderr quoting, the header check and the integrity check. What
  // is NOT covered is the network call to Fly's servers, which cannot be
  // covered without touching a live app. Nothing below contacts Fly.
  {
    const WS_REAL = path.join(RUN, "workspace-real");
    let realServer;
    try {
      realServer = await start(["--fly", "example-app:/data/app.db", "--fly-mode", "real"], {
        label:     "real-mode server",
        env:       flyEnv("ok"),
        workspace: WS_REAL,
      });
      const dbs = await get(realServer.base, "/api/dbs");
      const snap = dbs.body.databases.find((d) => d.kind === "snapshot");
      show("command", snap.fly.command);
      show("mode", snap.fly.mode);
      show("bytes / quick_check", `${snap.snapshot.bytes} · ${snap.snapshot.integrity}`);
      ok("the real branch runs `fly sftp get` for real (no MOCK anywhere in it)",
         snap.fly.command === `fly sftp get /data/app.db ${path.join(WS_REAL, "snapshots", `${snap.id}.db`)} -a example-app` &&
           !/MOCK/.test(snap.fly.command));
      ok("the file it fetched is a real database, integrity-checked on arrival", snap.snapshot.integrity === "ok");
      const rows = await get(realServer.base, `/api/rows/prod_only?db=${snap.id}`);
      ok("and it is browsable end to end through the real path", rows.status === 200, `count=${rows.body.count}`);
    } finally {
      await stop(realServer);
    }

    // `fly` exits non-zero: the message the CLI printed must reach the operator.
    const failed = await run(["--fly", "example-app:/data/app.db", "--fly-mode", "real", "--workspace", path.join(RUN, "ws-fail")],
                             flyEnv("fail"));
    show("fly exits 1", failed.out.trim().split("\n").filter(Boolean).pop());
    ok("a failing `fly` exits 1 and quotes what fly actually said",
       failed.code === 1 && /Could not find App 'example-app'/.test(failed.out));

    // The nastiest one: `fly` exits 0 and writes an error message INTO the file.
    const garbage = await run(["--fly", "example-app:/data/app.db", "--fly-mode", "real", "--workspace", path.join(RUN, "ws-garbage")],
                              flyEnv("garbage"));
    show("fly exits 0, writes text", garbage.out.trim().split("\n").filter(Boolean).pop());
    ok("a transfer that 'succeeds' but delivers text is refused, not registered",
       garbage.code === 1 && /not a SQLite database/.test(garbage.out));
    ok("and the non-database it wrote is deleted rather than left in the workspace",
       !fs.existsSync(path.join(RUN, "ws-garbage", "snapshots")) ||
         fs.readdirSync(path.join(RUN, "ws-garbage", "snapshots")).length === 0);

    // No flyctl installed at all.
    const missing = await run(["--fly", "example-app:/data/app.db", "--fly-mode", "real", "--workspace", path.join(RUN, "ws-nofly")],
                              { ...process.env, PATH: "/var/empty" });
    show("no flyctl on PATH", missing.out.trim().split("\n").filter(Boolean).pop());
    ok("a missing `fly` binary is a sentence, not a stack trace",
       missing.code === 1 && /could not run `fly`/.test(missing.out));
  }

  // ==========================================================================
  head("STORY 6 — many databases, one console, one process, one port");
  // ==========================================================================
  {
    const dbs = await get(server.base, "/api/dbs");
    say("");
    for (const d of dbs.body.databases) {
      say(`    ${d.id.padEnd(24)} ${d.kind.padEnd(9)} ${d.status.padEnd(6)} ${d.kind === "schema" ? d.sourcePath : d.path}`);
    }
    say("");
    show("workspace", dbs.body.workspace);
    show("default", dbs.body.default);
    ok("every way in is one list", dbs.body.databases.length >= 5, `${dbs.body.databases.length} databases`);
    ok("all four kinds are represented",
       new Set(dbs.body.databases.map((d) => d.kind)).size >= 4,
       [...new Set(dbs.body.databases.map((d) => d.kind))].join(", "));

    // Switching is a query parameter, not a process.
    const a = await get(server.base, "/api/schema?db=orders");
    const b = await get(server.base, "/api/schema?db=schema-proposed-tanks");
    ok("two different databases answer on the SAME port in the same process",
       a.body.objects[0].name !== b.body.objects[0].name,
       `${a.body.database} vs ${b.body.database}`);

    const unknown = await get(server.base, "/api/schema?db=never-heard-of-it");
    show("404 body", JSON.stringify(unknown.body).slice(0, 160));
    ok("an unknown id 404s and lists what DOES exist", unknown.status === 404 && Array.isArray(unknown.body.knownIds));
  }

  // ==========================================================================
  head("STORY 7 — download a CONSISTENT copy (SQLite online backup API)");
  // ==========================================================================
  {
    const response = await fetch(`${server.base}/api/download/orders`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const saved = path.join(RUN, "downloaded-orders.db");
    fs.writeFileSync(saved, bytes);

    show("content-type", response.headers.get("content-type"));
    show("content-disposition", response.headers.get("content-disposition"));
    show("x-sql-copy", response.headers.get("x-sql-copy"));
    show("x-sql-pages", response.headers.get("x-sql-pages"));
    show("bytes", String(bytes.length));
    ok("the response says HOW the copy was taken", response.headers.get("x-sql-copy") === "sqlite-online-backup");
    ok("it downloads as a file, named after the id", /attachment; filename="orders.db"/.test(response.headers.get("content-disposition")));

    const copy = new DatabaseSync(saved, { readOnly: true });
    const count = copy.prepare("SELECT COUNT(*) AS n FROM orders").get().n;
    const check = copy.prepare("PRAGMA quick_check").get();
    copy.close();
    show("copy quick_check", String(Object.values(check)[0]));
    show("copy rows", String(count));
    ok("the downloaded file opens as a database", Object.values(check)[0] === "ok");
    ok("it carries the same rows as the source", count === 25);

    // The temp copy is swept: an outbox that fills up is a disk that fills up.
    const outbox = fs.readdirSync(path.join(WS, "outbox"));
    show("outbox after download", outbox.length ? outbox.join(", ") : "(empty)");
    ok("the server's temp copy is deleted once the bytes are on the wire", outbox.length === 0);
  }

  // ==========================================================================
  head("STORY 7b — the same download, taken WHILE another process writes");
  // ==========================================================================
  // The whole argument for using backup() instead of fs.copyFile is what happens
  // when the source is hot. `node:sqlite` is synchronous, so this cannot be
  // demonstrated inside one process — it needs a real second process committing
  // to the same file while the downloads are taken.
  {
    const WRITER = `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = DELETE");
      const insert = db.prepare(
        "INSERT INTO orders (customer_id, cents, percent_at, snowflake, receipt, created_at) VALUES (1,?,22,1,NULL,1785524191)");
      const until = Date.now() + Number(process.argv[2]);
      let n = 0;
      while (Date.now() < until) {
        db.exec("BEGIN IMMEDIATE");
        for (let i = 0; i < 200; i++) insert.run(n++);
        db.exec("COMMIT");
      }
      db.close();
      console.log(n);
    `;
    // Its OWN database. The writer below adds a million rows, and running that
    // against the shared fixture broke three later assertions that (rightly)
    // expect `orders` to hold 25 — a test that damages the fixtures it shares
    // is a test that fails somebody else's assertion.
    const hotDb = path.join(FIX, "hot.db");
    buildOrdersDb(hotDb);
    const hot = (await post(server.base, "/api/open/path", { path: hotDb })).body.entry.id;

    const writer = spawn(process.execPath, ["--no-warnings", "-e", WRITER, hotDb, "2000"], { env: process.env });
    let written = "";
    writer.stdout.on("data", (chunk) => (written += chunk));

    const before = (await get(server.base, `/api/rows/orders?db=${hot}&limit=1`)).body.count;

    const backups = [];
    const rawCopies = [];
    const deadline = Date.now() + 1800;
    while (Date.now() < deadline) {
      // The tool's own path: GET /api/download, which takes the copy with backup().
      try {
        const response = await fetch(`${server.base}/api/download/${hot}`);
        if (!response.ok) {
          backups.push({ ok: false, why: `HTTP ${response.status} ${JSON.stringify(await response.json().catch(() => ({})))}` });
        } else {
          const file = path.join(RUN, `hot-backup-${backups.length}.db`);
          fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
          backups.push(checkCopy(file));
        }
      } catch (error) {
        backups.push({ ok: false, why: error.message });
      }

      // The naive alternative, taken in the same window, for comparison. This is
      // EVIDENCE, not an assertion: a byte copy of a hot database is allowed to
      // come out fine, and often does. What it is not allowed to do is be the
      // mechanism we ship.
      const raw = path.join(RUN, `hot-raw-${rawCopies.length}.db`);
      try {
        fs.copyFileSync(hotDb, raw);
        rawCopies.push(checkCopy(raw));
      } catch (error) {
        rawCopies.push({ ok: false, why: error.message });
      }
      await sleep(40);
    }

    await new Promise((resolve) => writer.on("exit", resolve));
    const after = (await get(server.base, `/api/rows/orders?db=${hot}&limit=1`)).body.count;

    const goodBackups = backups.filter((b) => b.ok).length;
    const badBackups = backups.filter((b) => !b.ok);
    const badRaw = rawCopies.filter((c) => !c.ok);

    show("rows written meanwhile", written.trim());
    // Row count, not `PRAGMA data_version`: the server reopens its handle every
    // time the file's size/mtime move, and a fresh connection's data_version
    // starts over at 1 — so it is not a witness to writes across a reopen.
    show("source rows", `${before.toLocaleString()} → ${after.toLocaleString()}`);
    show("backup() copies", `${goodBackups}/${backups.length} opened and passed quick_check`);
    show("raw fs.copyFile copies", `${rawCopies.length - badRaw.length}/${rawCopies.length} opened and passed quick_check`);
    if (badBackups.length) show("backup failures", badBackups.map((b) => b.why).join(" | ").slice(0, 300));
    if (badRaw.length) show("raw failures", badRaw.map((c) => c.why).join(" | ").slice(0, 300));

    ok("the writer really was committing during the window", after > before, `${after - before} rows appeared`);
    ok("the downloads really did overlap the writer", backups.length >= 3, `${backups.length} downloads taken`);
    ok("EVERY copy taken through /api/download opens and passes quick_check",
       backups.length > 0 && badBackups.length === 0,
       `${goodBackups}/${backups.length}`);
    ok("every downloaded copy is internally consistent (count matches its own rows)",
       backups.filter((b) => b.ok).every((b) => b.consistent));
    ok("the copies caught the database at DIFFERENT moments — they are real snapshots, not one cached file",
       new Set(backups.filter((b) => b.ok).map((b) => b.rows)).size > 1,
       `distinct row counts: ${[...new Set(backups.filter((b) => b.ok).map((b) => b.rows))].join(", ")}`);

    // The regression guard for the hang that found this. With backup()'s DEFAULT
    // rate this loop never completed at all: SQLite restarts the copy from page 1
    // on every concurrent write, so 100 pages a step never converges. See
    // lib/db.js ONE_STEP.
    ok("no download hung — the one-step backup rate is what makes this terminate",
       backups.length > 0 && backups.every((b) => b.why !== "TIMED OUT"));
    show("regression guarded", "lib/db.js ONE_STEP — the default rate produced nothing in 6 s here");
  }

  // ==========================================================================
  head("STORY 8 — clone, and browse the clone");
  // ==========================================================================
  {
    const before = fs.statSync(ordersDb);
    const cloned = await post(server.base, "/api/clone/orders");
    const entry = cloned.body.entry;
    show("id", entry.id);
    show("path", entry.path);
    show("pages / bytes", `${entry.clone.pages} pages · ${entry.clone.bytes} bytes`);
    show("quick_check", entry.clone.integrity);
    ok("the clone is a new registry entry", entry.kind === "clone" && entry.clone.of === "orders");
    ok("it is a real, valid database", entry.clone.integrity === "ok");

    const dbs = await get(server.base, "/api/dbs");
    ok("the picker gains the clone", dbs.body.databases.some((d) => d.id === entry.id));

    const rows = await get(server.base, `/api/rows/orders?db=${entry.id}&limit=2`);
    ok("switching to the clone browses the clone", rows.body.count === 25, `count=${rows.body.count}`);

    const after = fs.statSync(ordersDb);
    show("source mtime", `${Math.round(before.mtimeMs)} → ${Math.round(after.mtimeMs)}`);
    show("source size", `${before.size} → ${after.size}`);
    ok("cloning did not write to the source", before.size === after.size && Math.round(before.mtimeMs) === Math.round(after.mtimeMs));

    // Two clones must not collide on an id or a filename.
    const second = await post(server.base, "/api/clone/orders");
    show("second clone", second.body.entry.id);
    ok("a second clone gets its own id", second.body.entry.id !== entry.id);
  }

  // ==========================================================================
  head("STORY 4 — reopen by URL, across a restart, and the honest 410");
  // ==========================================================================
  {
    const beforeIds = (await get(server.base, "/api/dbs")).body.databases.map((d) => d.id);
    show("ids before restart", beforeIds.join(", "));

    await stop(server);
    // Restart with NO arguments at all — only the workspace. Everything below
    // has to come back from the manifest or story 4 is a lie.
    server = await start([], { label: "restarted server" });
    say(`  restarted  ${server.base} (no database arguments — registry only)\n`);

    const afterIds = (await get(server.base, "/api/dbs")).body.databases.map((d) => d.id);
    show("ids after restart", afterIds.join(", "));
    ok("every id survived the restart", beforeIds.every((id) => afterIds.includes(id)));
    ok("the manifest is named in the log", /registry: \d+ databases? remembered/.test(server.log()),
       (server.log().match(/.*remembered.*/) ?? [""])[0].trim());

    const reopened = await get(server.base, "/api/rows/orders?db=orders&limit=1");
    ok("?db=orders still opens the same file after a restart", reopened.body.count === 25);

    const dropped = await get(server.base, "/api/schema?db=dropped-by-hand");
    ok("?db= for a DROPPED file still opens after a restart", dropped.status === 200,
       "the bytes were kept in the workspace, so the id did not die with the page");

    const ephemeral = await get(server.base, "/api/schema?db=schema-proposed-tanks");
    ok("?db= for an EPHEMERAL schema still opens after a restart", ephemeral.status === 200,
       "the .sql is the source of truth; the derived db is rebuilt on demand");

    // Now the honest failure. Delete the file behind a registered id.
    const entry = (await get(server.base, "/api/dbs")).body.databases.find((d) => d.id === "dropped-by-hand");
    fs.rmSync(entry.path, { force: true });
    const gone = await get(server.base, "/api/schema?db=dropped-by-hand");
    say("");
    show("status", String(gone.status));
    show("body", JSON.stringify(gone.body));
    ok("a bookmark whose file is gone answers 410, not a blank page", gone.status === 410);
    ok("the 410 names the missing path", gone.body.path === entry.path);
    ok("the 410 says when it was opened", typeof gone.body.openedAt === "number");
    ok("the 410 says what kind of database it was", gone.body.kind === "upload");
    ok("it does NOT silently fall back to another database", gone.body.id === "dropped-by-hand");

    const list = await get(server.base, "/api/dbs");
    const row = list.body.databases.find((d) => d.id === "dropped-by-hand");
    show("picker row", `${row.id} ${row.kind} ${row.status} — ${row.detail}`);
    ok("the picker shows it as gone rather than dropping it silently", row.status === "gone");

    // Deleting the .sql behind an ephemeral leaves the build, labelled stale.
    fs.rmSync(schemaSql, { force: true });
    const stale = (await get(server.base, "/api/dbs")).body.databases.find((d) => d.id === "schema-proposed-tanks");
    show("ephemeral without its .sql", `${stale.status} — ${stale.detail}`);
    ok("losing the .sql marks the ephemeral stale, not gone (the build is still readable)", stale.status === "stale");

    // Forgetting is a registry operation, never a delete.
    const forgot = await fetch(`${server.base}/api/db/dropped-by-hand`, { method: "DELETE" });
    const forgotBody = await forgot.json();
    show("DELETE /api/db/…", JSON.stringify(forgotBody));
    ok("forgetting removes the row and names where the file was", forgotBody.forgot === "dropped-by-hand");
    ok("forgetting is logged", /forgot dropped-by-hand/.test(server.log()));
  }

  // ==========================================================================
  head("FRESHNESS — the ghost inode, per database");
  // ==========================================================================
  {
    await get(server.base, "/api/version?db=orders");
    const v1 = (await get(server.base, "/api/version?db=orders")).body;
    show("version token", `${v1.generation}:${v1.dataVersion}:${v1.schemaVersion}`);

    // An ordinary write by somebody else.
    const writer = new DatabaseSync(ordersDb);
    writer.prepare("INSERT INTO orders (customer_id, cents, percent_at, snowflake, receipt, created_at) VALUES (1,1,22,1,NULL,?)").run(NOW);
    writer.close();
    const afterWrite = await get(server.base, "/api/rows/orders?db=orders&limit=1");
    ok("an INSERT from another process shows up on the next request", afterWrite.body.count === 26, `count=${afterWrite.body.count}`);

    // `rm` + rebuild — the trap this whole mechanism exists for.
    fs.rmSync(ordersDb);
    buildOrdersDb(ordersDb);
    const afterRebuild = await get(server.base, "/api/rows/orders?db=orders&limit=1");
    ok("rm + rebuild is noticed (no ghost inode)", afterRebuild.body.count === 25, `count=${afterRebuild.body.count}`);
    ok("the reopen is logged with the identity that changed", /orders: REPLACED/.test(server.log()),
       (server.log().match(/.*orders: REPLACED.*/) ?? [""])[0].trim().slice(0, 120));

    // `cp other.db the.db` — same inode, different contents. v1 found this by
    // testing rather than reasoning; the size+mtime half of the identity is why.
    const other = path.join(FIX, "other.db");
    fs.rmSync(other, { force: true });
    const small = new DatabaseSync(other);
    small.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY)");
    small.close();
    fs.copyFileSync(other, ordersDb);
    const afterCopy = await get(server.base, "/api/rows/orders?db=orders&limit=1");
    ok("cp over the file is noticed too (content identity, not just inode)", afterCopy.body.count === 0, `count=${afterCopy.body.count}`);

    // Deleted and left deleted: 410 naming the path, never stale rows.
    fs.rmSync(ordersDb);
    const deleted = await get(server.base, "/api/rows/orders?db=orders&limit=1");
    show("deleted mid-session", `${deleted.status} ${deleted.body.error}`);
    ok("a database deleted under a running server answers 410, never stale rows", deleted.status === 410);
    ok("the deletion is logged", /orders: DELETED/.test(server.log()));

    buildOrdersDb(ordersDb);
    const recovered = await get(server.base, "/api/rows/orders?db=orders&limit=1");
    ok("putting a real database back recovers with no restart", recovered.body.count === 25);
  }

  // ==========================================================================
  head("HARDENING — the poisoned keep-alive, still fixed");
  // ==========================================================================
  {
    // v1's nastiest bug: answering 413 without finishing the body left unread
    // bytes in the socket, and keep-alive handed that socket to a LATER request,
    // which hung forever. The FIRST request after succeeds and the SECOND hangs,
    // so this does two.
    const huge = "x".repeat(200_000);
    const rejected = await fetch(`${server.base}/api/query?db=orders`, { method: "POST", body: JSON.stringify({ sql: huge }) });
    show("oversized body", `${rejected.status} ${JSON.stringify(await rejected.json())}`);
    ok("an oversized body is refused with 413", rejected.status === 413);

    const first = await get(server.base, "/api/rows/orders?db=orders&limit=1");
    const second = await get(server.base, "/api/rows/orders?db=orders&limit=1");
    ok("the request after the refusal succeeds", first.status === 200);
    ok("and so does the one after THAT (the keep-alive is not poisoned)", second.status === 200);
  }

  // ==========================================================================
  head("v3 · GESTURE 1 — paste SQL, and it just works");
  // ==========================================================================
  {
    const pasted = await post(server.base, "/api/open/paste", { sql: PASTE_SQL, label: "library" });
    show("id", pasted.body.entry?.id ?? "(none)");
    ok("a paste becomes a registered database", pasted.status === 200 && pasted.body.entry?.kind === "schema");
    ok("its statements were counted", pasted.body.entry?.statements === 5, `${pasted.body.entry?.statements} statements`);

    const id = pasted.body.entry.id;
    // The text is written to a REAL .sql in the workspace, which is what makes
    // ?db= bookmarkable and rebuild-on-change work. It is not held in memory.
    ok("the pasted text is a real file in the workspace", fs.existsSync(pasted.body.entry.sourcePath),
       pasted.body.entry.sourcePath);

    const schema = await get(server.base, `/api/schema?db=${id}`);
    const names = schema.body.objects.map((o) => o.name).join(", ");
    show("objects", names);
    ok("the pasted schema is browsable immediately", schema.status === 200 && names === "authors, books");

    const empty = await post(server.base, "/api/open/paste", { sql: "   \n  " });
    ok("an empty paste is refused, not registered as an empty database", empty.body.error?.includes("empty"),
       empty.body.error);

    const bytes = await post(server.base, "/api/open/paste", { sql: "SQLite format 3 rest of a db" });
    ok("bytes of a database pasted as text are refused by name", /not SQL text/.test(bytes.body.error ?? ""),
       bytes.body.error);

    // THE CENTRAL CLAIM: no parser. SQLite decides, and its refusal is the answer.
    const broken = await post(server.base, "/api/open/paste", { sql: "CREATE TABLE fine (a INTEGER);\nCREATE TABEL oops (b INTEGER);" });
    ok("SQL that SQLite rejects is registered with the ENGINE'S error, never a guessed drawing",
       Boolean(broken.body.entry?.buildError) && /TABEL|syntax/i.test(broken.body.entry.buildError),
       broken.body.entry?.buildError);
    const refused = await get(server.base, `/api/schema?db=${broken.body.entry.id}`);
    ok("and reading it answers 503 with that same message, not an empty schema",
       refused.status === 503 && /TABEL|syntax/i.test(refused.body.error), `${refused.status} — ${refused.body.error}`);
  }

  // ==========================================================================
  head("v3 · GESTURE 2 — a schema is a DIRECTORY of .sql, in filename order");
  // ==========================================================================
  {
    // A real multi-file schema is several files and no earlier version could open
    // it: both took a single path. This is that requirement, on a fixture whose
    // ordering is load-bearing — 01 references a table 00 creates.
    const opened = await post(server.base, "/api/open/path", { path: PARTS });
    const id = opened.body.entry?.id;
    show("files, in order", (opened.body.entry?.sourceFiles ?? []).map((f) => path.basename(f)).join(" → "));
    ok("a DIRECTORY of .sql opens as one schema", opened.status === 200 && opened.body.entry?.sourceKind === "directory");
    ok("the files are applied in FILENAME order, and it is recorded",
       (opened.body.entry.sourceFiles ?? []).map((f) => path.basename(f)).join(",") === "00-base.sql,01-child.sql,02-seed.sql");
    ok("it built, which only happens if 00 ran before 01", !opened.body.entry.buildError, opened.body.entry.buildError ?? "no error");

    const schema = await get(server.base, `/api/schema?db=${id}`);
    show("objects", schema.body.objects.map((o) => `${o.name}(${o.count})`).join(", "));
    ok("every file's tables are present", schema.body.objects.length === 2);
    ok("and the seed file's rows are in them", schema.body.objects.find((o) => o.name === "region")?.count === 2);

    // WHAT DOES AND DOES NOT DEPEND ON THE ORDER — worth knowing before you
    // renumber a schema directory.
    //
    // A FOREIGN KEY is resolved LAZILY by SQLite: `REFERENCES region(id)` in a
    // file applied before the one that creates `region` is accepted without
    // complaint. So a forward FK reference across files is legal and proves
    // nothing about ordering.
    const forward = path.join(RUN, "forward-fk");
    fs.mkdirSync(forward, { recursive: true });
    fs.writeFileSync(path.join(forward, "00-child.sql"), "CREATE TABLE depot (id INTEGER PRIMARY KEY, region_id TEXT NOT NULL REFERENCES region(id));\n");
    fs.writeFileSync(path.join(forward, "01-base.sql"), fs.readFileSync(path.join(PARTS, "00-base.sql")));
    const lazy = await post(server.base, "/api/open/path", { path: forward });
    ok("a FOREIGN KEY pointing at a table a LATER file creates is legal — SQLite resolves them lazily",
       !lazy.body.entry?.buildError, lazy.body.entry?.buildError ?? "built");

    // What genuinely depends on the order is anything SQLite resolves at
    // statement time: an INSERT, an index, a trigger. Seed the table before it
    // exists and the build fails, naming the file.
    const wrong = path.join(RUN, "wrong-order");
    fs.mkdirSync(wrong, { recursive: true });
    fs.writeFileSync(path.join(wrong, "00-seed.sql"), fs.readFileSync(path.join(PARTS, "02-seed.sql")));
    fs.writeFileSync(path.join(wrong, "01-base.sql"), fs.readFileSync(path.join(PARTS, "00-base.sql")));
    const backwards = await post(server.base, "/api/open/path", { path: wrong });
    ok("seeding a table before the file that creates it DOES break the build — the order is real",
       /no such table: region/.test(backwards.body.entry?.buildError ?? ""), backwards.body.entry?.buildError);
    ok("and the failure NAMES the file and its position in the sequence",
       /00-seed\.sql \(file 1 of 2\)/.test(backwards.body.entry?.buildError ?? ""), backwards.body.entry?.buildError);

    // A file ADDED to the directory changes no existing file's mtime. A stamp
    // over the remembered list would never notice it.
    fs.writeFileSync(path.join(PARTS, "03-late.sql"), "CREATE TABLE arrived_late (id INTEGER PRIMARY KEY);\n");
    const after = await get(server.base, `/api/schema?db=${id}`);
    ok("a file ADDED to the directory is picked up on the next read",
       after.body.objects.some((o) => o.name === "arrived_late"),
       after.body.objects.map((o) => o.name).join(", "));

    const bare = path.join(RUN, "no-sql-here");
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(path.join(bare, "notes.md"), "# not sql\n");
    const nothing = await post(server.base, "/api/open/path", { path: bare });
    ok("a directory with no .sql is refused rather than opened as an empty database",
       /no \.sql files/.test(nothing.body.error ?? ""), nothing.body.error);

    const positional = await run([PARTS]);
    ok("a directory passed as a DATABASE exits 1 and points at --schema",
       positional.code === 1 && /--schema/.test(positional.out), positional.out.trim().split("\n")[0]);
  }

  // ==========================================================================
  head("v3 · GESTURE 2, dropped — a folder arrives as bytes and is rebuilt");
  // ==========================================================================
  {
    // A browser cannot hand over a path, only bytes, so a dropped folder is a
    // list of {name, text}. Deliberately POSTED OUT OF ORDER: the ordering must
    // come from the filenames, not from the order the browser read them in.
    const dropped = await post(server.base, "/api/open/bundle", {
      name:  "V-dropped",
      files: [
        { name: "01-child.sql", text: fs.readFileSync(path.join(PARTS, "01-child.sql"), "utf8") },
        { name: "00-base.sql",  text: fs.readFileSync(path.join(PARTS, "00-base.sql"), "utf8") },
      ],
    });
    ok("a dropped FOLDER builds, even though the files arrived out of order",
       dropped.status === 200 && !dropped.body.entry?.buildError, dropped.body.entry?.buildError ?? "built");
    ok("the rebuilt directory is applied in filename order",
       (dropped.body.entry.sourceFiles ?? []).map((f) => path.basename(f)).join(",") === "00-base.sql,01-child.sql");

    const escape = await post(server.base, "/api/open/bundle", {
      name:  "../../escape",
      files: [{ name: "../../../evil.sql", text: "CREATE TABLE evil (a INTEGER);" }],
    });
    const landed = escape.body.entry?.sourceFiles ?? [];
    ok("a dropped name that tries to climb out of the workspace is flattened to its basename",
       landed.every((f) => f.startsWith(path.resolve(WS))), landed.join(", "));

    const nothing = await post(server.base, "/api/open/bundle", { name: "empty-folder", files: [] });
    ok("an empty folder is refused", /no \.sql files/.test(nothing.body.error ?? ""), nothing.body.error);
  }

  // ==========================================================================
  head("v3 · THE MAP IS DRAWN FROM PRAGMA — /api/schema already IS the graph");
  // ==========================================================================
  {
    const schema = await get(server.base, "/api/schema?db=orders");
    const orders = schema.body.objects.find((o) => o.name === "orders");

    // This is the whole reason the 400-line text parser was deleted rather than
    // ported: the engine's own catalog cannot disagree with the database.
    const fk = orders.columns.find((c) => c.name === "customer_id");
    ok("every edge the map draws comes from PRAGMA foreign_key_list",
       fk.references?.table === "customers" && fk.references?.to === "id",
       `orders.customer_id → ${fk.references?.table}.${fk.references?.to}`);

    ok("row counts are on every node — the thing no parser can ever have", orders.count === 25, `${orders.count} rows`);

    const partial = orders.indexes.find((i) => i.name === "orders_open");
    show("partial index", `${partial?.unique ? "unique" : "index"} (${partial?.columns.join(",")}) WHERE ${partial?.where}`);
    ok("an index carries its columns from PRAGMA index_info", partial?.columns.join(",") === "customer_id");
    ok("and its partial WHERE predicate, which lives only in the stored SQL", partial?.where === "cents > 0");

    // A UNIQUE constraint builds a real index with NO CREATE statement of its
    // own. sqlite_master alone cannot see it; the text parser had to guess it.
    const tanks = await get(server.base, "/api/schema?db=schema-proposed-tanks");
    const connections = tanks.body.objects.find((o) => o.name === "tank_connections");
    const implied = connections.indexes.find((i) => i.origin === "constraint");
    ok("a UNIQUE CONSTRAINT index is found even though it has no CREATE INDEX",
       Boolean(implied) && implied.unique && implied.columns.join(",") === "serial",
       implied ? `${implied.name} unique (${implied.columns.join(",")})` : "(not found)");
    ok("and it is marked as coming from a constraint, not from a CREATE", implied?.sql === null);

    // A lookup table's rows ARE its schema. These are real rows, not INSERTs
    // scraped out of a .sql file.
    const kinds = tanks.body.objects.find((o) => o.name === "delivery_kinds");
    ok("a small text-keyed lookup table reports its actual keys",
       kinds.keys?.join(",") === "rush,standard", `keys: ${kinds.keys?.join(", ")}`);
    ok("a large table reports none — this can never become a data dump", orders.keys?.length === 0);
  }

  // ==========================================================================
  head("v3 · INTEGRITY — foreign_key_check, on the edge it broke");
  // ==========================================================================
  {
    const clean = await get(server.base, "/api/fkcheck?db=orders");
    ok("a database with no orphans reports none", clean.status === 200 && clean.body.violations.length === 0);

    // FOREIGN KEYS ARE NOT ENFORCED DURING A BUILD, on purpose. node:sqlite
    // turns them on by default, and with them on this paste does not build at
    // all — the tool that exists to SHOW a broken reference would refuse to
    // show anything. Off, the orphan survives and gets drawn in red.
    const built = await post(server.base, "/api/open/paste", { sql: ORPHAN_SQL, label: "orphans" });
    ok("a schema whose seed data violates an FK still BUILDS", !built.body.entry?.buildError,
       built.body.entry?.buildError ?? "built, orphan and all");

    const check = await get(server.base, `/api/fkcheck?db=${built.body.entry.id}`);
    const broken = check.body.violations[0];
    show("violation", JSON.stringify(broken));
    ok("and foreign_key_check finds it", check.body.violations.length === 1);
    ok("naming the CHILD COLUMN, not just the table — fkid is resolved back through foreign_key_list",
       broken?.table === "books" && broken?.column === "author_id");
    ok("and the parent it failed to reach", broken?.parent === "authors");
    ok("with a row count and one example rowid to go and look at",
       broken?.rows === 2 && Number.isInteger(broken?.example), `${broken?.rows} rows, example rowid ${broken?.example}`);
  }

} catch (error) {
  failed += 1;
  failures.push(`harness: ${error.message}`);
  say(`\n  HARNESS ERROR: ${error.stack}`);
} finally {
  await stop(server);
}

head(`${passed} passed · ${failed} failed`);
if (failed) {
  for (const failure of failures) say(`  ✗ ${failure}`);
  say(`\n  the run directory is kept for inspection: ${RUN}\n`);
  process.exit(1);
}
fs.rmSync(RUN, { recursive: true, force: true });
say(`  run directory removed: ${RUN}\n`);
