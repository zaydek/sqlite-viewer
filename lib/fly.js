// fly.js — story 5: fetch a point-in-time copy of a database off a Fly volume.
//
// TWO MODES, NAMED OUT LOUD, NEITHER OF THEM A DEFAULT.
// `--fly` without `--fly-mode` is a usage error. The difference between reaching
// into production and reaching into a directory on this laptop is too large to
// be decided by a default, and a mock that can be reached by forgetting a flag
// is a mock that will eventually be mistaken for the real thing.
//
// WHAT A SNAPSHOT IS, EXACTLY:
//   `fly sftp get` is a RAW FILE READ over SFTP. It is not the SQLite backup
//   API and it takes no read lock on the remote database. So the copy is
//   point-in-time, and it is only *transactionally* consistent if nothing was
//   mid-write when it was read. That is why every snapshot is integrity-checked
//   the moment it lands, and the result is recorded on the entry rather than
//   assumed. A snapshot is NEVER a live attachment — nothing about it updates.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAGIC = Buffer.from("SQLite format 3\0", "binary");

/** Is this actually a SQLite database, or an error message the transport wrote into the file? */
export function looksLikeSqlite(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(16);
    const read = fs.readSync(fd, head, 0, 16, 0);
    return read === 16 && head.equals(MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * `PRAGMA quick_check` on the copy we just took. Cheap (it skips the index
 * cross-checks `integrity_check` does) and it is the only thing that turns
 * "the transfer exited 0" into evidence that the file is a usable database.
 */
export function integrityOf(file) {
  try {
    const handle = new DatabaseSync(file, { readOnly: true });
    try {
      const row = handle.prepare("PRAGMA quick_check").get();
      return String(Object.values(row)[0]);
    } finally {
      handle.close();
    }
  } catch (error) {
    return `unreadable: ${error.message}`;
  }
}

/**
 * @param options.mode  "real" — run `fly sftp get` against the named app
 *                      "mock" — copy from `mockRoot` treated as the remote filesystem
 */
export function fetchSnapshot({ app, remotePath, destination, mode, mockRoot, log = () => {} }) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const started = process.hrtime.bigint();

  let command;
  if (mode === "mock") {
    if (!mockRoot) throw new Error("--fly-mode mock needs --fly-mock-root <dir> — the directory standing in for the volume.");
    // `path.join` with an absolute second argument still joins, which is what we
    // want: /data/app.db under the mock root is <root>/data/app.db.
    const source = path.join(mockRoot, remotePath);
    command = `MOCK cp ${source} ${destination}   (stands in for: fly sftp get ${remotePath} ${destination} -a ${app})`;
    log(command);
    if (!fs.existsSync(source)) {
      throw new Error(`mock volume has no ${remotePath} — looked in ${source}`);
    }
    fs.copyFileSync(source, destination);
  } else if (mode === "real") {
    command = `fly sftp get ${remotePath} ${destination} -a ${app}`;
    log(command);
    const result = spawnSync("fly", ["sftp", "get", remotePath, destination, "-a", app], {
      encoding: "utf8",
      timeout:  120_000,
    });
    if (result.error) throw new Error(`could not run \`fly\`: ${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(`\`${command}\` exited ${result.status}: ${(result.stderr || result.stdout || "").trim()}`);
    }
  } else {
    throw new Error(`unknown fly mode ${mode} — expected "real" or "mock".`);
  }

  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  // A transfer that exited 0 and wrote a text file is the failure this catches.
  // Registering it would put a database in the picker that is not one.
  if (!looksLikeSqlite(destination)) {
    const head = fs.existsSync(destination) ? fs.readFileSync(destination).subarray(0, 80).toString("utf8") : "(no file)";
    fs.rmSync(destination, { force: true });
    throw new Error(`what arrived is not a SQLite database. First bytes: ${JSON.stringify(head)}`);
  }

  return {
    command,
    mode,
    ms,
    bytes:     fs.statSync(destination).size,
    integrity: integrityOf(destination),
  };
}
