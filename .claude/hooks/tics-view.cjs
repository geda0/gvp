/* eslint-disable -- generated kit reader (CommonJS Node) */
"use strict";
// tics-view.js — the tic READ layer (loadTics + views), shared by the installed reader
// (.claude/hooks/tics) and the package CLI (bin/cli.js). Zero-dep; do NOT edit (refreshed).
const fs = require("fs"), path = require("path");
function storePaths(targetDir) {
  const dir = path.join(targetDir, ".claude", "state");
  // TICS_DIR / TICS_FILE let parallel worktree sections share ONE spool bus (see docs/tdd/sectioning.md).
  return { jsonl: process.env.TICS_FILE || path.join(dir, "tics.jsonl"), spool: process.env.TICS_DIR || path.join(dir, "tics.d") };
}
function loadTics(targetDir) {
  const { jsonl, spool } = storePaths(targetDir);
  const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  const out = [];
  try { for (const l of fs.readFileSync(jsonl, "utf8").split("\n")) if (l.trim()) { const o = parse(l); if (o) out.push(o); } } catch (e) {}
  try { for (const f of fs.readdirSync(spool)) if (f.endsWith(".json")) { const o = parse(fs.readFileSync(path.join(spool, f), "utf8").trim()); if (o) out.push(o); } } catch (e) {}
  out.sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")) || ((a.seq || 0) - (b.seq || 0)));
  return out;
}
function loadSignalEvents(targetDir) {
  const { jsonl, spool } = storePaths(targetDir);
  if (fs.existsSync(jsonl) || fs.existsSync(spool))
    return loadTics(targetDir).filter((t) => t.kind === "signal");
  try {
    return fs.readFileSync(path.join(targetDir, ".claude", "state", "telemetry.jsonl"), "utf8")
      .split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter((e) => e && e.event === "suite");
  } catch (e) { return []; }
}
function scopeMatch(s, f) {
  s = s || "*";
  return s === f || s === "*" || f === "*" || s.indexOf(f + "/") === 0 || f.indexOf(s + "/") === 0;
}
function collapseRunSuite(list) {
  // Fold a run of consecutive run-suite signals with the same result into one row (x N) —
  // keeps the thread readable; the store is untouched so report() still sees every run.
  const out = [];
  for (const x of list) {
    const p = out[out.length - 1];
    if (p && p.kind === "signal" && p.from === "run-suite" && x.kind === "signal" && x.from === "run-suite" && (x.result || "") === (p.result || "")) {
      p._count = (p._count || 1) + 1; p.ts = x.ts || p.ts; p.seq = x.seq || p.seq;
    } else { out.push(Object.assign({}, x)); }
  }
  return out;
}
function ticsLog(targetDir, scopeFilter) {
  let t = loadTics(targetDir);
  if (scopeFilter) t = t.filter((x) => scopeMatch(x.scope, scopeFilter));
  if (!t.length) { console.log("No tics yet — the agent thread is empty (.claude/state/tics.jsonl)."); return 0; }
  t = collapseRunSuite(t);
  for (const x of t) {
    const when = (x.ts || "").slice(11, 19) || "--:--:--";
    const arrow = ((x.from || "?") + " -> " + (x.to || "*")).padEnd(28);
    const kind = (x.kind || "?").padEnd(9);
    const ctx = ("[" + (x.layer || "?") + "/" + (x.phase || "?") + " " + (x.scope || "*") + "]").padEnd(22);
    console.log(String(x.seq || "").padStart(3) + "  " + when + "  " + arrow + kind + ctx + " " + (x.msg || "") + (x._count > 1 ? " x" + x._count : "") + (x.result ? "  (" + x.result + ")" : ""));
  }
  return 0;
}
function ticsInbox(targetDir, role, scopeFilter) {
  if (!role) { console.error("usage: tics inbox <role>   (e.g. tics inbox architect)"); return 2; }
  let t = loadTics(targetDir).filter((x) => x.to === role || x.to === "*");
  if (scopeFilter) t = t.filter((x) => scopeMatch(x.scope, scopeFilter));
  if (!t.length) { console.log("Inbox empty for '" + role + "' (no tics addressed to it or broadcast)."); return 0; }
  t = collapseRunSuite(t);
  console.log("Inbox for " + role + "  (to = " + role + " or *):");
  for (const x of t) console.log("  #" + (x.seq || "?") + "  " + (x.from || "?") + " [" + (x.kind || "?") + "]  " + (x.msg || "") + (x._count > 1 ? " x" + x._count : "") + (x.result ? "  (" + x.result + ")" : ""));
  return 0;
}
function ticsConductor(targetDir) {
  const COUPLING = ["claim", "release", "contract", "need", "msg"];
  const t = loadTics(targetDir).filter((x) => COUPLING.indexOf(x.kind) !== -1);
  if (!t.length) { console.log("No coupling tics yet (claim/release/contract/need/msg)."); return 0; }
  console.log("Conductor view — cross-pair coupling tics:");
  for (const x of t) {
    const when = (x.ts || "").slice(11, 19);
    console.log("  #" + (x.seq || "?") + " " + when + "  " + (x.from || "?") + " -> " + (x.to || "*") + "  [" + (x.kind || "?") + " " + (x.scope || "*") + "]  " + (x.msg || "") + (x.ref ? " {" + x.ref + "}" : "") + (x.result ? " (" + x.result + ")" : ""));
  }
  return 0;
}
function ticsClaims(targetDir) {
  const active = new Map();
  for (const x of loadTics(targetDir)) {
    if (x.kind === "claim" && x.ref) active.set(x.ref, x);
    else if (x.kind === "release" && x.ref) active.delete(x.ref);
  }
  if (!active.size) { console.log("No active claims."); return 0; }
  console.log("Active claims (claim minus release):");
  for (const x of active.values()) console.log("  " + x.ref + "  <-  " + (x.scope || "?") + "  (#" + (x.seq || "?") + " " + (x.from || "?") + ")");
  return 0;
}
function ticsSections(targetDir) {
  const t = loadTics(targetDir);
  const sec = {};
  for (const x of t) {
    const sc = x.scope || "*";
    if (sc === "*") continue;
    const name = sc.split("/")[0];
    const e = sec[name] || (sec[name] = { tics: 0, claims: 0, contracts: 0, needs: 0, last: "" });
    e.tics++;
    if (x.kind === "claim") e.claims++;
    if (x.kind === "release") e.claims--;
    if (x.kind === "contract") e.contracts++;
    if (x.kind === "need") e.needs++;
    if ((x.ts || "") > e.last) e.last = x.ts || "";
  }
  const names = Object.keys(sec).sort();
  if (!names.length) { console.log("No sections yet — scope work with: echo <section>/<pair> > .claude/state/scope"); return 0; }
  console.log("Sections (live, from the tic log):");
  for (const n of names) {
    const e = sec[n];
    console.log("  " + n.padEnd(16) + e.tics + " tics | claims " + Math.max(0, e.claims) + " | contracts " + e.contracts + " | needs " + e.needs + "  (last " + (e.last || "").slice(11, 19) + ")");
  }
  return 0;
}
function claimCheck(targetDir, file, myScope) {
  if (!file || !myScope) return null;            // unscoped editor or no path -> no enforcement
  const active = new Map();
  for (const x of loadTics(targetDir)) {
    if (x.kind === "claim" && x.ref) active.set(x.ref, x);
    else if (x.kind === "release" && x.ref) active.delete(x.ref);
  }
  for (const x of active.values()) {
    const hit = [x.ref, x.msg].filter(Boolean).some((t) => file === t || file.indexOf(t) !== -1 || t.indexOf(file) !== -1);
    if (hit && !scopeMatch(x.scope || "*", myScope)) return { token: x.ref, scope: x.scope || "*", seq: x.seq, from: x.from };
  }
  return null;
}
function claimCheckCli(targetDir, file, myScope) {
  const c = claimCheck(targetDir, file, myScope);
  if (c) { console.log(c.scope + " (#" + (c.seq || "?") + " " + (c.from || "?") + ", claim:" + c.token + ")"); return 3; }
  return 0;
}
function main(argv, defaultRoot) {
  let scope = null; const rest = [];
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a === "--scope") scope = argv[++i] || ""; else rest.push(a); }
  const cmd = rest.shift();
  const role = cmd === "inbox" ? rest.shift() : null;
  const cfFile = cmd === "claim-check" ? rest.shift() : null;
  const cfScope = cmd === "claim-check" ? (rest.shift() || scope || "") : null;
  const target = rest[0] ? path.resolve(rest[0]) : (defaultRoot || process.cwd());
  switch (cmd) {
    case "log": return ticsLog(target, scope);
    case "inbox": return ticsInbox(target, role, scope);
    case "conductor": return ticsConductor(target);
    case "claims": return ticsClaims(target);
    case "sections": return ticsSections(target);
    case "claim-check": return claimCheckCli(target, cfFile, cfScope);
    default: console.error("usage: tics <log [--scope S] | inbox <role> [--scope S] | conductor | claims | sections | claim-check <file> <scope>>"); return 2;
  }
}
if (require.main === module) {
  process.exit(main(process.argv.slice(2), path.join(__dirname, "..", "..")) || 0);
}
module.exports = { loadTics, loadSignalEvents, ticsLog, ticsInbox, ticsConductor, ticsClaims, ticsSections, claimCheck, claimCheckCli, main };
