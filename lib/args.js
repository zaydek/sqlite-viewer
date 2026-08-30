// args.js — the command line, parsed with no guessing anywhere.
//
// v1's two rules are kept verbatim because they are right: FLAGS WIN OVER
// POSITIONALS, and ANYTHING UNRECOGNISED IS AN ERROR. A typo'd `--prot 6060`
// exits 2 rather than quietly serving the default port and leaving someone
// staring at a browser tab wondering why.
//
// One more rule: `--fly` REQUIRES `--fly-mode`.
// sqlite-viewer adds none — `--schema` simply learned to take a DIRECTORY as
// well as a file, which needs no new flag because the filesystem already knows
// which one you handed it.

import { DEFAULT_WORKSPACE } from "./registry.js";


export const DEFAULT_PORT = 8094;

export class UsageError extends Error {}

export const usage = `
  sqlite-viewer — every database you care about, as a grid AND as a map

    sqlite-viewer                            open the console with whatever the
                                             registry remembers; drop or paste onto it
    sqlite-viewer a.db b.db                  open one or more database files
    sqlite-viewer --schema schema/           a DIRECTORY of .sql, filename order
    sqlite-viewer --schema SCHEMA.sql        a single schema file
    sqlite-viewer --schema v1/ --schema v2/  two, to diff them
    sqlite-viewer --fly APP:/data/x.db --fly-mode real      snapshot a Fly volume (needs flyctl)
    sqlite-viewer --db a.db --port ${DEFAULT_PORT}           flag form; flags win over positionals

  Flags
    --db <path>            a database file                      (repeatable)
    --schema <path>        a .sql file OR a directory of them   (repeatable)
                           a directory is applied in FILENAME ORDER — that is
                           what the NN- prefixes on a multi-file schema are for
    --fly <app>:<path>     snapshot a Fly volume db             (repeatable)
    --fly-mode real|mock   REQUIRED with --fly; there is no default
    --fly-mock-root <dir>  the directory standing in for the volume, in mock mode
    --port <n>             default ${DEFAULT_PORT}
    --workspace <dir>      where snapshots, clones, drops and the registry live
                           default ${DEFAULT_WORKSPACE}
    --help

  Read-only against every database it opens. Clones and downloads are new files.
`;

const VALUE_FLAGS = new Set(["--db", "--schema", "--fly", "--fly-mode", "--fly-mock-root", "--port", "--workspace"]);
const REPEATABLE = new Set(["--db", "--schema", "--fly"]);

export function parseArgs(argv) {
  const flags = new Map();
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") return { help: true };
    if (VALUE_FLAGS.has(token)) {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${token} needs a value.`);
      if (REPEATABLE.has(token)) flags.set(token, [...(flags.get(token) ?? []), value]);
      else flags.set(token, value);
    } else if (token.startsWith("-")) {
      throw new UsageError(`Unknown flag ${token}.`);
    } else {
      positional.push(token);
    }
  }

  // A port that fails to parse must not fall back to the default: you asked for
  // 6060 and silently getting 8094 is the same class of bug as the typo'd flag.
  const portArgument = flags.get("--port") ?? String(DEFAULT_PORT);
  const port = Number(portArgument);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`Port must be an integer 1–65535, got ${portArgument}.`);
  }

  const fly = (flags.get("--fly") ?? []).map((spec) => {
    // `app:/data/x.db` — split on the FIRST colon only, because the remote path
    // is absolute and may contain more.
    const cut = spec.indexOf(":");
    if (cut < 1 || cut === spec.length - 1) {
      throw new UsageError(`--fly wants <app>:<remote-path>, got ${spec}.`);
    }
    return { app: spec.slice(0, cut), remotePath: spec.slice(cut + 1) };
  });

  const flyMode = flags.get("--fly-mode") ?? null;
  if (fly.length && !flyMode) {
    throw new UsageError(
      "--fly requires --fly-mode real|mock. There is no default: reaching into production and reaching into a directory on this laptop must not be one flag apart.",
    );
  }
  if (flyMode && !["real", "mock"].includes(flyMode)) {
    throw new UsageError(`--fly-mode must be real or mock, got ${flyMode}.`);
  }
  const flyMockRoot = flags.get("--fly-mock-root") ?? null;
  if (flyMode === "mock" && fly.length && !flyMockRoot) {
    throw new UsageError("--fly-mode mock requires --fly-mock-root <dir> — the directory standing in for the volume.");
  }
  if (flyMode === "real" && flyMockRoot) {
    throw new UsageError("--fly-mock-root means nothing in real mode; drop one of the two rather than half-meaning both.");
  }

  return {
    help:      false,
    databases: [...positional, ...(flags.get("--db") ?? [])],
    schemas:   flags.get("--schema") ?? [],
    fly,
    flyMode,
    flyMockRoot,
    port,
    workspace: flags.get("--workspace") ?? DEFAULT_WORKSPACE,
  };
}
