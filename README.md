# sqlite-viewer

Browse any SQLite database in a browser. Rows, the verbatim schema, a map of
every table and foreign key, and a read-only query editor — over one or many
databases, in one window.

**Zero dependencies.** Only `node:sqlite`, `node:http`, `node:fs`. No npm
install, no build step, no WASM. Needs **Node ≥ 23.8** (or ≥ 22.16) for
`node:sqlite` with `backup()`.

```sh
git clone https://github.com/zaydek/sqlite-viewer
cd sqlite-viewer
node server.js path/to/your.db
#   → http://127.0.0.1:8094/console
```

Or `npm link` once and run `sqlite-viewer your.db` from anywhere.

## Two gestures

1. **Paste SQL** anywhere on the page → SQLite compiles it → the map draws.
2. **Drag-drop** a `.db`, a `.sql`, or a **folder** of `.sql` files → same result.

The map is drawn from `PRAGMA table_info` / `PRAGMA foreign_key_list` against a
real database, never from parsing SQL text. If SQLite refuses what you pasted,
the refusal is the answer, with the engine's message. That is what gives you:

- Row counts on every node; empty tables say `empty`.
- The real primary keys of small lookup tables, listed on the node.
- UNIQUE-constraint indexes, which `sqlite_master` alone cannot see.
- `PRAGMA foreign_key_check`, drawn in red on the exact edge it broke.
- **Diff two schemas** — open both and compare their maps.

## Three ways to point it at a database

| You have | Run | Proven by |
|---|---|---|
| a `.db` file on disk | `node server.js path/to.db` | `node prove.mjs` |
| just SQL, no database (in-memory-style) | `node server.js --schema schema.sql` or paste / drop SQL onto the page — SQLite compiles it into a throwaway database under the workspace | `node prove.mjs` |
| a database on a **Fly.io** volume | `node server.js --fly APP:/data/app.db --fly-mode real` — needs `flyctl` on PATH and `fly auth login` | `FLY_TARGET=APP:/data/app.db node prove-fly.mjs` |

`prove.mjs` runs the Fly code path against a stand-in `fly` binary so it never
touches production. `prove-fly.mjs` runs the real `flyctl` against **your** app,
snapshots the database over SFTP into a temp workspace, integrity-checks it,
lists tables and reads rows — the end-to-end receipt for your own setup. It is
read-only on the remote and refuses to run without `FLY_TARGET`.

A wrong path fails loudly rather than registering nothing: `fly sftp get` exits 1
with `remote path /data/x.db: file does not exist` and the server refuses to
start. To find the right path first: `fly ssh console -a APP -C "ls -la /data"`.

Last live run (2026-08-30, flyctl 0.4.95, 106 KB database, sjc): fetched in
~2 s, `quick_check = ok`, 5 tables, rows browsable — all passed.

## Run it

```sh
node server.js                                  # empty; paste or drop onto it
node server.js a.db b.db                        # database files
node server.js --schema schema/                 # a DIRECTORY of .sql, applied in filename order
node server.js --schema schema.sql              # a single file
node server.js --schema v1/ --schema v2/        # two, to diff them
node server.js --fly APP:/data/app.db --fly-mode real   # snapshot a Fly.io volume (needs flyctl)
node server.js --help
node prove.mjs                                  # the test suite: 139 assertions, no network
FLY_TARGET=APP:/data/app.db node prove-fly.mjs # live proof against your Fly app
```

**It never writes to a database you point it at.** Every handle is opened
`readOnly: true`; clones and downloads are new files. Everything it writes
lives under one directory, printed in the boot banner: `~/.sqlite-viewer/` by
default, `--workspace <dir>` to move it.

### Fly.io snapshots

`--fly app:/path/on/volume.db` runs `fly sftp get` against that app and
registers the copy as a snapshot. It requires `flyctl` on your PATH and logged
in. `--fly-mode` is mandatory — `real` reaches production, `mock` copies from a
local directory (`--fly-mock-root`) standing in for the volume. There is no
default, on purpose. A snapshot is a raw file read, not a locked backup, so
every one is `PRAGMA quick_check`ed on arrival and the result shown.

## What is on screen

```
?db=<id>                 the grid          rows, sorting, paging, FK cells you can click
?db=<id>&view=ddl        the schema        verbatim CREATE, indexes, constraint indexes
?db=<id>&view=map        the map
?db=<id>&view=map&vs=<other>   the map, diffed   +added / −removed / ~changed
?db=<id>&view=query      the query editor  read-only SQL
```

- **Click a table** on the map → the grid opens it. **Click a column** → the grid opens it with that column lit.
- **Click an edge** → a prefilled join lands in the query editor, ⌘↵ to run.
- **Hover a table** → everything else recedes and its relationships light up.
- **Drag a node**; positions survive a poll, not a schema change.
- Keys: `m` map · `f` fit · `w` wide · `d` databases · `p` paste · `t` theme · `/` query · `esc` back.

Node marks: `◆` primary key, `→` foreign key, dimmed name = nullable, footer
lines for indexes with their `WHERE` predicate.

Dark by default; `t` toggles light mode and it is remembered. The OS
`prefers-color-scheme` is deliberately not consulted.

## Layout

```
server.js        CLI, routes, boot banner
lib/
  args.js        the command line — flags win, nothing is guessed
  sqlite.js      inference, guards, and the graph (PRAGMA → columns, FKs, indexes, keys)
  db.js          one database: handle lifecycle, freshness, backup, fk check
  registry.js    many databases: the manifest, ids, builds, directories, paste
  fly.js         Fly.io snapshot fetch — real and mock, neither a default
ui/console.html  the whole frontend, inlined: grid, ddl, map, query
prove.mjs        the test suite — spawns real servers against hostile fixtures, no network
prove-fly.mjs    opt-in live proof against a real Fly.io app (FLY_TARGET=app:/path)
```

MIT.
