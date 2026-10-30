---
name: boxd-ci
description: Run CI for a Turborepo monorepo on boxd and read the results with the boxd-ci CLI. Use when asked to run CI or the checks before pushing, to find out why a boxd-ci check is red, to read a failed task's log, or to search past CI logs for an error.
---

# boxd-ci

boxd-ci runs every Turborepo task tagged `ci` on its own boxd machine, restored from a snapshot of the
repository with its dependencies installed. Results come from the Turborepo remote cache whenever a
task's inputs did not change, so a run only executes what your change touched.

Every command takes `--json`. Use it, since that output is stable and made for you. Until boxd-ci is
on npm, run it as `npx github:azin-tech/boxd-ci <command>`. The examples below write `boxd-ci`.

## Check a change before pushing

```bash
boxd-ci run --json
```

This uploads the working copy (tracked changes and new files that git does not ignore) as a patch on
the snapshot's commit and runs the ci tasks. It exits 0 when every task passed, 1 otherwise. The JSON
is the run record:

```json
{
  "id": "20261030-165434-0b8443a",
  "status": "failure",
  "results": [{ "id": "@ai-sdk/mistral#test", "status": "failed", "seconds": 9.1, "logTail": "...", "machine": "bci-0b8443a-0vnu-1" }],
  "machines": 2,
  "error": "only set when the run stopped before its tasks"
}
```

`status` per task is `ran`, `restored` (from the cache), `failed` or `skipped` (a dependency failed).
A failed task's `logTail` is the end of its output. Read it before anything else.

## Read a red run

```bash
boxd-ci ls --json                       # the latest runs, newest first
boxd-ci logs --failed --json            # the latest run, with every failed task's log
boxd-ci logs <run-id> --task <pkg#task> --json
boxd-ci grep "<error text>" --json      # which runs and tasks printed it
```

A run id prefix or its commit's short hash both work as `<run-id>`.

## Get on the machine of a failed task

The machine a task failed on is paused and kept for 24 hours, with the repository as the task left
it. Its name is the task's `machine`:

```bash
boxd machine resume <machine>
boxd machine exec <machine> -- bash -lc 'cd /home/boxd/work/<repo> && <the failing command>'
```

## When something is off

```bash
boxd-ci doctor --json
```

checks the sign-in, the server and its Turborepo cache, the snapshot, the push automation and the
GitHub App. `--sweep` deletes machines that a finished run left behind.

## Rules

- Never paste the cache token or a GitHub token into a task, a log or a commit.
- Fix the failing task, then run `boxd-ci run` again. A run is cheap: unchanged tasks are restored.
- Tasks to run are the ones tagged `ci` in turbo.json (root or package level), as Vercel CI reads them.
