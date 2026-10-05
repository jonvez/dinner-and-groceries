#!/usr/bin/env node
/**
 * `npm audit`, with a committed, expiring allowlist (ADR 0016).
 *
 * `npm audit` has no way to accept a single advisory: one unfixable finding
 * keeps the weekly audit red forever, and a check that is always red teaches
 * everyone to stop reading it. This gate fails on every advisory at moderate or
 * above EXCEPT ones named in `audit-allowlist.json`, and each exception there
 * is scoped to one advisory on one package, carries a reason, and expires.
 *
 * ## What it deliberately does not do
 *
 * - It does not drop dev dependencies (`--omit=dev`). Dev tools run on Jon's
 *   machine and in CI with his credentials, so they stay audited.
 * - It does not allow by package name. An exception names a GHSA id, so a NEW
 *   advisory on an allowlisted package still fails.
 * - It never passes on input it can't read. An npm error payload (registry
 *   down, no network) or a malformed allowlist throws, it doesn't come out
 *   as "no vulnerabilities".
 *
 * Expiry is the forcing function: when an exception lapses the audit goes red
 * again and someone has to re-check whether a fix exists, then renew the
 * exception on purpose or remove it.
 *
 * Usage: node scripts/audit-gate.mjs   (exit 0 = pass, 1 = fail)
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const MIN_SEVERITY = "moderate";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateException(e, i) {
  for (const field of ["advisory", "package", "expires", "reason"]) {
    if (typeof e?.[field] !== "string" || e[field].trim() === "") {
      throw new Error(`audit-allowlist exception #${i} is missing "${field}"`);
    }
  }
  if (!DATE.test(e.expires)) {
    throw new Error(`audit-allowlist exception #${i} has a malformed "expires" (want YYYY-MM-DD): ${e.expires}`);
  }
}

/** Every advisory object in the report, at or above MIN_SEVERITY, once each. */
function collectAdvisories(report) {
  if (!report || typeof report !== "object" || report.error || typeof report.vulnerabilities !== "object") {
    throw new Error(`not an npm audit report: ${JSON.stringify(report?.error ?? report).slice(0, 300)}`);
  }
  const seen = new Map();
  for (const vuln of Object.values(report.vulnerabilities)) {
    for (const via of vuln.via ?? []) {
      // A string `via` is a dependent; its advisory is on the package it names.
      if (typeof via !== "object") continue;
      if ((SEVERITY_RANK[via.severity] ?? 0) < SEVERITY_RANK[MIN_SEVERITY]) continue;
      const id = via.url?.match(/GHSA-[\w-]+/)?.[0] ?? via.url ?? String(via.source);
      const key = `${via.name}\0${id}`;
      if (!seen.has(key)) seen.set(key, { id, package: via.name, severity: via.severity, title: via.title });
    }
  }
  return [...seen.values()];
}

/**
 * @typedef {{ advisory: string, package: string, expires: string, reason: string, adr?: string }} Exception
 *
 * @param {object} report    parsed `npm audit --json`
 * @param {{exceptions: Exception[]}} allowlist  parsed audit-allowlist.json
 * @param {string} today     YYYY-MM-DD; an exception is valid through its expiry date
 */
export function evaluateAudit(report, allowlist, today) {
  const exceptions = allowlist?.exceptions;
  if (!Array.isArray(exceptions)) throw new Error('audit-allowlist has no "exceptions" array');
  exceptions.forEach(validateException);

  const blocking = [];
  const allowed = [];
  const expired = [];
  const used = new Set();

  for (const a of collectAdvisories(report)) {
    const match = exceptions.find((e) => e.advisory === a.id && e.package === a.package);
    if (!match) {
      blocking.push(a);
      continue;
    }
    used.add(match);
    // ISO dates compare correctly as strings.
    if (match.expires < today) expired.push({ ...a, expires: match.expires });
    else allowed.push({ ...a, expires: match.expires, reason: match.reason });
  }

  const stale = exceptions.filter((e) => !used.has(e));
  return { ok: blocking.length === 0 && expired.length === 0, blocking, allowed, expired, stale };
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const allowlist = JSON.parse(readFileSync(`${root}audit-allowlist.json`, "utf8"));
  // npm audit exits non-zero whenever it finds anything, so the exit code
  // says nothing here; the JSON on stdout is what gets judged.
  const run = spawnSync("npm", ["audit", "--json"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw run.error;
  const report = JSON.parse(run.stdout);
  const today = new Date().toISOString().slice(0, 10);
  const r = evaluateAudit(report, allowlist, today);

  const line = (a) => `  ${a.severity.padEnd(8)} ${a.package}  ${a.id}  ${a.title ?? ""}`;
  for (const a of r.allowed) console.log(`ALLOWED until ${a.expires}:\n${line(a)}\n    reason: ${a.reason}`);
  for (const e of r.stale) console.log(`STALE exception (matches nothing; remove it): ${e.package} ${e.advisory}`);
  for (const a of r.expired) console.error(`EXPIRED exception (${a.expires}), re-review or remove:\n${line(a)}`);
  for (const a of r.blocking) console.error(`BLOCKING:\n${line(a)}`);
  console.log(r.ok ? "audit gate: pass" : "audit gate: FAIL — run `npm audit` for details");
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
