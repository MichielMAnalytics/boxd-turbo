// Snapshots: a machine with the repository checked out, its dependencies installed and every ci task
// built once. Every task machine starts from one, so no task installs anything.
//
// Every snapshot is named after its commit. A green run on the default branch saves the next one and
// switches the record to it; the one before is retired and deleted six hours later, after any run that
// was still restoring from it. A commit that changes the dependency files gets its own snapshot, keyed
// by those files, so only that change pays an install.

import { createHash } from "node:crypto";
import { commit, fetchScript, q } from "./scripts.js";
import type { BoxdLike, ExecOutput } from "./sdk.js";
import type { BoxWorker } from "./worker.js";

export type RepoRecord = {
  version: 1;
  /** owner/name: the cache namespace and the folder of its runs. */
  repo: string;
  cloneUrl: string;
  defaultBranch: string;
  /** The repository inside the snapshot. */
  workdir: string;
  /** The one runs restore from. */
  snapshot: string;
  /** Snapshots runs used before, with when they were replaced: deleted once no run can need them. */
  retired?: { name: string; at: string }[];
  /** Its commit. */
  commit: string;
  /** Of the dependency files at that commit (see depsHashScript). */
  depsHash: string;
  /** Its machine size: task machines asking for another one are resized. */
  cpus: number;
  builtAt: string;
};

export type SnapshotBoxd = {
  machines: Pick<BoxdLike["machines"], "create" | "waitUntilReady" | "exec" | "delete" | "files">;
  snapshots: Pick<BoxdLike["snapshots"], "create" | "get">;
};

/** A snapshot retired this long ago has no run left restoring from it (machines live at most an hour per group). */
export const RETIRED_KEEP_MS = 6 * 3600_000;

/** The files that decide what `install` produces. A change to any of them means a fresh install. */
export const DEPENDENCY_FILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  ".yarnrc.yml",
  "bun.lock",
  "bun.lockb",
  ".npmrc",
  ".nvmrc",
  ".node-version",
];

const MEMORY: Record<number, string> = { 1: "4G", 2: "8G", 4: "16G", 8: "32G" };
export const PLANNER_PATH = "/tmp/boxd-ci-planner.mjs";
const BUILDER_SECONDS = 7200;

/**
 * A repository's short name in boxd: lowercase, dashes, at most 40 characters. A name that has to be
 * shortened keeps a hash of the full one, so two long names never share a snapshot or a cache.
 */
export function repoSlug(repo: string): string {
  const slug = repo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= 40) return slug;
  const hash = createHash("sha256").update(repo.toLowerCase()).digest("hex").slice(0, 6);
  return `${slug.slice(0, 33).replace(/-+$/, "")}-${hash}`;
}

export const snapshotName = (repo: string, sha: string) => `bci-${repoSlug(repo)}-${commit(sha).slice(0, 7)}`;
export const depsSnapshotName = (repo: string, depsHash: string) =>
  `bci-${repoSlug(repo)}-deps-${depsHash.slice(0, 10)}`;
export const workdirFor = (repo: string) => `/home/boxd/work/${repo.split("/").pop()}`;

/** Prints 16 hex characters that change exactly when a dependency file or the patches folder does. */
export function depsHashScript(workdir: string): string {
  const files = DEPENDENCY_FILES.map(q).join(" ");
  return `cd ${q(workdir)} && { for f in ${files}; do if [ -f "$f" ]; then sha256sum "$f"; else echo "- $f"; fi; done; if [ -d patches ]; then find patches -type f | LC_ALL=C sort | xargs sha256sum; fi; } | sha256sum | cut -c1-16`;
}

/**
 * Installs exactly what the lockfile says, with the repository's package manager (corepack follows
 * its `packageManager` field) on the Node.js version its .nvmrc or .node-version asks for.
 */
export function installScript(workdir: string): string {
  return `set -eo pipefail
cd ${q(workdir)}
export CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
want=""
if [ -f .nvmrc ]; then want=$(tr -d ' \\r\\n' < .nvmrc); elif [ -f .node-version ]; then want=$(tr -d ' \\r\\n' < .node-version); fi
want=\${want#v}
if [ -n "$want" ] && ! node --version | grep -q "^v$want"; then
  . "$HOME/.nvm/nvm.sh"
  nvm install "$want" >/dev/null
  dir=$(dirname "$(nvm which "$want")")
  for b in node npm npx corepack; do sudo ln -sf "$dir/$b" "/usr/local/bin/$b"; done
fi
sudo corepack enable --install-directory /usr/local/bin || true
if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile
elif [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile
elif [ -f yarn.lock ] && [ -f .yarnrc.yml ]; then yarn install --immutable
elif [ -f yarn.lock ]; then yarn install --frozen-lockfile
elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci --no-audit --no-fund
else npm install --no-audit --no-fund
fi`;
}

/** A full clone (later fetches are then small), checked out at the commit. */
export function cloneScript(cloneUrl: string, workdir: string, sha: string): string {
  commit(sha);
  const auth = `-c http.extraheader="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$BOXD_CI_FETCH_TOKEN" | base64 -w0)"`;
  return `set -eo pipefail
rm -rf ${q(workdir)} && mkdir -p "$(dirname ${q(workdir)})"
if [ -n "$BOXD_CI_FETCH_TOKEN" ]; then git ${auth} clone -q ${q(cloneUrl)} ${q(workdir)}; else git clone -q ${q(cloneUrl)} ${q(workdir)}; fi
cd ${q(workdir)} && git checkout -q -f ${sha}`;
}

/**
 * Runs every ci task once, filling the remote cache and the snapshot's local one, so the first runs
 * restore instead of build. Best effort: a failing task here only means less is cached.
 */
export function warmScript(workdir: string, selectors: string[]): string {
  return `cd ${q(workdir)} && ./node_modules/.bin/turbo run ${selectors.map(q).join(" ")} --cache=local:rw,remote:rw --continue > /tmp/boxd-ci-warm.log 2>&1; tail -n 5 /tmp/boxd-ci-warm.log; exit 0`;
}

/** Saves the machine as a new version of `name` and waits until machines can restore from it. */
export async function saveSnapshot(
  boxd: Pick<SnapshotBoxd, "snapshots">,
  machineId: string,
  name: string,
  o: { org?: string; pollMs?: number; timeoutMs?: number } = {},
): Promise<number> {
  const { version } = await boxd.snapshots.create(machineId, name);
  const deadline = Date.now() + (o.timeoutMs ?? 30 * 60_000);
  for (;;) {
    const s = await boxd.snapshots.get(name, o.org ? { org: o.org } : undefined);
    if (s.status === "failed") throw new Error(`snapshot ${name} failed`);
    if (s.status === "ready" && (s.version ?? 0) >= version) return s.version ?? version;
    if (Date.now() > deadline)
      throw new Error(
        `snapshot ${name} was not ready after ${Math.round((o.timeoutMs ?? 1_800_000) / 60_000)} minutes`,
      );
    await new Promise((r) => setTimeout(r, o.pollMs ?? 2000));
  }
}

const tail = (out: ExecOutput) => `${out.stderr}\n${out.stdout}`.trim().slice(-3000) || `exit code ${out.exitCode}`;

/** A builder machine for one job, deleted at the end whatever happens. */
async function withBuilder<T>(
  boxd: SnapshotBoxd,
  create: Parameters<SnapshotBoxd["machines"]["create"]>[0],
  job: (
    id: string,
    sh: (what: string, script: string, env?: Record<string, string>) => Promise<ExecOutput>,
  ) => Promise<T>,
): Promise<T> {
  const m = boxd.machines;
  const { id } = await m.create(create);
  try {
    await m.waitUntilReady(id, { timeout: 180_000 });
    const sh = async (what: string, script: string, env?: Record<string, string>) => {
      const out = await m.exec(id, { command: ["bash", "-c", script], ...(env ? { env } : {}), timeout: 60 * 60_000 });
      if (out.exitCode !== 0) throw new Error(`${what} failed: ${tail(out)}`);
      return out;
    };
    return await job(id, sh);
  } finally {
    await m.delete(id).catch(() => {});
  }
}

export type BuildOptions = {
  org?: string;
  repo: { repo: string; cloneUrl: string; defaultBranch: string };
  sha: string;
  /** Reads a private repository. Reaches the clone command only. */
  fetchToken?: string;
  /** The remote cache settings and CI=1, for the warm run. */
  env: Record<string, string>;
  /** The ci tasks to build once. Without them, the planner (this bundle) finds them on the builder. */
  selectors?: string[];
  plannerBundle?: Uint8Array;
  cpus?: number;
  pollMs?: number;
  onProgress?: (line: string) => void;
};

/** The first snapshot of a repository, from its default branch. */
export async function buildSnapshot(boxd: SnapshotBoxd, o: BuildOptions): Promise<RepoRecord> {
  const say = o.onProgress ?? (() => {});
  const cpus = o.cpus ?? 2;
  const target = snapshotName(o.repo.repo, o.sha);
  const workdir = workdirFor(o.repo.repo);
  const name = `bci-${repoSlug(o.repo.repo).slice(0, 30)}-build-${Math.random().toString(36).slice(2, 6)}`;
  return withBuilder(
    boxd,
    {
      name,
      ...(o.org ? { org: o.org } : {}),
      config: { vcpu: cpus, memory: MEMORY[cpus] ?? "8G", autoSuspendTimeout: 0 },
      isolated: true,
      deleteAfter: BUILDER_SECONDS,
      labels: { "boxd-ci": "builder" },
    },
    async (id, sh) => {
      say(`cloning ${o.repo.repo} at ${o.sha.slice(0, 7)}`);
      await sh(
        "cloning the repository",
        cloneScript(o.repo.cloneUrl, workdir, o.sha),
        o.fetchToken ? { BOXD_CI_FETCH_TOKEN: o.fetchToken } : undefined,
      );
      say("installing dependencies");
      await sh("installing dependencies", installScript(workdir));
      const depsHash = (await sh("hashing the dependency files", depsHashScript(workdir))).stdout.trim();
      let selectors = o.selectors ?? [];
      if (!o.selectors && o.plannerBundle) {
        await boxd.machines.files.upload(id, PLANNER_PATH, o.plannerBundle);
        const out = await boxd.machines.exec(id, {
          command: ["bash", "-c", `cd ${q(workdir)} && node ${PLANNER_PATH} .`],
          env: o.env,
          timeout: 15 * 60_000,
        });
        try {
          selectors =
            (JSON.parse(out.stdout) as { selectors?: { selector: string }[] }).selectors?.map((x) => x.selector) ?? [];
        } catch {
          say(`the planner could not read the ci tasks: ${tail(out)}`);
        }
      }
      if (selectors.length) {
        say(`running the ${selectors.length} ci tasks once, to fill the cache`);
        await sh("the warm-up run", warmScript(workdir, selectors), o.env);
      } else if (!o.selectors) say("no task on the default branch is tagged ci yet, so nothing is built ahead");
      say(`saving the snapshot ${target}`);
      await saveSnapshot(boxd, id, target, {
        ...(o.org ? { org: o.org } : {}),
        ...(o.pollMs ? { pollMs: o.pollMs } : {}),
      });
      return {
        version: 1,
        repo: o.repo.repo,
        cloneUrl: o.repo.cloneUrl,
        defaultBranch: o.repo.defaultBranch,
        workdir,
        snapshot: target,
        commit: o.sha,
        depsHash,
        cpus,
        builtAt: new Date().toISOString(),
      } satisfies RepoRecord;
    },
  );
}

export type PromoteOptions = {
  org?: string;
  record: RepoRecord;
  sha: string;
  fetchToken?: string;
  env: Record<string, string>;
  selectors: string[];
  pollMs?: number;
  onProgress?: (line: string) => void;
};

/**
 * The next snapshot, from a green commit on the default branch: restore the current one, check out
 * the commit, install if the dependency files changed, warm, save under the other name. Returns the
 * new record, or null when the commit is older than the snapshot's (pushes can finish out of order).
 */
export async function promote(boxd: SnapshotBoxd, o: PromoteOptions): Promise<RepoRecord | null> {
  const r = o.record;
  const say = o.onProgress ?? (() => {});
  if (o.sha === r.commit) return null;
  const target = snapshotName(r.repo, o.sha);
  const runtime = { ...(o.org ? { org: o.org } : {}), ...(o.pollMs ? { pollMs: o.pollMs } : {}) };
  return withBuilder(
    boxd,
    {
      name: `bci-${repoSlug(r.repo).slice(0, 30)}-next-${Math.random().toString(36).slice(2, 6)}`,
      ...(o.org ? { org: o.org } : {}),
      fromSnapshot: r.snapshot,
      isolated: true,
      deleteAfter: BUILDER_SECONDS,
      labels: { "boxd-ci": "builder" },
    },
    async (id, sh) => {
      await sh(
        "checking out the commit",
        fetchScript(r.workdir, o.sha),
        o.fetchToken ? { BOXD_CI_FETCH_TOKEN: o.fetchToken } : undefined,
      );
      const newer = await sh(
        "comparing commits",
        `cd ${q(r.workdir)} && if git merge-base --is-ancestor ${commit(r.commit)} ${commit(o.sha)}; then echo yes; else echo no; fi`,
      ).catch(() => null);
      if (!newer || newer.stdout.trim() === "no") {
        say(`${o.sha.slice(0, 7)} is older than the snapshot's ${r.commit.slice(0, 7)}, so the snapshot stays`);
        return null;
      }
      const depsHash = (await sh("hashing the dependency files", depsHashScript(r.workdir))).stdout.trim();
      if (depsHash !== r.depsHash) {
        say("the dependency files changed, installing them");
        await sh("installing dependencies", installScript(r.workdir));
      }
      await sh("the warm-up run", warmScript(r.workdir, o.selectors), o.env);
      say(`saving ${o.sha.slice(0, 7)} as ${target}`);
      await saveSnapshot(boxd, id, target, runtime);
      const now = new Date().toISOString();
      const retired = [...(r.retired ?? []), { name: r.snapshot, at: now }];
      return { ...r, snapshot: target, commit: o.sha, depsHash, builtAt: now, retired };
    },
  );
}

/**
 * For a run whose dependency files differ from its snapshot's: installs on the planner's machine and
 * saves it under a name keyed by those files, so the run's other machines (and the next push with the
 * same files) start installed. Returns the snapshot name.
 */
export async function saveDepsSnapshot(
  boxd: Pick<SnapshotBoxd, "snapshots">,
  worker: BoxWorker,
  o: {
    record: RepoRecord;
    depsHash: string;
    org?: string;
    pollMs?: number;
    /** A working copy (boxd-ci run): taken out before the snapshot is saved, put back after. */
    patch?: { path: string; data: Uint8Array };
  },
): Promise<string> {
  const sh = async (what: string, script: string, timeout?: number) => {
    const out = await worker.sh(script, timeout ? { timeout } : undefined);
    if (out.exitCode !== 0) throw new Error(`${what} failed: ${tail(out)}`);
  };
  await sh("installing the changed dependencies", installScript(o.record.workdir), 60 * 60_000);
  const apply = `cd ${q(o.record.workdir)} && git apply --binary --whitespace=nowarn`;
  // Only the dependencies go into the snapshot: neither your changes nor the patch file that carried them.
  if (o.patch) {
    await sh("taking the working copy out before the snapshot", `${apply} -R ${q(o.patch.path)}`);
    await sh("removing the patch file", `rm -f ${q(o.patch.path)}`);
  }
  const name = depsSnapshotName(o.record.repo, o.depsHash);
  try {
    await saveSnapshot(boxd, worker.machineId, name, {
      ...(o.org ? { org: o.org } : {}),
      ...(o.pollMs ? { pollMs: o.pollMs } : {}),
    });
  } finally {
    if (o.patch) {
      await worker.upload(o.patch.path, o.patch.data);
      await sh("putting the working copy back", `${apply} ${q(o.patch.path)}`);
    }
  }
  return name;
}

/** Whether a snapshot exists and machines can restore from it. */
export async function snapshotReady(boxd: Pick<SnapshotBoxd, "snapshots">, name: string, org?: string) {
  return boxd.snapshots
    .get(name, org ? { org } : undefined)
    .then((s) => s.status === "ready" && s.version !== null)
    .catch(() => false);
}

/** Deletes the retired snapshots no run can still be restoring from, and returns the record without them. */
export async function pruneSnapshots(
  boxd: { snapshots: Pick<BoxdLike["snapshots"], "delete"> },
  r: RepoRecord,
  o: { org?: string; now?: number } = {},
): Promise<RepoRecord> {
  const now = o.now ?? Date.now();
  const keep: NonNullable<RepoRecord["retired"]> = [];
  for (const old of r.retired ?? []) {
    if (old.name === r.snapshot || now - Date.parse(old.at) < RETIRED_KEEP_MS) keep.push(old);
    else await boxd.snapshots.delete(old.name, o.org ? { org: o.org } : undefined).catch(() => {});
  }
  return { ...r, retired: keep };
}
