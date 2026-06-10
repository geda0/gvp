/* eslint-disable -- generated kit reader (CommonJS Node) */
"use strict";
// tics-view.js — the tic READ layer (loadTics + views), shared by the installed reader
// (.claude/hooks/tics) and the package CLI (bin/cli.js). Zero-dep; do NOT edit (refreshed).
const fs = require("fs"), path = require("path"), cp = require("child_process");
function storePaths(targetDir, ignoreEnv) {
  const dir = path.join(targetDir, ".claude", "state");
  // TICS_DIR / TICS_FILE let parallel worktree sections share ONE spool bus (see docs/tdd/sectioning.md).
  return { jsonl: (!ignoreEnv && process.env.TICS_FILE) || path.join(dir, "tics.jsonl"), spool: (!ignoreEnv && process.env.TICS_DIR) || path.join(dir, "tics.d") };
}
function loadTics(targetDir, ignoreEnv) {
  const { jsonl, spool } = storePaths(targetDir, ignoreEnv);
  const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  const out = [];
  try { for (const l of fs.readFileSync(jsonl, "utf8").split("\n")) if (l.trim()) { const o = parse(l); if (o) out.push(o); } } catch (e) {}
  try { for (const f of fs.readdirSync(spool)) if (f.endsWith(".json")) { const o = parse(fs.readFileSync(path.join(spool, f), "utf8").trim()); if (o) out.push(o); } } catch (e) {}
  out.sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")) || ((a.seq || 0) - (b.seq || 0)));
  return out;
}
function worktreeDirs(targetDir) {
  try {
    const out = cp.execFileSync("git", ["-C", targetDir, "worktree", "list", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const dirs = out.split("\n").filter((l) => l.indexOf("worktree ") === 0).map((l) => l.slice(9).trim()).filter(Boolean);
    return dirs.length ? dirs : [targetDir];
  } catch (e) { return [targetDir]; }
}
function loadTicsAll(targetDir) {
  const seen = new Set(), out = [];
  // Dedup key INCLUDES seq: an inherited worktree bus is a byte-copy (same seq+ts+content) and
  // collapses, but two legitimately-distinct tics that merely share a ts (e.g. rapid run-suite
  // signals, or test fixtures) keep their distinct seq and are preserved.
  const push = (arr) => { for (const x of arr) { const k = (x.seq || "") + "|" + (x.ts || "") + "|" + (x.kind || "") + "|" + (x.from || "") + "|" + (x.to || "") + "|" + (x.msg || "") + "|" + (x.scope || "") + "|" + (x.session || "") + "|" + (x.ref || ""); if (!seen.has(k)) { seen.add(k); out.push(x); } } };
  push(loadTics(targetDir));                                  // current bus (env-resolved, e.g. a shared TICS_DIR)
  for (const root of worktreeDirs(targetDir)) push(loadTics(root, true));   // each worktree's own default bus
  out.sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")) || ((a.seq || 0) - (b.seq || 0)));
  return out;
}
function loadFor(targetDir, all) { return all ? loadTicsAll(targetDir) : loadTics(targetDir); }
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
function ticsLog(targetDir, scopeFilter, all) {
  let t = loadFor(targetDir, all);
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
function ticsConductor(targetDir, all) {
  const COUPLING = ["claim", "release", "contract", "need", "section", "msg"];
  const tics = loadFor(targetDir, all);
  const t = tics.filter((x) => COUPLING.indexOf(x.kind) !== -1);
  if (!t.length) { console.log("No coupling tics yet (claim/release/contract/need/section/msg)."); return 0; }

  // Per-scope summary: each working unit's section status + active claims + needs/contracts.
  // One place the orchestrator sees grouping (sections) + coupling (claims) + who-owns-what.
  const active = claimsFor(targetDir, tics);
  const secStatus = new Map();
  for (const x of tics) if (x.kind === "section" && x.ref && x.result) secStatus.set(x.ref, x.result);
  const scopes = new Map();
  const claimsByScope = new Map();
  for (const x of t) {
    const sc = x.scope || "*";
    if (sc === "*") continue;
    let e = scopes.get(sc);
    if (!e) { e = { needs: [], contracts: [], hadClaim: false }; scopes.set(sc, e); }
    if (x.kind === "claim") e.hadClaim = true;
    if (x.kind === "need") e.needs.push(x.msg || x.ref || "?");
    if (x.kind === "contract") e.contracts.push(x.msg || x.ref || "?");
  }
  for (const x of active.values()) {
    const sc = x.scope || "*"; if (sc === "*") continue;
    let r = claimsByScope.get(sc); if (!r) { r = []; claimsByScope.set(sc, r); }
    r.push(x.ref);
  }
  if (scopes.size) {
    console.log("Conductor view — sections & coupling:");
    for (const sc of [...scopes.keys()].sort()) {
      const e = scopes.get(sc);
      const status = secStatus.get(sc.split("/")[0]) || "active";
      const refs = claimsByScope.get(sc) || [];
      const claimsStr = refs.length ? refs.join(", ") : (status === "done" && e.hadClaim ? "(freed)" : "-");
      let line = "  " + sc.padEnd(14) + ("[" + status + "]").padEnd(9) + "claims: " + claimsStr;
      if (e.needs.length) line += "   needs: " + e.needs.join(", ");
      if (e.contracts.length) line += "   contract: " + e.contracts.join(", ");
      console.log(line);
    }
    console.log("");
  }

  console.log("Cross-pair coupling tics:");
  for (const x of t) {
    const when = (x.ts || "").slice(11, 19);
    console.log("  #" + (x.seq || "?") + " " + when + "  " + (x.from || "?") + " -> " + (x.to || "*") + "  [" + (x.kind || "?") + " " + (x.scope || "*") + "]  " + (x.msg || "") + (x.ref ? " {" + x.ref + "}" : "") + (x.result ? " (" + x.result + ")" : ""));
  }
  return 0;
}
function ticsClaims(targetDir, all) {
  const active = claimsFor(targetDir, loadFor(targetDir, all));
  if (!active.size) { console.log("No active claims."); return 0; }
  console.log("Active claims (claim minus release):");
  for (const x of active.values()) console.log("  " + x.ref + "  <-  " + (x.scope || "?") + "  (#" + (x.seq || "?") + " " + (x.from || "?") + ")");
  return 0;
}
function ticsSections(targetDir, all) {
  const t = loadFor(targetDir, all);
  const sec = {};
  for (const x of t) {
    const sc = x.scope || "*";
    if (sc === "*") continue;
    const name = sc.split("/")[0];
    const e = sec[name] || (sec[name] = { tics: 0, claims: 0, contracts: 0, needs: 0, last: "", status: "" });
    e.tics++;
    if (x.kind === "claim") e.claims++;
    if (x.kind === "release") e.claims--;
    if (x.kind === "contract") e.contracts++;
    if (x.kind === "need") e.needs++;
    if (x.kind === "section" && x.result) e.status = x.result;   // open|done — append order, latest wins
    if ((x.ts || "") > e.last) e.last = x.ts || "";
  }
  const names = Object.keys(sec).sort();
  if (!names.length) { console.log("No sections yet — scope work with: echo <section>/<pair> > .claude/state/scope"); return 0; }
  console.log("Sections (live, from the tic log):");
  for (const n of names) {
    const e = sec[n];
    const st = e.status || "active";   // present in the log but never explicitly opened/closed => active
    console.log("  " + n.padEnd(16) + ("[" + st + "]").padEnd(9) + e.tics + " tics | claims " + Math.max(0, e.claims) + " | contracts " + e.contracts + " | needs " + e.needs + "  (last " + (e.last || "").slice(11, 19) + ")");
  }
  return 0;
}
// Sessions (ADR 0002): who is active on this repo and where. Groups the bus by the `session` field
// (set via TICS_SESSION / .claude/state/session). The cross-session coordination surface — two
// sessions on one tree each appear with their scopes + claims, so collisions are visible.
function ticsSessions(targetDir, all) {
  const t = loadFor(targetDir, all);
  const sess = {};
  for (const x of t) {
    const id = x.session || "";
    if (!id) continue;
    const e = sess[id] || (sess[id] = { tics: 0, scopes: {}, claims: 0, status: "active", last: "" });
    e.tics++;
    if (x.scope && x.scope !== "*") e.scopes[x.scope] = 1;
    if (x.kind === "claim") e.claims++;
    if (x.kind === "release") e.claims--;
    if (x.kind === "session" && x.result) e.status = x.result;   // open|closed — append order, latest wins
    if ((x.ts || "") > e.last) e.last = x.ts || "";
  }
  const ids = Object.keys(sess).sort();
  if (!ids.length) { console.log("No sessions yet — identify one with: echo <id> > .claude/state/session (or TICS_SESSION=<id>)."); return 0; }
  console.log("Sessions (live, from the bus):");
  for (const id of ids) {
    const e = sess[id];
    console.log("  " + id.padEnd(16) + ("[" + (e.status || "active") + "]").padEnd(10) + "scopes: " + (Object.keys(e.scopes).join(", ") || "-") + "  | claims " + Math.max(0, e.claims) + "  (last " + (e.last || "").slice(11, 19) + ")");
  }
  return 0;
}
// `tics todo [<session>]` — the cooperation "what should I pick up?" (ADR 0003 C2/C3). Sugar over
// the bus verbs: your OPEN assignments (a `delegate` to your session with no matching `handoff`) +
// the joint-forces pool (`delegate` offered to `*`) + open help requests (`need`).
function ticsTodo(targetDir, session) {
  const tics = loadFor(targetDir, true);
  if (!session) { try { session = fs.readFileSync(path.join(targetDir, ".claude", "state", "session"), "utf8").trim(); } catch (e) { session = ""; } }
  const handedOff = new Set();
  for (const x of tics) if (x.kind === "handoff" && x.ref) handedOff.add(x.ref);
  const mine = [], pool = [], needs = [];
  for (const x of tics) {
    if (x.kind === "delegate" && x.ref && !handedOff.has(x.ref)) {
      if (session && x.to === session) mine.push(x);
      else if (x.to === "*") pool.push(x);
    } else if (x.kind === "need") needs.push(x);
  }
  const row = (x) => "  " + (x.ref ? x.ref + "  " : "") + (x.msg || "") + "  (from " + (x.from || "?") + ")";
  console.log("Todo" + (session ? " — " + session : "") + ":");
  if (mine.length) { console.log(" Assigned to you (open):"); mine.forEach((x) => console.log(row(x))); }
  if (pool.length) { console.log(" Pool — grab one (delegate -> *):"); pool.forEach((x) => console.log(row(x))); }
  if (needs.length) { console.log(" Help wanted (need):"); needs.forEach((x) => console.log(row(x))); }
  if (!mine.length && !pool.length && !needs.length) console.log("  nothing open — pull a section or ask the lead.");
  return 0;
}
// Active claims = claim minus release, MINUS any whose section (scope's first component) is
// marked `done` — a closed section auto-releases its claims so the partition frees up for
// reassignment (release-on-done). The single source of truth for every claim consumer.
function activeClaims(tics, opts) {
  opts = opts || {};
  const active = new Map();
  const status = new Map();       // section name -> latest lifecycle status (open|done)
  const sessClosed = new Set();   // sessions that have closed -> their claims free (a leaving worker frees its lane)
  const sessLatest = new Map();   // session -> latest tic ts (for stale-TTL: a dead session's claims expire)
  for (const x of tics) {
    if (x.session) { const t = x.ts || ""; if (t > (sessLatest.get(x.session) || "")) sessLatest.set(x.session, t); }
    if (x.kind === "section" && x.ref && x.result) status.set(x.ref, x.result);
    if (x.kind === "session" && x.session) { if (x.result === "close" || x.result === "closed") sessClosed.add(x.session); else sessClosed.delete(x.session); }
    if (x.kind === "claim" && x.ref) active.set(x.ref, x);
    else if (x.kind === "release" && x.ref) active.delete(x.ref);
  }
  const ttlMs = (opts.ttlSec || 0) * 1000, now = opts.nowMs || 0;   // MS5 stale-TTL; ttlSec=0 disables
  for (const [ref, x] of active) {
    if (status.get((x.scope || "").split("/")[0]) === "done") { active.delete(ref); continue; }   // release-on-section-done
    if (x.session && sessClosed.has(x.session)) { active.delete(ref); continue; }                  // release-on-session-close (ADR 0003)
    if (ttlMs > 0 && now > 0 && x.session) {                                                        // release-on-stale: a dead session's claim expires
      const last = Date.parse(sessLatest.get(x.session) || "") || 0;
      if (last > 0 && (now - last) > ttlMs) active.delete(ref);
    }
  }
  return active;
}
// Read a numeric setting from tdd.config (e.g. CLAIMS_TTL), default if absent/unreadable.
function cfgNum(targetDir, key, def) {
  try { const m = fs.readFileSync(path.join(targetDir, ".claude", "tdd.config"), "utf8").match(new RegExp(key + "\\s*=\\s*(\\d+)")); return m ? parseInt(m[1], 10) : def; }
  catch (e) { return def; }
}
// Active claims for a target dir, with the stale-TTL applied (CLAIMS_TTL seconds from tdd.config;
// 0 = off). The single entry every claim consumer uses, so release-on-stale is uniform.
function claimsFor(targetDir, tics) { return activeClaims(tics, { nowMs: Date.now(), ttlSec: cfgNum(targetDir, "CLAIMS_TTL", 0) }); }
function claimCheck(targetDir, file, myScope) {
  if (!file || !myScope) return null;            // unscoped editor or no path -> no enforcement
  const active = claimsFor(targetDir, loadTicsAll(targetDir));   // ADR 0004 pt2: enforce ACROSS worktrees (the host gives each session its own) so a peer's claim is seen
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
// claimOwner: which scope (if any) actively holds a path — empty when unclaimed. Unlike
// claim-check (a yes/no guard relative to MY scope), this is a plain ownership lookup, so
// the guard can tell "unclaimed" (auto-claim it) from "already mine" (skip — no re-claim spam).
function claimOwner(targetDir, file) {
  if (!file) return "";
  const active = claimsFor(targetDir, loadTicsAll(targetDir));   // ADR 0004 pt2: enforce ACROSS worktrees (the host gives each session its own) so a peer's claim is seen
  for (const x of active.values()) {
    const hit = [x.ref, x.msg].filter(Boolean).some((t) => file === t || file.indexOf(t) !== -1 || t.indexOf(file) !== -1);
    if (hit) return x.scope || "*";
  }
  return "";
}
// claimSession: which SESSION (not scope) holds an active claim on a path — empty if free. The
// cross-session predicate the pre-commit gate uses (ADR 0002 MS3/MS4): a staged file or the
// RELEASE lock held by a session OTHER than mine must block the commit.
function claimSession(targetDir, file) {
  if (!file) return "";
  const active = claimsFor(targetDir, loadTicsAll(targetDir));   // ADR 0004 pt2: enforce ACROSS worktrees (the host gives each session its own) so a peer's claim is seen
  for (const x of active.values()) {
    const hit = [x.ref, x.msg].filter(Boolean).some((t) => file === t || file.indexOf(t) !== -1 || t.indexOf(file) !== -1);
    if (hit) return x.session || "";
  }
  return "";
}
function claimSessionCli(targetDir, file) { const s = claimSession(targetDir, file); if (s) console.log(s); return 0; }
function claimOwnerCli(targetDir, file) {
  const o = claimOwner(targetDir, file);
  if (o) console.log(o);
  return 0;
}
// sectionStatus: the latest lifecycle status of a section (open|done), empty if never opened.
// Lets the guard auto-open a section once on first scoped activity without re-opening it.
function sectionStatus(targetDir, name) {
  if (!name) return "";
  let st = "";
  for (const x of loadTics(targetDir)) {
    if (x.kind === "section" && x.ref === name && x.result) st = x.result;
  }
  return st;
}
function sectionStatusCli(targetDir, name) {
  const s = sectionStatus(targetDir, name);
  if (s) console.log(s);
  return 0;
}
function ticsCycle(targetDir) {
  const st = path.join(targetDir, ".claude", "state");
  const rd = (f) => { try { return fs.readFileSync(path.join(st, f), "utf8").trim(); } catch (e) { return ""; } };
  const phase = rd("phase") || "?", layer = rd("layer") || "?", scope = rd("scope") || "*";
  const t = loadTics(targetDir);
  const lastSig = [...t].reverse().find((x) => x.kind === "signal");
  let since = 0;
  for (let i = t.length - 1; i >= 0; i--) { if (t[i].kind === "verdict") break; if (t[i].kind === "signal" || t[i].kind === "handoff") since++; }
  console.log("Cycle: phase=" + phase + " layer=" + layer + " scope=" + scope);
  console.log("  last suite: " + (lastSig ? (lastSig.result || "?") : "(none yet)"));
  const streak = parseInt(rd("red-streak") || "0", 10);
  if (streak > 0) {
    const cfg = (() => { try { return fs.readFileSync(path.join(targetDir, ".claude", "tdd.config"), "utf8"); } catch (e) { return ""; } })();
    const m = cfg.match(/RED_STREAK_LIMIT\s*=\s*(\d+)/);
    const lim = m ? parseInt(m[1], 10) : 5;
    if (streak >= lim) console.log("  red-streak: " + streak + " reds in a row — suspected OVER-CONSTRAINED/CONTRADICTORY test; reconsider it (route to test-writer) or escalate, don't grind.");
    else console.log("  red-streak: " + streak);
  }
  if (since > 5) console.log("  " + since + " cycles since the last tdd-critic verdict — consider a critic pass (rule: every ~3-5 cycles).");
  else console.log("  " + since + " cycles since the last critic verdict.");
  return 0;
}
function verdictOutcome(x) {
  const r = (x.result || "").toLowerCase();
  if (r === "pass" || r === "accept" || r === "accepted" || r === "approved") return "pass";
  if (r === "concerns" || r === "block" || r === "blocked" || r === "reject" || r === "rejected") return r;
  const m = (x.msg || "").toLowerCase();
  if (/\b(block|concern|fail|reject)/.test(m)) return "concerns";
  if (/\b(pass|accept|approv)/.test(m)) return "pass";
  return "unknown";
}
function ticsGate(targetDir, all) {
  const t = (all ? loadTicsAll(targetDir) : loadTics(targetDir)).filter((x) => x.kind === "verdict");
  const latest = {};
  for (const x of t) latest[x.from] = x;
  const problems = [];
  for (const role of ["product-owner", "tdd-critic"]) {
    const v = latest[role];
    if (!v) { problems.push("no " + role + " verdict on the bus"); continue; }
    const o = verdictOutcome(v);
    if (o !== "pass") problems.push(role + ": " + o + "  (#" + (v.seq || "?") + " " + (v.msg || "").slice(0, 60) + ")");
  }
  const qa = latest["qa-verifier"];
  if (qa && verdictOutcome(qa) !== "pass") problems.push("qa-verifier: " + verdictOutcome(qa));
  if (!problems.length) {
    console.log("Release gate: CLEAR — product-owner + tdd-critic verdicts are pass" + (qa ? " (+ qa-verifier)" : "") + ".");
    return 0;
  }
  console.error("Release gate: BLOCKED — " + problems.length + " issue(s):");
  for (const p of problems) console.error("  - " + p);
  console.error("  Release only when PO-accept + tdd-critic PASS are on the bus (see docs/tdd/outer-loop.md).");
  return 1;
}
// fan-out: the plan-time disjointness gate. Reads a partition spec (one section per line:
// "<section> <file>..."), assigns each a scope (<section>/S<n>), and refuses to greenlight a
// fan-out where two sections claim the same file — auto-claim catches collisions at RUNTIME;
// this catches them before any pair starts. Read-only; the orchestrator sets scopes + delegates.
function fanOut(targetDir, specPath) {
  if (!specPath) { console.error("usage: tics fan-out <partition-spec-file>  (lines: '<section> <file>...')"); return 2; }
  let text;
  try { text = fs.readFileSync(specPath, "utf8"); }
  catch (e) { console.error("fan-out: cannot read spec '" + specPath + "'"); return 2; }
  const sections = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const name = parts.shift();
    sections.push({ name: name, files: parts });
  }
  if (!sections.length) { console.log("fan-out: no sections in spec."); return 0; }
  const owners = new Map();   // file -> [section names]
  for (const s of sections) for (const f of s.files) {
    let o = owners.get(f); if (!o) { o = []; owners.set(f, o); }
    if (o.indexOf(s.name) === -1) o.push(s.name);
  }
  const overlaps = [...owners.entries()].filter(function (e) { return e[1].length > 1; });
  console.log("Fan-out plan (" + sections.length + " sections):");
  sections.forEach(function (s, i) {
    const scope = s.name + "/S" + (i + 1);
    const dup = s.files.some(function (f) { return owners.get(f).length > 1; });
    console.log("  " + s.name.padEnd(12) + (s.files.length + " files").padEnd(9) + " -> scope " + scope.padEnd(16) + (dup ? "[OVERLAP]" : "[disjoint ✓]"));
  });
  if (overlaps.length) {
    for (const e of overlaps) console.log("  ⚠ overlap: " + e[0] + " in " + e[1].join(" + ") + " — serialize, or split the file (fix the seam).");
    console.log("Not safe to fan out as-is — resolve the overlaps above.");
    return 1;
  }
  console.log("All partitions disjoint — safe to fan out. Set each pair's scope and delegate.");
  return 0;
}
function main(argv, defaultRoot) {
  let scope = null, all = true; const rest = [];   // whole-picture by default (merge every worktree's bus); --here restricts to the local bus
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a === "--scope") scope = argv[++i] || ""; else if (a === "--all") all = true; else if (a === "--here") all = false; else rest.push(a); }
  const cmd = rest.shift();
  const role = cmd === "inbox" ? rest.shift() : null;
  const cfFile = cmd === "claim-check" ? rest.shift() : null;
  const cfScope = cmd === "claim-check" ? (rest.shift() || scope || "") : null;
  const coFile = cmd === "claim-owner" ? rest.shift() : null;
  const csFile = cmd === "claim-session" ? rest.shift() : null;
  const tdSession = cmd === "todo" ? rest.shift() : null;
  const soName = cmd === "section-status" ? rest.shift() : null;
  const foSpec = cmd === "fan-out" ? rest.shift() : null;
  const target = rest[0] ? path.resolve(rest[0]) : (defaultRoot || process.cwd());
  switch (cmd) {
    case "log": return ticsLog(target, scope, all);
    case "inbox": return ticsInbox(target, role, scope);
    case "conductor": return ticsConductor(target, all);
    case "claims": return ticsClaims(target, all);
    case "sections": return ticsSections(target, all);
    case "sessions": return ticsSessions(target, all);
    case "todo": return ticsTodo(target, tdSession);
    case "cycle": return ticsCycle(target);
    case "gate": return ticsGate(target, all);
    case "claim-check": return claimCheckCli(target, cfFile, cfScope);
    case "claim-owner": return claimOwnerCli(target, coFile);
    case "claim-session": return claimSessionCli(target, csFile);
    case "section-status": return sectionStatusCli(target, soName);
    case "fan-out": return fanOut(target, foSpec);
    default: console.error("usage: tics <log [--scope S] | inbox <role> [--scope S] | conductor | claims | sections | claim-check <file> <scope> | claim-owner <file> | section-status <name> | fan-out <spec>] [--all]>"); return 2;
  }
}
if (require.main === module) {
  process.exit(main(process.argv.slice(2), path.join(__dirname, "..", "..")) || 0);
}
module.exports = { loadTics, loadSignalEvents, ticsLog, ticsInbox, ticsConductor, ticsClaims, ticsSections, ticsSessions, ticsTodo, ticsCycle, ticsGate, claimCheck, claimCheckCli, claimOwner, claimOwnerCli, claimSession, claimSessionCli, sectionStatus, sectionStatusCli, fanOut, main };
