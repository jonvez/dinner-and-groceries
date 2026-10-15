import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "supabase-start.sh");

// Drive the script with a fake `supabase start` that plays back one scripted
// outcome per attempt, so retry behaviour is tested without Docker.
function run(outcomes: Array<"ok" | "fail" | "ratelimit">) {
  const dir = mkdtempSync(join(tmpdir(), "sb-start-"));
  const counter = join(dir, "attempts");
  const stops = join(dir, "stops");
  writeFileSync(counter, "0");
  writeFileSync(stops, "0");
  const fake = join(dir, "fake-start.sh");
  writeFileSync(
    fake,
    `n=$(( $(cat ${counter}) + 1 )); echo $n > ${counter}
     case "$(sed -n "\${n}p" ${join(dir, "plan")})" in
       ok) echo "Started supabase local development setup."; exit 0;;
       ratelimit) echo " gotrue Error toomanyrequests: Data limit exceeded" >&2; exit 1;;
       *) echo "failed to start: transient" >&2; exit 1;;
     esac`,
  );
  writeFileSync(join(dir, "plan"), outcomes.join("\n") + "\n");
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      SUPABASE_START_CMD: `bash ${fake}`,
      SUPABASE_STOP_CMD: `bash -c 'echo $(( $(cat ${stops}) + 1 )) > ${stops}'`,
      SUPABASE_START_BACKOFF: "0",
    },
  });
  return {
    status: r.status,
    output: r.stdout + r.stderr,
    attempts: Number(readFileSync(counter, "utf8")),
    stops: Number(readFileSync(stops, "utf8")),
  };
}

describe("scripts/ci/supabase-start.sh", () => {
  it("succeeds on the first attempt without retrying", () => {
    const r = run(["ok"]);
    expect(r.status).toBe(0);
    expect(r.attempts).toBe(1);
    expect(r.stops).toBe(0);
  });

  it("retries a transient failure, cleaning up in between", () => {
    const r = run(["fail", "ok"]);
    expect(r.status).toBe(0);
    expect(r.attempts).toBe(2);
    expect(r.stops).toBe(1);
  });

  it("gives up after three transient failures", () => {
    const r = run(["fail", "fail", "fail"]);
    expect(r.status).not.toBe(0);
    expect(r.attempts).toBe(3);
    expect(r.output).toMatch(/after 3 attempts/);
  });

  // A rate limit counts attempts, so retrying spends the very quota it is
  // waiting for (#236). Fail on the first one, and say why.
  it("fails fast on a registry rate limit instead of retrying", () => {
    const r = run(["ratelimit", "ok"]);
    expect(r.status).not.toBe(0);
    expect(r.attempts).toBe(1);
    expect(r.output).toMatch(/rate limit/i);
    expect(r.output).toMatch(/#236/);
  });

  it("still shows the CLI's own output, so a failure is diagnosable", () => {
    const r = run(["ratelimit"]);
    expect(r.output).toMatch(/toomanyrequests: Data limit exceeded/);
  });
});
