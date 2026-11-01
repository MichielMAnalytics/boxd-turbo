---
name: boxd-turbo
description: Run CI for a Turborepo monorepo on boxd and read the results with the boxd-turbo CLI. Use when asked to run CI or the checks before pushing, to find out why a boxd-turbo check is red, to read a failed task's log, or to search past CI logs for an error.
---

# boxd-turbo

boxd-turbo runs a Turborepo monorepo's CI tasks on boxd machines restored from a snapshot of the
repository with its dependencies installed. Each task starts as soon as its dependencies finish.
Results come from the Turborepo remote cache whenever a task's inputs did not change, so a run only
executes what your change touched.

Every command takes `--json`. Use it, since that output is stable and made for you. Until boxd-turbo is
on npm, run it as `npx github:MichielMAnalytics/boxd-turbo <command>`. The examples below write `boxd-turbo`.

## Check a change before pushing

```bash
boxd-turbo run --json
```

This uploads the working copy (tracked changes and new files that git does not ignore) as a patch on
the snapshot's commit and runs the ci tasks. It exits 0 when every task passed, 1 otherwise. The JSON
is the run record:

```json
{
  "id": "20261030-165434-0b8443a",
  "status": "failure",
  "results": [{ "id": "@ai-sdk/mistral#test", "status": "failed", "seconds": 9.1, "logTail": "...", "machine": "bt-0b8443a-0vnu-1" }],
  "machines": 2,
  "kept": ["bt-0b8443a-0vnu-1"],
  "error": "only set when the run stopped before its tasks"
}
```

`status` per task is `ran`, `restored` (from the cache), `failed` or `skipped` (a dependency failed).
A failed task's `logTail` is the end of its output. Read it before anything else.

## Read a red run

```bash
boxd-turbo ls --json                       # the latest runs, newest first
boxd-turbo logs --failed --json            # the latest run, with every failed task's log
boxd-turbo logs <run-id> --task <pkg#task> --json
boxd-turbo grep "<error text>" --json      # which runs and tasks printed it
```

A run id, the start of one, or its commit's hash (7 to 40 characters) works as `<run-id>`.

## Get on the machine of a failed task

The machine a task failed on is hibernated and kept for 24 hours, with the repository as the task
left it. A run keeps at most three, listed in the run's `kept`. Connecting wakes one:

```bash
boxd machine exec <machine> -- bash -lc 'cd /home/boxd/work/<repo> && <the failing command>'
boxd connect <machine>      # an interactive shell
```

## When something is off

```bash
boxd-turbo doctor --json
```

checks the sign-in, the server and its Turborepo cache, the snapshot, the push automation and the
GitHub App. `--sweep` deletes machines that a finished run left behind.

## Rules

- Never paste the cache token, a GitHub token or a secret's value into a task, a log or a commit.
- Fix the failing task, then run `boxd-turbo run` again. A run is cheap, since unchanged tasks are restored.
- The tasks CI runs are the ones tagged `ci` in turbo.json (root or package level), as Vercel CI reads
  them. A repository with no `ci` tag runs the usual checks its turbo.json defines (lint, type checks,
  tests). `boxd-turbo doctor` says which.
- A task that needs a secret gets it from `boxd-turbo secret set NAME` (the value on stdin), with the name
  in that task's `env` in turbo.json. Ask the person for the value. Never invent one.
