// The scheduler: start every task as soon as everything it depends on is done, each group of tasks
// on its own machine, the most urgent first, never more than `maxWorkers` machines at once.
//
// A machine that finishes its tasks takes the next ready group (same CPU size) instead of a new
// machine starting. A failed task's machine is released as failed (the pool keeps it for
// debugging); everything that depends on a failed task is skipped; the run always finishes.

import { priorities, type TaskGraph, type TaskNode, topoOrder } from "./graph.js";
import { pack } from "./pack.js";

export type TaskStatus = "ran" | "restored" | "failed" | "skipped";

export type TaskResult = {
  id: string;
  status: TaskStatus;
  seconds: number;
  /** The end of the task's output, or why it did not run. */
  logTail: string;
  /** The machine it ran on. */
  machine?: string;
  /** When its group started, in seconds from the start of the run. */
  at?: number;
};

export interface Worker {
  readonly id: string;
  run(tasks: TaskNode[]): Promise<TaskResult[]>;
  release(opts: { failed: boolean }): Promise<void>;
}

export interface WorkerPool {
  /** A machine ready to run tasks, of the given CPU count (undefined: the default size). */
  acquire(cpus?: number): Promise<Worker>;
}

export type SchedulerEvent =
  | { type: "start"; tasks: string[]; worker: string }
  | { type: "done"; result: TaskResult }
  | { type: "skip"; id: string; because: string };

export type ScheduleOptions = {
  maxWorkers: number;
  packSeconds: number;
  /** Seconds each task took last time, by task id. */
  durations: Record<string, number>;
  signal?: AbortSignal;
  onEvent?: (e: SchedulerEvent) => void;
};

export function schedule(g: TaskGraph, pool: WorkerPool, o: ScheduleOptions): Promise<TaskResult[]> {
  const prio = priorities(g, o.durations);
  const results = new Map<string, TaskResult>();
  const ok = new Set<string>(); // ran, restored, or nothing to run
  const cause = new Map<string, string>(); // failed or skipped task -> the failed task behind it
  const pending = new Set<string>();
  const started = new Set<string>();

  for (const n of g.nodes.values()) {
    if (n.cached) {
      results.set(n.id, { id: n.id, status: "restored", seconds: 0, logTail: "" });
      ok.add(n.id);
    } else if (n.noop) ok.add(n.id);
    else pending.add(n.id);
  }

  const idle: Worker[] = [];
  const busy = new Set<Worker>();
  const sizeOf = new Map<Worker, number>();
  const acquiring = new Set<Promise<unknown>>();
  const releasing: Promise<void>[] = [];
  let held = 0; // machines acquired or being acquired, not yet released
  let finished = false;

  const release = (w: Worker, failed: boolean) => {
    held--;
    releasing.push(w.release({ failed }).catch(() => {}));
  };

  return new Promise<TaskResult[]>((resolve, reject) => {
    const settle = async (error?: Error) => {
      if (finished) return;
      finished = true;
      await Promise.allSettled([...acquiring]);
      for (const w of idle.splice(0)) release(w, false);
      for (const w of busy) release(w, false);
      busy.clear();
      await Promise.all(releasing);
      if (error) reject(error);
      else resolve(topoOrder(g).flatMap((n) => results.get(n.id) ?? []));
    };

    const record = (r: TaskResult) => {
      results.set(r.id, r);
      pending.delete(r.id);
      if (r.status === "failed") cause.set(r.id, r.id);
      else ok.add(r.id);
      o.onEvent?.({ type: "done", result: r });
    };

    const skipBlocked = () => {
      let changed = true;
      while (changed) {
        changed = false;
        for (const id of pending) {
          if (started.has(id)) continue;
          const node = g.nodes.get(id) as TaskNode;
          const bad = node.deps.find((d) => cause.has(d));
          if (bad === undefined) continue;
          const because = cause.get(bad) as string;
          results.set(id, { id, status: "skipped", seconds: 0, logTail: `skipped: ${because} failed` });
          cause.set(id, because);
          pending.delete(id);
          o.onEvent?.({ type: "skip", id, because });
          changed = true;
        }
      }
    };

    const launch = async (group: TaskNode[], reuse: Worker | undefined) => {
      const size = group[0]?.cpus ?? 0;
      let worker = reuse;
      if (!worker) {
        const p = pool.acquire(group[0]?.cpus);
        acquiring.add(p);
        try {
          worker = await p;
          sizeOf.set(worker, size);
        } catch (e) {
          held--;
          const why = `could not start a machine: ${e instanceof Error ? e.message : String(e)}`;
          for (const n of group) record({ id: n.id, status: "failed", seconds: 0, logTail: why });
          return step();
        } finally {
          acquiring.delete(p);
        }
      }
      if (finished) {
        release(worker, false);
        return;
      }
      busy.add(worker);
      o.onEvent?.({ type: "start", tasks: group.map((n) => n.id), worker: worker.id });
      let out: TaskResult[];
      try {
        out = await worker.run(group);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        out = group.map((n) => ({
          id: n.id,
          status: "failed" as const,
          seconds: 0,
          logTail: why,
          machine: worker?.id ?? "",
        }));
      }
      if (finished) return;
      busy.delete(worker);
      const byId = new Map(out.map((r) => [r.id, r]));
      for (const n of group) {
        record(
          byId.get(n.id) ?? {
            id: n.id,
            status: "failed",
            seconds: 0,
            logTail: "the machine reported no result for this task",
          },
        );
      }
      if (group.some((n) => results.get(n.id)?.status === "failed")) release(worker, true);
      else idle.push(worker);
      step();
    };

    const step = () => {
      if (finished) return;
      skipBlocked();
      const ready = [...pending]
        .filter((id) => !started.has(id) && (g.nodes.get(id) as TaskNode).deps.every((d) => ok.has(d)))
        .map((id) => g.nodes.get(id) as TaskNode)
        .sort((a, b) => (prio.get(b.id) ?? 0) - (prio.get(a.id) ?? 0) || (a.id < b.id ? -1 : 1));
      for (const group of pack(ready, o.durations, o.packSeconds)) {
        const size = group[0]?.cpus ?? 0;
        const i = idle.findIndex((w) => sizeOf.get(w) === size);
        let reuse: Worker | undefined;
        if (i >= 0) reuse = idle.splice(i, 1)[0];
        else if (held < o.maxWorkers) held++;
        else if (idle.length > 0) {
          // The cap is reached and only machines of another size are idle: one gives up its slot.
          release(idle.shift() as Worker, false);
          held++;
        } else continue; // every machine is busy; this group waits for the next to finish
        for (const n of group) started.add(n.id);
        void launch(group, reuse);
      }
      // Machines nobody will need again: fewer tasks are waiting than machines are idle.
      const waiting = [...pending].filter((id) => !started.has(id)).length;
      while (idle.length > waiting) release(idle.pop() as Worker, false);
      if (pending.size === 0) void settle();
    };

    if (o.signal?.aborted) return void settle(new Error("aborted"));
    o.signal?.addEventListener("abort", () => void settle(new Error("aborted")), { once: true });
    step();
  });
}
