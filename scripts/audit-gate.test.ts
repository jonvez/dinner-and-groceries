import { describe, expect, it } from "vitest";
import { evaluateAudit } from "./audit-gate.mjs";

// Minimal npm audit v2 shapes. A vulnerability's `via` holds advisory objects
// for the package that actually carries the advisory, and bare strings for the
// packages that only depend on it — those are covered by checking the root.
const advisory = (name: string, ghsa: string, severity = "high") => ({
  source: 1,
  name,
  dependency: name,
  title: `${name} advisory`,
  url: `https://github.com/advisories/${ghsa}`,
  severity,
  range: "*",
});

const report = (vulnerabilities: Record<string, unknown>) => ({
  auditReportVersion: 2,
  vulnerabilities,
});

const BRACES = report({
  braces: { name: "braces", severity: "high", via: [advisory("braces", "GHSA-vfj7-8cjw-p6xm")] },
  micromatch: { name: "micromatch", severity: "high", via: ["braces"] },
});

const exception = (overrides = {}) => ({
  advisory: "GHSA-vfj7-8cjw-p6xm",
  package: "braces",
  expires: "2027-01-05",
  reason: "no patched version exists",
  ...overrides,
});

describe("evaluateAudit", () => {
  it("passes a clean report", () => {
    const r = evaluateAudit(report({}), { exceptions: [] }, "2026-10-05");
    expect(r.ok).toBe(true);
    expect(r.blocking).toEqual([]);
  });

  it("blocks an advisory that is not allowlisted", () => {
    const r = evaluateAudit(BRACES, { exceptions: [] }, "2026-10-05");
    expect(r.ok).toBe(false);
    expect(r.blocking.map((a) => a.id)).toEqual(["GHSA-vfj7-8cjw-p6xm"]);
  });

  it("allows an allowlisted advisory, and its dependents ride on it", () => {
    const r = evaluateAudit(BRACES, { exceptions: [exception()] }, "2026-10-05");
    expect(r.ok).toBe(true);
    expect(r.allowed.map((a) => a.id)).toEqual(["GHSA-vfj7-8cjw-p6xm"]);
  });

  it("still blocks a NEW advisory alongside an allowlisted one", () => {
    const both = report({
      ...BRACES.vulnerabilities,
      next: { name: "next", severity: "critical", via: [advisory("next", "GHSA-vcvr-r3jv-pc5j", "critical")] },
    });
    const r = evaluateAudit(both, { exceptions: [exception()] }, "2026-10-05");
    expect(r.ok).toBe(false);
    expect(r.blocking.map((a) => a.id)).toEqual(["GHSA-vcvr-r3jv-pc5j"]);
  });

  it("scopes an exception to its package — the same GHSA on another package blocks", () => {
    const elsewhere = report({
      other: { name: "other", severity: "high", via: [advisory("other", "GHSA-vfj7-8cjw-p6xm")] },
    });
    const r = evaluateAudit(elsewhere, { exceptions: [exception()] }, "2026-10-05");
    expect(r.ok).toBe(false);
  });

  it("an expired exception blocks again", () => {
    const r = evaluateAudit(BRACES, { exceptions: [exception({ expires: "2026-10-04" })] }, "2026-10-05");
    expect(r.ok).toBe(false);
    expect(r.expired.map((a) => a.id)).toEqual(["GHSA-vfj7-8cjw-p6xm"]);
  });

  it("an exception is still valid on its expiry date", () => {
    const r = evaluateAudit(BRACES, { exceptions: [exception({ expires: "2026-10-05" })] }, "2026-10-05");
    expect(r.ok).toBe(true);
  });

  it("ignores advisories below moderate", () => {
    const low = report({ x: { name: "x", severity: "low", via: [advisory("x", "GHSA-aaaa-bbbb-cccc", "low")] } });
    expect(evaluateAudit(low, { exceptions: [] }, "2026-10-05").ok).toBe(true);
  });

  it("reports an exception that no longer matches anything as stale, without failing", () => {
    const r = evaluateAudit(report({}), { exceptions: [exception()] }, "2026-10-05");
    expect(r.ok).toBe(true);
    expect(r.stale.map((e) => e.advisory)).toEqual(["GHSA-vfj7-8cjw-p6xm"]);
  });

  it("counts an advisory once even when npm lists it twice", () => {
    const dup = report({
      braces: {
        name: "braces",
        severity: "high",
        via: [advisory("braces", "GHSA-vfj7-8cjw-p6xm"), advisory("braces", "GHSA-vfj7-8cjw-p6xm")],
      },
    });
    expect(evaluateAudit(dup, { exceptions: [] }, "2026-10-05").blocking).toHaveLength(1);
  });

  // Fail closed: anything that isn't a well-formed audit report or allowlist
  // must never be read as "no vulnerabilities".
  it("throws on an npm error payload instead of passing", () => {
    expect(() => evaluateAudit({ error: { code: "ENOTFOUND" } }, { exceptions: [] }, "2026-10-05")).toThrow();
  });

  it("throws on an exception missing a required field", () => {
    expect(() =>
      evaluateAudit(BRACES, { exceptions: [exception({ reason: "" })] }, "2026-10-05"),
    ).toThrow(/reason/);
  });

  it("throws on an exception with a malformed expiry", () => {
    expect(() =>
      evaluateAudit(BRACES, { exceptions: [exception({ expires: "Jan 5" })] }, "2026-10-05"),
    ).toThrow(/expires/);
  });
});
