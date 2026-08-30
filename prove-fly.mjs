#!/usr/bin/env -S node --no-warnings
// prove-fly.mjs — prove YOUR Fly.io setup end to end, against a real app.
//
//   FLY_TARGET=my-app:/data/app.db node prove-fly.mjs
//
// prove.mjs covers the real-mode code path with a stand-in `fly` binary so it
// never touches production. This one does the opposite: it runs the actual
// `flyctl` on your PATH against the app you name, fetches the database over
// SFTP into a throwaway workspace, integrity-checks it, lists its tables and
// reads rows from the first one. Read-only on the remote — `fly sftp get` never
// writes to the volume. It refuses to run without FLY_TARGET, on purpose.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "server.js");
const target = process.env.FLY_TARGET;
if (!target || !target.includes(":")) {
  console.error("usage: FLY_TARGET=<fly-app>:<absolute path on the volume> node prove-fly.mjs");
  console.error("   eg: FLY_TARGET=my-app:/data/app.db node prove-fly.mjs");
  process.exit(2);
}
const [app, remotePath] = [target.slice(0, target.indexOf(":")), target.slice(target.indexOf(":") + 1)];

let failed = 0;
const ok = (label, cond, detail = "") => { console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `   ${detail}` : ""}`); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

console.log(`\nsqlite-viewer — live Fly proof against ${app}:${remotePath}\n`);

// 0. flyctl is present and logged in. Both failures are reported by name.
const version = spawnSync("fly", ["version"], { encoding: "utf8" });
ok("flyctl is on PATH", !version.error, (version.stdout || "").trim().split("\n")[0]);
const whoami = spawnSync("fly", ["auth", "whoami"], { encoding: "utf8" });
ok("flyctl is logged in", whoami.status === 0, (whoami.stdout || whoami.stderr || "").trim());
if (failed) { console.log("\nstopping: fix the above first (`fly auth login`)."); process.exit(1); }

// 1. Start the server in REAL mode with a throwaway workspace.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-viewer-fly-"));
process.on("exit", () => fs.rmSync(WS, { recursive: true, force: true })); // every exit path, including the early ones
const port = await freePort();
const child = spawn(process.execPath, ["--no-warnings", SERVER, "--port", String(port), "--workspace", WS, "--fly", target, "--fly-mode", "real"]);
const out = [];
child.stdout.on("data", (c) => out.push(String(c)));
child.stderr.on("data", (c) => out.push(String(c)));
const base = `http://127.0.0.1:${port}`;
let dbs = null;
for (let i = 0; i < 1200 && !dbs; i++) { // up to 60 s: sftp to a distant region is slow
  if (child.exitCode !== null) break;
  try { const b = await (await fetch(`${base}/api/dbs`)).json(); if (b.workspace === WS) dbs = b; } catch {}
  if (!dbs) await sleep(50);
}
try {
  ok("server came up in --fly-mode real", dbs !== null, dbs ? "" : out.join("").trim().split("\n").slice(-3).join(" | "));
  if (!dbs) process.exit(1);
  const snap = dbs.databases.find((d) => d.kind === "snapshot");
  ok("a snapshot entry was registered", !!snap);
  if (!snap) { console.log(out.join("")); process.exit(1); }
  console.log(`      command      ${snap.fly.command}`);
  console.log(`      fetched      ${snap.snapshot.bytes} bytes in ${Math.round(snap.snapshot.ms ?? snap.fly.ms ?? 0)} ms`);
  ok("the command was the real `fly sftp get`, not a mock", /^fly sftp get /.test(snap.fly.command) && snap.fly.mode === "real");
  ok("what arrived is a SQLite database that passes PRAGMA quick_check", snap.snapshot.integrity === "ok", `quick_check = ${snap.snapshot.integrity}`);
  const schema = await (await fetch(`${base}/api/schema?db=${snap.id}`)).json();
  const tables = (schema.objects ?? []).filter((o) => o.type === "table");
  ok("its schema is readable", tables.length > 0, `${tables.length} tables: ${tables.map((t) => t.name).slice(0, 8).join(", ")}${tables.length > 8 ? ", …" : ""}`);
  if (tables.length) {
    const rows = await (await fetch(`${base}/api/rows/${encodeURIComponent(tables[0].name)}?db=${snap.id}`)).json();
    ok(`rows are browsable (${tables[0].name})`, Number.isInteger(rows.count), `count = ${rows.count}`);
  }
  console.log(`\n  open it yourself:  node server.js --fly ${target} --fly-mode real\n`);
} finally {
  child.kill("SIGTERM");
  fs.rmSync(WS, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
