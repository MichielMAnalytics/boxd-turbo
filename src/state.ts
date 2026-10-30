// Where boxd-ci's files live on the server, relative to its state folder:
//
//   server.json                       the cache URL and token
//   repos/<repo>.json                 a repository's snapshot record
//   runs/<repo>/<run>.json            a run: its tasks, times, machines
//   runs/<repo>/<run>.logs.json       the end of every task's log
//   runs/<repo>/durations.json        each task's last time, for the next run's order and packing

import { repoSlug } from "./boxd/snapshot.js";
import type { Store } from "./boxd/store.js";

export const paths = {
  repo: (repo: string) => `repos/${repoSlug(repo)}.json`,
  runs: (repo: string) => `runs/${repoSlug(repo)}`,
  run: (repo: string, id: string) => `runs/${repoSlug(repo)}/${id}.json`,
  logs: (repo: string, id: string) => `runs/${repoSlug(repo)}/${id}.logs.json`,
  durations: (repo: string) => `runs/${repoSlug(repo)}/durations.json`,
};

export async function readJson<T>(store: Store, path: string): Promise<T | null> {
  const text = await store.read(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export const writeJson = (store: Store, path: string, value: unknown) =>
  store.write(path, `${JSON.stringify(value, null, 2)}\n`);
