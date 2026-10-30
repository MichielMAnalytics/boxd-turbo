import { describe, expect, test } from "vitest";
import { SUMMARY_MARK } from "../src/boxd/scripts.js";
import { createPool, type PoolBoxd, type PoolOptions } from "../src/boxd/worker.js";
import type { TaskNode } from "../src/core/graph.js";

const node = (id: string, outputs: string[] = []): TaskNode => ({
  id,
  pkg: id.split("#")[0] ?? "",
  task: id.split("#")[1] ?? "",
  dir: `packages/${id.split("#")[0]}`,
  hash: id,
  deps: [],
  outputs,
  cached: false,
  noop: false,
  logFile: `packages/${id.split("#")[0]}/.turbo/turbo-x.log`,
});

type Exec = { id: string; script: string; env: Record<string, string> };

/** Records every call; turbo runs succeed unless `exitCodes` says otherwise. */
class FakeBoxd implements PoolBoxd {
  log: string[] = [];
  execs: Exec[] = [];
  uploads: { id: string; path: string; bytes: number }[] = [];
  exitCodes = new Map<string, number>();
  failPrepare = false;
  execError?: Error;
  createGate?: Promise<void>;
  private n = 0;

  machines = {
    create: async (p: Parameters<PoolBoxd["machines"]["create"]>[0]) => {
      this.log.push(`create ${p.name}`);
      this.lastCreate = p;
      if (this.createGate) await this.createGate;
      this.n += 1;
      return { id: `m${this.n}`, name: p.name };
    },
    waitUntilReady: async (id: string) => {
      this.log.push(`ready ${id}`);
    },
    exec: async (id: string, p: { command: string[]; env?: Record<string, string> }) => {
      const script = p.command[2] ?? "";
      this.execs.push({ id, script, env: p.env ?? {} });
      if (script.includes("turbo run")) {
        this.log.push(`turbo ${id}`);
        if (this.execError) throw this.execError;
        const ids = [...script.matchAll(/'([^' ]+#[^' ]+)'/g)].map((m) => m[1] as string);
        const tasks = ids.map((t) => ({
          taskId: t,
          cache: { status: "MISS" },
          execution: { startTime: 0, endTime: 1000, exitCode: this.exitCodes.get(t) ?? 0 },
        }));
        return { stdout: `${SUMMARY_MARK}\n${JSON.stringify({ tasks })}\n`, stderr: "", exitCode: 0 };
      }
      this.log.push(`prepare ${id}`);
      if (this.failPrepare) return { stdout: "", stderr: "fatal: couldn't find remote ref", exitCode: 128 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    resize: async (id: string, p: { vcpu: number; memory: string }) => {
      this.log.push(`resize ${id} ${p.vcpu} ${p.memory}`);
    },
    pause: async (id: string) => {
      this.log.push(`pause ${id}`);
    },
    delete: async (id: string) => {
      this.log.push(`delete ${id}`);
    },
    setDeleteAfter: async (id: string, seconds: number) => {
      this.log.push(`deleteAfter ${id} ${seconds}`);
    },
    files: {
      upload: async (id: string, path: string, source: Uint8Array) => {
        this.uploads.push({ id, path, bytes: source.length });
        return source.length;
      },
    },
  };
  lastCreate?: Parameters<PoolBoxd["machines"]["create"]>[0];
}

const options = (o: Partial<PoolOptions> = {}): PoolOptions => ({
  snapshot: "bci-app-a",
  org: "acme",
  baseCpus: 2,
  workdir: "/home/boxd/work/app",
  prepare: { kind: "commit", sha: "abc1234def", fetchToken: "ghs_secret" },
  env: { TURBO_TOKEN: "t0k", CI: "1" },
  runId: "20261030-091400-abc1234",
  ...o,
});

describe("createPool", () => {
  test("a machine starts from the snapshot, isolated, with a delete-after timer and the run's labels", async () => {
    const boxd = new FakeBoxd();
    const pool = createPool(boxd, options());
    const w = await pool.acquire();
    expect(boxd.lastCreate).toMatchObject({
      org: "acme",
      fromSnapshot: "bci-app-a",
      isolated: true,
      deleteAfter: 3600,
      labels: { "boxd-ci": "worker", "boxd-ci/run": "20261030-091400-abc1234" },
    });
    expect(w.id).toMatch(/^bci-abc1234-[a-z0-9]{4}-1$/);
    expect(pool.machines()).toBe(1);
  });

  test("a commit is fetched once per machine, with the token only on that command", async () => {
    const boxd = new FakeBoxd();
    const pool = createPool(boxd, options());
    const w = await pool.acquire();
    await w.run([node("a#test")]);
    await w.run([node("b#test")]);
    const prepares = boxd.execs.filter((e) => e.script.includes("fetch -q origin abc1234def"));
    expect(prepares).toHaveLength(1);
    expect(prepares[0]?.env).toEqual({ BOXD_CI_FETCH_TOKEN: "ghs_secret" });
    const turbo = boxd.execs.filter((e) => e.script.includes("turbo run"));
    expect(turbo.map((e) => e.env)).toEqual([
      { TURBO_TOKEN: "t0k", CI: "1" },
      { TURBO_TOKEN: "t0k", CI: "1" },
    ]);
  });

  test("a working-copy patch is uploaded and applied on the base commit", async () => {
    const boxd = new FakeBoxd();
    const patch = new TextEncoder().encode("diff --git a/x b/x\n");
    const pool = createPool(boxd, options({ prepare: { kind: "patch", base: "base999", patch } }));
    await pool.acquire();
    expect(boxd.uploads).toEqual([{ id: "m1", path: "/tmp/boxd-ci.patch", bytes: patch.length }]);
    expect(boxd.execs[0]?.script).toContain("checkout -q -f base999");
    expect(boxd.execs[0]?.script).toContain("git apply --binary --whitespace=nowarn '/tmp/boxd-ci.patch'");
  });

  test("every group cleans the declared outputs before Turborepo runs, and re-arms the timer", async () => {
    const boxd = new FakeBoxd();
    const pool = createPool(boxd, options());
    const w = await pool.acquire();
    await w.run([node("a#build", ["dist/**"])]);
    await w.run([node("b#build", ["dist/**"])]);
    const turbo = boxd.execs.filter((e) => e.script.includes("turbo run"));
    expect(turbo).toHaveLength(2);
    for (const [i, pkg] of ["a", "b"].entries()) {
      const s = turbo[i]?.script ?? "";
      expect(s).toContain(`"dir":"packages/${pkg}"`);
      expect(s.indexOf("globSync")).toBeLessThan(s.indexOf("turbo run"));
    }
    expect(boxd.log.filter((l) => l === "deleteAfter m1 3600" || l === "turbo m1")).toEqual([
      "deleteAfter m1 3600",
      "turbo m1",
      "deleteAfter m1 3600",
      "turbo m1",
    ]);
  });

  test("outputsOf decides what a group cleans", async () => {
    const boxd = new FakeBoxd();
    const pool = createPool(boxd, options({ outputsOf: () => [{ dir: "packages/dep", globs: ["lib/**"] }] }));
    const w = await pool.acquire();
    await w.run([node("a#test")]);
    expect(boxd.execs.at(-1)?.script).toContain('"dir":"packages/dep"');
  });

  test("results come from Turborepo's summary, on the machine's name", async () => {
    const boxd = new FakeBoxd();
    boxd.exitCodes.set("b#test", 1);
    const pool = createPool(boxd, options());
    const w = await pool.acquire();
    const r = await w.run([node("a#test"), node("b#test")]);
    expect(r.map((x) => [x.id, x.status, x.seconds, x.machine])).toEqual([
      ["a#test", "ran", 1, w.id],
      ["b#test", "failed", 1, w.id],
    ]);
  });

  test("an exec error fails every task of the group with the error", async () => {
    const boxd = new FakeBoxd();
    boxd.execError = new Error("deadline exceeded");
    const pool = createPool(boxd, options());
    const w = await pool.acquire();
    const r = await w.run([node("a#test"), node("b#test")]);
    expect(r.map((x) => x.status)).toEqual(["failed", "failed"]);
    expect(r[0]?.logTail).toContain("deadline exceeded");
  });

  test("a task asking for another size gets its machine resized before it is prepared", async () => {
    const boxd = new FakeBoxd();
    const pool = createPool(boxd, options());
    await pool.acquire(4);
    await pool.acquire(2);
    await pool.acquire();
    expect(boxd.log.filter((l) => l.startsWith("resize") || l.startsWith("prepare") || l.startsWith("ready"))).toEqual([
      "ready m1",
      "resize m1 4 16G",
      "ready m1",
      "prepare m1",
      "ready m2",
      "prepare m2",
      "ready m3",
      "prepare m3",
    ]);
  });

  test("a successful release deletes the machine", async () => {
    const boxd = new FakeBoxd();
    const pool = createPool(boxd, options());
    const w = await pool.acquire();
    await w.release({ failed: false });
    expect(boxd.log).toContain("delete m1");
    expect(boxd.log).not.toContain("pause m1");
  });

  test("a failed release pauses the machine and keeps it for 24 hours", async () => {
    const boxd = new FakeBoxd();
    const pool = createPool(boxd, options());
    const w = await pool.acquire();
    await w.release({ failed: true });
    expect(boxd.log.slice(-2)).toEqual(["pause m1", "deleteAfter m1 86400"]);
    expect(boxd.log).not.toContain("delete m1");
    expect(pool.kept()).toEqual([w.id]);
  });

  test("a machine that cannot be prepared is deleted and the acquire fails with git's error", async () => {
    const boxd = new FakeBoxd();
    boxd.failPrepare = true;
    const pool = createPool(boxd, options());
    await expect(pool.acquire()).rejects.toThrow("fatal: couldn't find remote ref");
    expect(boxd.log).toContain("delete m1");
  });

  test("drain deletes every live machine, also after a failed run, and keeps the failed ones", async () => {
    const boxd = new FakeBoxd();
    boxd.exitCodes.set("a#test", 1);
    const pool = createPool(boxd, options());
    const a = await pool.acquire();
    const b = await pool.acquire();
    const c = await pool.acquire();
    await a.run([node("a#test")]);
    await a.release({ failed: true });
    await expect(b.run([node("b#test")])).resolves.toHaveLength(1);
    await pool.drain();
    expect(boxd.log.filter((l) => l.startsWith("delete "))).toEqual(["delete m2", "delete m3"]);
    expect(c.id).toBeTruthy();
    await expect(pool.acquire()).rejects.toThrow("the run is over");
  });

  test("a machine still being created when the pool drains is deleted as soon as it exists", async () => {
    const boxd = new FakeBoxd();
    let open: () => void = () => {};
    boxd.createGate = new Promise<void>((r) => {
      open = r;
    });
    const pool = createPool(boxd, options());
    const pending = pool.acquire();
    await new Promise((r) => setTimeout(r, 0));
    const drained = pool.drain();
    open();
    await expect(pending).rejects.toThrow("the run is over");
    await drained;
    expect(boxd.log).toContain("delete m1");
  });

  test("a parked machine goes to the next acquire of its size, and other sizes retire it", async () => {
    const boxd = new FakeBoxd();
    const pool = createPool(boxd, options());
    const w = await pool.acquire();
    pool.park(w);
    expect((await pool.acquire()).id).toBe(w.id);
    pool.park(w);
    await pool.acquire(8);
    expect(boxd.log).toContain("delete m1");
    expect(pool.machines()).toBe(2);
  });
});
