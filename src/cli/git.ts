// The local repository: where it lives, where it comes from, and the working copy as a patch.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: env ?? process.env,
  }).trim();

const tryGit = (cwd: string, args: string[]): string | undefined => {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
};

/**
 * owner/name and an HTTPS clone URL, from an HTTPS or SSH remote on github.com. Another host is
 * refused here, before your GitHub token could be sent to it.
 */
export function parseRemote(url: string): { repo: string; cloneUrl: string } {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m || !url.includes(m[1] as string) || !(m[1] as string).includes(".")) {
    throw new Error(`cannot read owner/name from the remote ${url}`);
  }
  const [, host, owner, name] = m as unknown as [string, string, string, string];
  if (host.toLowerCase() !== "github.com") {
    throw new Error(`boxd CI runs repositories on github.com, and origin is on ${host}`);
  }
  return { repo: `${owner}/${name}`, cloneUrl: `https://github.com/${owner}/${name}.git` };
}

export function repoRoot(cwd: string): string {
  const root = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) throw new Error("not inside a git repository");
  return root;
}

export function originUrl(root: string): string {
  const url = tryGit(root, ["remote", "get-url", "origin"]);
  if (!url)
    throw new Error("this repository has no remote named origin, and boxd-ci builds its snapshot by cloning it");
  return url;
}

export function defaultBranch(root: string): string {
  const local = tryGit(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (local) return local.replace(/^origin\//, "");
  const remote = tryGit(root, ["ls-remote", "--symref", "origin", "HEAD"]);
  const m = remote && /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(remote);
  return m?.[1] ?? "main";
}

/** The commit a branch points to on origin (asks the remote). */
export function remoteHead(root: string, branch: string): string {
  const line = tryGit(root, ["ls-remote", "origin", `refs/heads/${branch}`]);
  const sha = line?.split(/\s+/)[0];
  if (!sha) throw new Error(`origin has no branch ${branch}`);
  return sha;
}

export const currentBranch = (root: string): string =>
  tryGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]) ?? tryGit(root, ["rev-parse", "--short", "HEAD"]) ?? "HEAD";

/** Makes sure the local clone has a commit, fetching it from origin when it does not. */
export function ensureCommit(root: string, sha: string): void {
  if (tryGit(root, ["cat-file", "-e", `${sha}^{commit}`]) !== undefined) return;
  tryGit(root, ["fetch", "-q", "origin", sha]);
  if (tryGit(root, ["cat-file", "-e", `${sha}^{commit}`]) === undefined) {
    throw new Error(
      `your clone does not have ${sha.slice(0, 7)}, the snapshot's commit, and fetching it failed. Run git fetch.`,
    );
  }
}

/**
 * The working copy (tracked changes, deletions, and untracked files that are not ignored) as one
 * binary patch against `base`. Built in a copy of the index, so what you staged stays as it was.
 */
export function makePatch(root: string, base: string): Buffer {
  const index = resolve(root, git(root, ["rev-parse", "--git-path", "index"]));
  const tmp = join(tmpdir(), `boxd-ci-index-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    if (existsSync(index)) copyFileSync(index, tmp);
    const env = { ...process.env, GIT_INDEX_FILE: tmp };
    execFileSync("git", ["add", "-A"], { cwd: root, env, stdio: "ignore" });
    return execFileSync("git", ["diff", "--binary", "--cached", base], {
      cwd: root,
      env,
      maxBuffer: 1024 * 1024 * 1024,
    });
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Whether git can read the repository with no credentials at all (a public repository). */
export function anonymousRead(url: string): boolean {
  try {
    execFileSync("git", ["-c", "credential.helper=", "ls-remote", "--exit-code", url, "HEAD"], {
      stdio: "ignore",
      timeout: 20_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", SSH_ASKPASS: "true" },
    });
    return true;
  } catch {
    return false;
  }
}

/** A GitHub token for cloning a private repository into the snapshot: the gh CLI's, when signed in. */
export function githubToken(): string | undefined {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return (
      execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() ||
      undefined
    );
  } catch {
    return undefined;
  }
}

/** Every turbo.json in the repository (the root's and the packages'), relative to the root. */
export const turboFiles = (root: string): string[] =>
  (
    tryGit(root, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "turbo.json",
      "turbo.jsonc",
      "**/turbo.json",
      "**/turbo.jsonc",
    ]) ?? ""
  )
    .split("\n")
    .filter(Boolean);
