// Packing: short tasks share a machine, so a monorepo does not start a machine per few-second task.

import type { TaskNode } from "./graph.js";

/**
 * Splits ready tasks, given in the order they should start, into groups that each run on one
 * machine. A task whose last duration is known and under `packSeconds` joins a group of short tasks
 * until the group's total would pass `packSeconds`; every other task (long, or never seen before)
 * runs alone. Tasks that ask for different CPUs never share a group. Groups keep the order of their
 * first task.
 */
export function pack(ready: TaskNode[], durations: Record<string, number>, packSeconds: number): TaskNode[][] {
  const groups: TaskNode[][] = [];
  const open = new Map<number, { tasks: TaskNode[]; seconds: number }>();
  for (const task of ready) {
    const d = durations[task.id];
    if (packSeconds <= 0 || d === undefined || d >= packSeconds) {
      groups.push([task]);
      continue;
    }
    const key = task.cpus ?? 0;
    const current = open.get(key);
    if (current && current.seconds + d <= packSeconds) {
      current.tasks.push(task);
      current.seconds += d;
    } else {
      const fresh = { tasks: [task], seconds: d };
      open.set(key, fresh);
      groups.push(fresh.tasks);
    }
  }
  return groups;
}
