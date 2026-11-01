// Where boxd-turbo's files live on the server, relative to its state folder:
//
//   server.json                       the cache URL and token
//   repos/<repo>.json                 a repository's snapshot record
//   runs/<repo>/<run>.json            a run: its tasks, times, machines
//   runs/<repo>/<run>.logs.json       the end of every task's log
//   runs/<repo>/durations.json        each task's last time, for the next run's order and packing

import { repoSlug } from "./boxd/snapshot.js";
import type { Store } from "./boxd/store.js";
import type { RunRecord } from "./core/record.js";

export const paths = {
  repo: (repo: string) => `repos/${repoSlug(repo)}.json`,
  runs: (repo: string) => `runs/${repoSlug(repo)}`,
  run: (repo: string, id: string) => `runs/${repoSlug(repo)}/${id}.json`,
  logs: (repo: string, id: string) => `runs/${repoSlug(repo)}/${id}.logs.json`,
  durations: (repo: string) => `runs/${repoSlug(repo)}/durations.json`,
};

/** The file's JSON, or null when there is none. A damaged file is an error: it never reads as missing. */
export async function readJson<T>(store: Store, path: string): Promise<T | null> {
  const text = await store.read(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${path} is not valid JSON. Fix or delete it on the server.`);
  }
}

export const writeJson = (store: Store, path: string, value: unknown) =>
  store.write(path, `${JSON.stringify(value, null, 2)}\n`);

/** A run's record file, by its id: 20261030-101503-a1b2c3d.json. */
export const RUN_FILE = /^\d{8}-\d{6}-[0-9a-f]+\.json$/;

/** The push runs still marked running, in every repository (the latest 50 of each), with their files. */
export async function runningPushRuns(store: Store): Promise<{ path: string; record: RunRecord }[]> {
  const found: { path: string; record: RunRecord }[] = [];
  for (const dir of await store.list("runs")) {
    const files = (await store.list(`runs/${dir}`))
      .filter((n) => RUN_FILE.test(n))
      .slice(-50)
      .map((n) => `runs/${dir}/${n}`);
    for (const [i, text] of (await store.readMany(files)).entries()) {
      try {
        const record = JSON.parse(text ?? "") as RunRecord;
        if (record.status === "running" && record.trigger === "push") found.push({ path: files[i] as string, record });
      } catch {
        // A file being written right now: not a run to act on.
      }
    }
  }
  return found;
}
