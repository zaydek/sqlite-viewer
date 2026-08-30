#!/usr/bin/env -S node --no-warnings
// server.js — sqlite-viewer (v3).
//
// THE ONE SENTENCE: copy-paste SQL or drag-drop a database, and see the whole
// thing — as a grid of rows AND as a map of tables and foreign keys, from the
// same live database, in the same window.
//
// It grew out of two earlier tools, one with a grid and no picture, one with a
// picture drawn by PARSING SQL text (blind to row counts, and able to be wrong
// about what SQLite accepts). What this one changes is where the drawing comes from:
// NOT from parsing text, but from `PRAGMA table_info` and
// `PRAGMA foreign_key_list` against a real database. Pasted SQL is compiled by
// SQLite first; if SQLite refuses it, the refusal is the answer. The 400-line
// hand-written parser is deleted, not ported.
//
// What that buys, and what no parser can do: row counts on every node, empty
// tables visibly empty, a click from a box to its rows, and
// `PRAGMA foreign_key_check` drawn on the exact edge it broke.
//
// Zero dependencies: node:sqlite, node:http, node:fs. No build step, no WASM.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, parseArgs, usage, UsageError } from "./lib/args.js";
import { ServiceError } from "./lib/db.js";
import { Registry } from "./lib/registry.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...parts) => console.log(`  [sqlite-viewer ${stamp()}]`, ...parts);

// -- command line -------------------------------------------------------------

let config;
try {
  config = parseArgs(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(`\n  ${error.message}`);
  console.error(usage);
  process.exit(2);
}
if (config.help) {
  console.log(usage);
  process.exit(0);
}

const registry = new Registry({ workspace: config.workspace, log });

// Everything named on the command line must open or the process must say why
// and stop. Opening two of three databases and serving the survivors quietly is
// the failure v1's "missing database is a hard refusal" rule exists to prevent.
try {
  for (const file of config.databases) registry.openFile(file, { origin: "argv" });
  for (const file of config.schemas) registry.openSchema(file, { origin: "argv --schema" });
  for (const { app, remotePath } of config.fly) {
    registry.openFlySnapshot({
      app,
      remotePath,
      mode:     config.flyMode,
      mockRoot: config.flyMockRoot,
      origin:   `argv --fly ${app}:${remotePath} (${config.flyMode})`,
    });
  }
} catch (error) {
  console.error(`\n  ${error.message}\n`);
  process.exit(1);
}

// -- http plumbing ------------------------------------------------------------

const send = (response, status, body, type = "application/json", extra = {}) => {
  const payload = type === "application/json" ? JSON.stringify(body) : body;
  response.writeHead(status, {
    "content-type":  type + (type.startsWith("text") || type.endsWith("json") ? "; charset=utf-8" : ""),
    "cache-control": "no-store",
    ...extra,
  });
  response.end(payload);
};

/**
 * Refuse a request whose body we are deliberately NOT going to finish reading.
 *
 * v1's lesson, kept: answering and returning leaves unread bytes of the upload
 * in the socket, and HTTP keep-alive hands that poisoned socket to a LATER
 * request, which hangs forever with no error on either side. The signature is
 * nasty — the first request after succeeds and the second one hangs — so this
 * closes the connection and destroys the socket instead.
 */
const refuseBody = (request, response, status, body) => {
  send(response, status, body, "application/json", { connection: "close" });
  response.on("finish", () => request.socket?.destroy());
};

async function readBody(request, response, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      refuseBody(request, response, 413, { error: `body over ${limit} bytes` });
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const JSON_LIMIT = 100_000;
const UPLOAD_LIMIT = 64 * 1024 * 1024;

/**
 * Which database is this request about?
 *
 * No `?db=` means "the default one", and the default is resolved fresh rather
 * than remembered, so it follows the registry rather than the boot order. An id
 * that is registered but unreachable throws 410 with the path and the date on
 * it — see `Db.ensureFresh`. That is the state story 4 is really about: a
 * bookmark that has outlived its file should say so, not paint a blank page.
 */
function resolve(url) {
  const asked = url.searchParams.get("db");
  const id = asked ?? registry.defaultId();
  if (!id) {
    throw new ServiceError("No databases are open. Drop a .db or .sql onto the console, or name one on the command line.", 404, {
      empty: true,
    });
  }
  const db = registry.get(id);
  db.ensureFresh();
  return db;
}

// -- the server ---------------------------------------------------------------

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const route = url.pathname;

  try {
    // ---- the registry itself (never resolves a database; must answer even when
    // every single one of them is gone, because that is when you need it most)
    if (route === "/api/dbs") {
      return send(response, 200, {
        workspace: registry.workspace,
        manifest:  registry.manifest,
        default:   registry.defaultId(),
        databases: registry.list(),
      });
    }

    // ---- one database
    if (route === "/api/schema") {
      const db = resolve(url);
      return send(response, 200, { id: db.id, database: db.entry.label, entry: db.entry, objects: db.schema() });
    }

    if (route === "/api/version") {
      return send(response, 200, resolve(url).version());
    }

    // ---- integrity, drawn on the edge that broke it.
    // Separate from /api/schema on purpose: the schema is read on every poll,
    // and a full foreign_key_check is a table scan per foreign key. The map
    // asks for this once when you open it and once when you press the button.
    if (route === "/api/fkcheck") {
      const db = resolve(url);
      return send(response, 200, { id: db.id, violations: db.fkCheck() });
    }

    if (route.startsWith("/api/rows/")) {
      const db = resolve(url);
      const name = decodeURIComponent(route.slice("/api/rows/".length));
      return send(
        response,
        200,
        db.rows(name, {
          limit:   url.searchParams.get("limit"),
          offset:  url.searchParams.get("offset"),
          orderBy: url.searchParams.get("orderBy"),
          dir:     url.searchParams.get("dir"),
        }),
      );
    }

    if (route === "/api/query" && request.method === "POST") {
      const body = await readBody(request, response, JSON_LIMIT);
      if (body === null) return; // already refused, socket already closed
      const { sql } = JSON.parse(body.toString("utf8") || "{}");
      if (!sql) return send(response, 400, { error: "no sql" });

      // RE-RESOLVE, because reading the body above is the only place a handler
      // yields: while we awaited those bytes another request could have closed
      // this handle and reopened a replaced file. v1 leaked
      // `Cannot read properties of null (reading 'prepare')` here.
      const db = resolve(url);

      // A rejected QUERY is not a failed REQUEST. The HTTP call was well-formed;
      // the SQL inside it was wrong, which is an ordinary and frequent event in a
      // query tool. 400 on every typo paints the browser console red and trains
      // you to ignore it.
      try {
        return send(response, 200, db.query(sql));
      } catch (error) {
        return send(response, 200, { error: String(error.message || error) });
      }
    }

    // ---- story 7: download a CONSISTENT copy
    if (route.startsWith("/api/download/")) {
      const id = decodeURIComponent(route.slice("/api/download/".length));
      const db = registry.get(id);
      db.ensureFresh();

      // The copy is taken to a file first, not streamed live out of the source:
      // `backup()` is what makes it consistent, and it needs somewhere to land.
      // The outbox is emptied as soon as the bytes are on the wire.
      const outbox = path.join(registry.workspace, "outbox", `${id}-${Date.now()}.db`);
      const { pages, bytes } = await db.backupTo(outbox);
      log(`${id}: download — ${pages} pages, ${bytes} bytes via the SQLite online backup API`);

      const filename = `${id}.db`;
      response.writeHead(200, {
        "content-type":        "application/vnd.sqlite3",
        "content-length":      String(bytes),
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control":       "no-store",
        // Say HOW the copy was taken, on the response itself. "Downloaded the
        // file" and "took a backup" look identical until the source was busy.
        "x-sql-copy":          "sqlite-online-backup",
        "x-sql-pages":         String(pages),
      });
      const stream = fs.createReadStream(outbox);
      stream.pipe(response);
      const sweep = () => fs.rmSync(outbox, { force: true });
      stream.on("close", sweep);
      response.on("close", sweep);
      return;
    }

    // ---- story 8: clone
    if (route.startsWith("/api/clone/") && request.method === "POST") {
      const id = decodeURIComponent(route.slice("/api/clone/".length));
      const entry = await registry.clone(id);
      return send(response, 200, { entry });
    }

    // ---- story 3: a file dropped on the page
    if (route === "/api/open/upload" && request.method === "POST") {
      const body = await readBody(request, response, UPLOAD_LIMIT);
      if (body === null) return;
      const filename = request.headers["x-sql-filename"];
      if (!filename) return send(response, 400, { error: "x-sql-filename header is required — the extension decides how the bytes are read" });
      const entry = registry.acceptUpload(decodeURIComponent(filename), body);
      return send(response, 200, { entry });
    }

    // ---- GESTURE 1: SQL pasted into the page.
    // The limit is deliberately the UPLOAD one, not the 100 KB JSON one:
    // A real five-file schema concatenated is ~16 KB, but a schema you paste is
    // whatever you had on the clipboard, and refusing it at 100 KB with
    // "body too large" would be a mystifying way to lose your paste.
    if (route === "/api/open/paste" && request.method === "POST") {
      const body = await readBody(request, response, UPLOAD_LIMIT);
      if (body === null) return;
      const { sql, label } = JSON.parse(body.toString("utf8") || "{}");
      const entry = registry.acceptPaste(sql, label);
      return send(response, 200, { entry });
    }

    // ---- GESTURE 2, the hard half: a whole folder of .sql dropped at once.
    // A browser cannot hand over a path, only bytes, so the files arrive as a
    // list and are rebuilt as a real directory in the workspace.
    if (route === "/api/open/bundle" && request.method === "POST") {
      const body = await readBody(request, response, UPLOAD_LIMIT);
      if (body === null) return;
      const { name, files } = JSON.parse(body.toString("utf8") || "{}");
      const entry = registry.acceptBundle(name, files);
      return send(response, 200, { entry });
    }

    // ---- stories 1 and 2 without a restart: open by path from the UI
    if (route === "/api/open/path" && request.method === "POST") {
      const body = await readBody(request, response, JSON_LIMIT);
      if (body === null) return;
      const { path: target } = JSON.parse(body.toString("utf8") || "{}");
      if (!target) return send(response, 400, { error: "no path" });
      // A directory or a .sql is a schema; anything else is a database file.
      // This is the one place the shape is inferred, and only because the
      // filesystem is being asked rather than the string guessed at.
      const isDirectory = fs.existsSync(target) && fs.statSync(target).isDirectory();
      const entry = isDirectory || target.toLowerCase().endsWith(".sql")
        ? registry.openSchema(target, { origin: "opened by path from the console" })
        : registry.openFile(target, { origin: "opened by path from the console" });
      return send(response, 200, { entry });
    }

    // ---- story 5: take a snapshot without a restart
    if (route === "/api/open/fly" && request.method === "POST") {
      const body = await readBody(request, response, JSON_LIMIT);
      if (body === null) return;
      const { app, remotePath } = JSON.parse(body.toString("utf8") || "{}");
      if (!app || !remotePath) return send(response, 400, { error: "need app and remotePath" });
      if (!config.flyMode) {
        return send(response, 400, {
          error:
            "This server was started without --fly-mode, so it will not reach a volume. Restart it with --fly-mode mock --fly-mock-root <dir>, or --fly-mode real.",
        });
      }
      const entry = registry.openFlySnapshot({
        app,
        remotePath,
        mode:     config.flyMode,
        mockRoot: config.flyMockRoot,
        origin:   `taken from the console (${config.flyMode})`,
      });
      return send(response, 200, { entry });
    }

    if (route.startsWith("/api/snapshot/") && route.endsWith("/retake") && request.method === "POST") {
      const id = decodeURIComponent(route.slice("/api/snapshot/".length, -"/retake".length));
      return send(response, 200, { entry: registry.retakeSnapshot(id) });
    }

    if (route.startsWith("/api/db/") && request.method === "DELETE") {
      const id = decodeURIComponent(route.slice("/api/db/".length));
      const entry = registry.forget(id);
      return send(response, 200, { forgot: entry.id, fileStillAt: entry.path });
    }

    // Browsers ask for this unprompted; a 404 in the console reads like a bug in
    // the page. Answer "nothing here" rather than "not found".
    if (route === "/favicon.ico") return send(response, 204, "", "text/plain");

    // ---- the page
    if (route === "/" || route === "/console" || route === "/console/") {
      return send(response, 200, fs.readFileSync(path.join(HERE, "ui", "console.html"), "utf8"), "text/html");
    }

    send(response, 404, { error: `no route ${route}` });
  } catch (error) {
    // Errors are the product here: a viewer whose failures are opaque is worse
    // than no viewer. Send the real message, and let a vanished database answer
    // 410 rather than hiding inside a blanket 400 — the UI distinguishes "your
    // request was bad" from "that database is gone, and here is which file".
    const status = error.status ?? 400;
    const body = { error: String(error.message || error) };
    for (const key of ["gone", "empty", "id", "kind", "path", "openedAt", "knownIds"]) {
      if (error[key] !== undefined) body[key] = error[key];
    }
    if (status >= 500 || status === 410) log(`${status} on ${route}: ${body.error}`);
    send(response, status, body);
  }
});

// A port collision is the single most likely way to start this and is not an
// exceptional condition — say so in one line rather than printing a Node stack
// trace at someone who just wanted to look at a table.
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`\n  Port ${config.port} is already in use.`);
    console.error(`  Try another:  node server.js --port ${config.port < 65535 ? config.port + 1 : config.port - 1}\n`);
    process.exit(1);
  }
  throw error;
});

server.listen(config.port, "127.0.0.1", () => {
  const rows = registry.list();
  const url = `http://127.0.0.1:${config.port}`;

  console.log(`
  sqlite-viewer  —  ${rows.length} database${rows.length === 1 ? "" : "s"} in the registry

  ${url}/console${rows.length ? `?db=${registry.defaultId()}` : ""}

  workspace  ${registry.workspace}
  manifest   ${registry.manifest}
  fly mode   ${config.flyMode ?? "not enabled (start with --fly-mode to allow snapshots)"}
`);

  for (const row of rows) {
    const mark = row.status === "ok" ? " " : row.status === "stale" ? "~" : "!";
    // A directory-backed schema prints the files and the ORDER they were applied
    // in, because that order is the whole contract of a multi-file schema and it
    // should never have to be inferred from the drawing.
    const where =
      row.kind === "schema" && row.sourceKind === "directory"
        ? `${row.sourcePath}  [${(row.sourceFiles ?? []).map((file) => path.basename(file)).join(" → ")}]`
        : row.path;
    console.log(`  ${mark} ${row.id.padEnd(24)} ${row.kind.padEnd(9)} ${row.status.padEnd(6)} ${where}`);
  }
  if (!rows.length) {
    console.log(`  (nothing open — paste SQL or drop a .db, a .sql, or a FOLDER of .sql onto ${url}/console)`);
  }
  console.log(`
  Read-only against every one of them. Every reopen, build, snapshot and clone is logged below.
`);
});
