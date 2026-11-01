// Machines for a run: each one restored from the repository's snapshot, isolated, checked out at the
// run's commit, then handed to the scheduler to run task groups through Turborepo.
//
// Every machine is born with a delete-after timer, so a controller that dies mid-run leaks nothing
// for longer than an hour. A machine whose tasks passed is deleted. One with a failed task is
// hibernated (disk only) and kept for a day, so `boxd connect` lands where the task left off; a run
// keeps at most three.

import type { TaskNode } from "../core/graph.js";
import type { TaskResult, Worker, WorkerPool } from "../core/scheduler.js";
import {
  applyPatchScript,
  checkoutScript,
  cleanOutputsScript,
  fetchScript,
  parseRunOutput,
  turboRunScript,
} from "./scripts.js";
import { type BoxdLike, type ExecOutput, isolatedShape } from "./sdk.js";

/** The part of the boxd SDK a pool uses. */
export type PoolBoxd = {
  machines: Pick<
    BoxdLike["machines"],
    | "create"
    | "waitUntilReady"
    | "exec"
    | "resize"
    | "hibernate"
    | "setAutoHibernateTimeout"
    | "delete"
    | "setDeleteAfter"
    | "files"
  >;
};

export type PrepareSpec =
  /**
   * Check out a pushed commit. The token (a GitHub App installation token) reads private
   * repositories; a function is asked again for every machine, since such tokens expire in an hour.
   */
  | { kind: "commit"; sha: string; fetchToken?: string | (() => Promise<string>) }
  /** Apply a working copy on top of a commit the snapshot already has (`boxd-turbo run`). */
  | { kind: "patch"; base: string; patch: Uint8Array };

export type PoolOptions = {
  snapshot: string;
  org?: string;
  /** The snapshot's vCPUs. A task asking for another size gets its machine resized. */
  baseCpus: number;
  /** The repository inside the snapshot. */
  workdir: string;
  prepare: PrepareSpec;
  /** For every Turborepo run: the remote cache settings and CI=1. */
  env: Record<string, string>;
  runId: string;
  /** The repository's short name, a label on every machine (`boxd-turbo doctor --sweep` reads it). */
  repo?: string;
  /** Names of boxd secrets every machine gets (unattached secrets reach only machines that name them). */
  secrets?: string[];
  /** How often the timers of live machines are set again, so one idling for its next task lives on. */
  rearmMs?: number;
  /** What a group deletes before it runs. Default: the group's own declared outputs. */
  outputsOf?: (tasks: TaskNode[]) => { dir: string; globs: string[] }[];
  /** How long one group may run. Default 45 minutes. */
  groupTimeoutMs?: number;
  /** The clock (tests replace it). */
  now?: () => number;
  /** Waits before each new try at starting a machine. Default 2 s, then 5 s. */
  retryDelaysMs?: number[];
};

export type BoxWorker = Worker & {
  /** The machine's boxd id. */
  readonly machineId: string;
  readonly cpus: number;
  /** Runs a bash script on the machine. */
  sh(script: string, o?: { env?: Record<string, string>; timeout?: number }): Promise<ExecOutput>;
  upload(path: string, data: Uint8Array): Promise<void>;
};

/** A {@link WorkerPool} of boxd machines. */
export type Pool = {
  acquire(cpus?: number): Promise<BoxWorker>;
  /**
   * Where machines started from now on restore from (a run whose dependencies changed). `checkedOut`:
   * the snapshot was saved at the run's commit, so its machines check it out without a fetch, and no
   * token reaches them.
   */
  setSnapshot(name: string, o?: { checkedOut?: boolean }): void;
  /** Hands a ready machine to the next acquire of its size (the planner's machine, for one). */
  park(w: BoxWorker): void;
  /** Deletes every machine that is still running. Afterwards acquire fails. */
  drain(): Promise<void>;
  /** How many machines this run has started. */
  machines(): number;
  /** The machines kept for debugging, by name. */
  kept(): string[];
  /** Seconds the run's machines were up, by vCPU count: what the run costs. */
  machineSeconds(): Record<string, number>;
};

/** A machine lives at most this long after its last group started, whatever happens to the controller. */
export const SAFETY_SECONDS = 3600;
/** How long a machine with a failed task is kept. */
export const KEEP_FAILED_SECONDS = 86_400;
/** How many failed machines one run keeps; the others are deleted (their logs are in the run). */
export const KEEP_FAILED_MAX = 3;
export const PATCH_PATH = "/tmp/boxd-turbo.patch";
/** A restore from a large snapshot can take longer than the SDK's 90-second default. */
const READY_MS = 180_000;
const MEMORY: Record<number, string> = { 1: "4G", 2: "8G", 4: "16G", 8: "32G" };

const randomTag = () => Math.random().toString(36).slice(2, 6).padEnd(4, "0");

export function createPool(boxd: PoolBoxd, o: PoolOptions): Pool {
  const m = boxd.machines;
  const prefix = `bt-${o.runId.split("-").at(-1)?.slice(0, 7) ?? "run"}-${randomTag()}`;
  const live = new Map<string, BoxWorker>(); // by machine id
  const parked: BoxWorker[] = [];
  const keptNames: string[] = [];
  let created = 0;
  let named = 0;
  let snapshot = o.snapshot;
  let checkedOut = false;
  let closed = false;
  const now = o.now ?? Date.now;
  const born = new Map<string, { at: number; cpus: number }>(); // machine id → when it was asked for
  const seconds: Record<string, number> = {};
  /** The machine stops costing compute: deleted, or hibernated for debugging. */
  const ended = (id: string) => {
    const b = born.get(id);
    if (!b) return;
    born.delete(id);
    seconds[b.cpus] = Math.round(((seconds[b.cpus] ?? 0) + (now() - b.at) / 1000) * 10) / 10;
  };
  const outputsOf = o.outputsOf ?? ((tasks: TaskNode[]) => tasks.map((t) => ({ dir: t.dir, globs: t.outputs })));

  const sh = (id: string, script: string, x: { env?: Record<string, string>; timeout?: number } = {}) =>
    m.exec(id, {
      command: ["bash", "-c", script],
      ...(x.env ? { env: x.env } : {}),
      ...(x.timeout ? { timeout: x.timeout } : {}),
    });

  const remove = async (id: string) => {
    live.delete(id);
    ended(id);
    await m.delete(id).catch(() => {}); // the delete-after timer is the backstop
  };

  const prepare = async (id: string): Promise<void> => {
    const p = o.prepare;
    let out: ExecOutput;
    if (p.kind === "commit" && checkedOut) {
      out = await sh(id, checkoutScript(o.workdir, p.sha));
    } else if (p.kind === "commit") {
      const token = typeof p.fetchToken === "function" ? await p.fetchToken() : p.fetchToken;
      out = await sh(id, fetchScript(o.workdir, p.sha), token ? { env: { BOXD_TURBO_FETCH_TOKEN: token } } : {});
    } else {
      await m.files.upload(id, PATCH_PATH, p.patch);
      out = await sh(id, applyPatchScript(o.workdir, p.base, PATCH_PATH));
    }
    if (out.exitCode !== 0) {
      const why = `${out.stderr}\n${out.stdout}`.trim().slice(-2000) || `exit code ${out.exitCode}`;
      throw new Error(`checking out the run's code failed: ${why}`);
    }
  };

  const worker = (id: string, name: string, cpus: number): BoxWorker => {
    const w: BoxWorker = {
      id: name,
      machineId: id,
      cpus,
      sh: (script, x) => sh(id, script, x),
      upload: async (path, data) => {
        await m.files.upload(id, path, data);
      },
      async run(tasks: TaskNode[]): Promise<TaskResult[]> {
        const script = `${cleanOutputsScript(o.workdir, outputsOf(tasks))}; ${turboRunScript(o.workdir, tasks)}`;
        try {
          await m.setDeleteAfter(id, SAFETY_SECONDS).catch(() => {}); // the create-time timer still stands
          const out = await sh(id, script, { env: o.env, timeout: o.groupTimeoutMs ?? 45 * 60_000 });
          return parseRunOutput(`${out.stderr}\n${out.stdout}`, tasks, name);
        } catch (e) {
          const why = `the machine did not finish: ${(e as Error).message}`;
          return tasks.map((t) => ({ id: t.id, status: "failed", seconds: 0, logTail: why, machine: name }));
        }
      },
      async release({ failed }) {
        if (!live.has(id)) return;
        if (!failed) return remove(id);
        if (keptNames.length >= KEEP_FAILED_MAX) return remove(id);
        live.delete(id);
        ended(id);
        keptNames.push(name);
        // Connecting wakes it; 15 idle minutes later it goes back to disk instead of running all day.
        await m.setAutoHibernateTimeout(id, 900).catch(() => {});
        await m.hibernate(id).catch(() => {});
        await m.setDeleteAfter(id, KEEP_FAILED_SECONDS).catch(() => {});
      },
    };
    return w;
  };

  const start = async (cpus: number): Promise<BoxWorker> => {
    // A brief API error or a full account should not turn into red tasks: try again, twice.
    const delays = o.retryDelaysMs ?? [2000, 5000];
    let machine: { id: string; name: string } | undefined;
    let name = "";
    let at = 0;
    for (let attempt = 0; !machine; attempt++) {
      named += 1;
      name = `${prefix}-${named}`;
      at = now();
      try {
        machine = await m.create({
          name,
          ...(o.org ? { org: o.org } : {}),
          fromSnapshot: snapshot,
          deleteAfter: SAFETY_SECONDS,
          ...isolatedShape(
            { "boxd-turbo": "worker", "boxd-turbo/run": o.runId, ...(o.repo ? { "boxd-turbo/repo": o.repo } : {}) },
            o.secrets,
          ),
        });
      } catch (e) {
        if (closed || attempt >= delays.length) throw e;
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
    created += 1;
    const w = worker(machine.id, name, cpus);
    live.set(machine.id, w);
    born.set(machine.id, { at, cpus });
    try {
      if (closed) throw new Error("the run is over");
      await m.waitUntilReady(machine.id, { timeout: READY_MS });
      if (cpus !== o.baseCpus) {
        await m.resize(machine.id, { vcpu: cpus, memory: MEMORY[cpus] ?? "8G" });
        await m.waitUntilReady(machine.id, { timeout: READY_MS });
      }
      await prepare(machine.id);
      if (closed) throw new Error("the run is over");
      return w;
    } catch (e) {
      await remove(machine.id);
      throw e;
    }
  };

  // A machine idling while a long task elsewhere finishes would outlive its create-time timer.
  const rearm = setInterval(
    () => {
      for (const id of live.keys()) void m.setDeleteAfter(id, SAFETY_SECONDS).catch(() => {});
    },
    o.rearmMs ?? 10 * 60_000,
  );
  rearm.unref?.();

  return {
    async acquire(cpus?: number) {
      if (closed) throw new Error("the run is over");
      const size = cpus ?? o.baseCpus;
      const i = parked.findIndex((w) => w.cpus === size);
      if (i >= 0) return parked.splice(i, 1)[0] as BoxWorker;
      // A parked machine of another size would only idle: retire it so the run stays within its cap.
      for (const w of parked.splice(0)) void w.release({ failed: false });
      return start(size);
    },
    setSnapshot(name, x) {
      snapshot = name;
      checkedOut = x?.checkedOut === true;
    },
    park(w) {
      if (!closed && live.has(w.machineId)) parked.push(w);
    },
    async drain() {
      closed = true;
      clearInterval(rearm);
      parked.length = 0;
      await Promise.all([...live.keys()].map(remove));
    },
    machines: () => created,
    kept: () => [...keptNames],
    machineSeconds: () => ({ ...seconds }),
  };
}
