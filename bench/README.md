# Benchmark

Push to green on [`vercel/ai`](https://github.com/vercel/ai) for three kinds of change, on boxd-turbo and
on Vercel CI, with the same commit, the same Turborepo version (2.11.10) and the same tasks: the
`type-check` and `test` tasks of every package, tagged `ci` in each package's `turbo.json` the way
Vercel CI asks for (249 tasks with their builds).

| Scenario | The push changes | What has to run |
|---|---|---|
| docs | `content/docs/00-introduction/index.mdx` | nothing, every result is in the cache |
| leaf | `packages/mistral/src/index.ts` | mistral's build, type-check and test |
| core | `packages/provider-utils/src/index.ts` | most of the repository, since nearly every package depends on provider-utils |

Each push appends a comment with a fresh timestamp to that one file. Per scenario: one warm-up push,
then three measured pushes, one at a time. The time is from the end of `git push` to the result on
GitHub: the `boxd-turbo` check run's `completed_at` for boxd-turbo, Vercel CI's commit status for Vercel CI.
The tables and charts use the median of the three.

## The Vercel CI lane

Vercel CI was measured twice, on 2026-10-29. The first set ran the three scenarios at the same time,
so their pushes overlapped. It had outliers of 251 s (docs), 265 s (leaf) and 385 s (core), and one
core run failed on a flaky test. The second set pushed one commit at a time, the same way the boxd-turbo
lane did, and its rows have the role `isolated`. The tables use that set. Its docs median is 7 s slower
than the first set's, and its leaf and core medians are faster.

Every row of both sets, warm-ups and failures included, is in
[`experiment-2026-10-29/results-all.jsonl`](experiment-2026-10-29/results-all.jsonl), next to the
scripts that made them. `record.py` reads each Vercel CI run with `vercel ci inspect`: its tasks, their
durations and when its bootstrap ended.

## Where the time goes

Each platform's median run per scenario, split at its first task's start and its last task's end:

- Vercel CI, from its run record (`vercel ci inspect`, kept in
  [`experiment-2026-10-29/vercel-inspect/`](experiment-2026-10-29/vercel-inspect)): the end of `git
  push` to the first task's `startedAt`, from there to the last task's `completedAt`, and from there to
  the commit status on GitHub. A run with no task to run ends its first part when its Turborepo job
  completes.
- boxd-turbo, from its run record: the end of `git push` to the run's start (GitHub delivering the push),
  plus the run's start to its first task (restore, check out, plan), then the tasks to the run's end,
  which is when the check completes.

`scripts/charts.ts` computes both from the committed files.

## Files

| File | What it holds |
|---|---|
| `results/boxd-turbo.jsonl` | every boxd-turbo push: scenario, time, result, tasks, machines, machine seconds |
| `results/experiment-2026-10-29.jsonl` | the rows the tables use from the earlier lanes: Vercel CI, and the boxd prototype that ran fixed test shards |
| `results/experiment-2026-10-29-summary.json` | their medians and cost per run (the prototype's at the prices used then) |
| `results/core-run.json` | the run record behind the task-by-task chart |
| `results/demo-run.txt` | the `boxd-turbo run` the animated terminal replays |
| `experiment-2026-10-29/` | the scripts behind the earlier lanes, every row they recorded, and each measured Vercel CI run's record from `vercel ci inspect` |
| `push.ts` | the harness that made `boxd-turbo.jsonl` |

## Cost

boxd-turbo, at boxd's USD list price ($0.047 per vCPU-hour, $0.014 per GiB-hour of RAM in use):

- Every task machine for every second it was up, from the create call to its delete, counted with all
  its RAM in use (4 GiB per vCPU). boxd bills the RAM a machine holds, so this is an upper bound.
- The server machine (2 vCPU, 8 GiB) for the length of the run, plus the 60 seconds it stays awake
  after it.
- Disk ($0.000096 per GiB-hour written) is left out. It comes to under a hundredth of a cent per run.

Vercel CI: $0.0035 per CPU-minute, with tasks at 2 CPUs and bootstrapping at 4 CPUs, from
`vercel ci inspect`.

Between pushes the server sleeps. Asleep it bills the RAM it holds and its disk: about 1.2 GiB here,
about 1.7¢ an hour. After four idle hours boxd moves it to disk, and from then on only its disk bills.
That cost belongs to the account, so the per-run figures leave it out.

## Run it yourself

The benchmark used private copies of `vercel/ai` (`azin-tech/bench-ai` for boxd-turbo,
`azin-tech/vbench-ai` for Vercel CI). Your own fork works the same way:

```bash
gh repo fork vercel/ai --clone   # then tag type-check and test with ci, push, and run boxd-turbo init
npx tsx bench/push.ts ../ai docs:1:3 leaf:1:3 core:1:3
npx tsx scripts/charts.ts        # redraws assets/ from the results
```

## Caveats

- One repository. `vercel/ai` is a TypeScript monorepo with many small packages and one large one,
  which suits per-task scheduling. A repository with a few long tasks gains less.
- The Vercel CI lane ran on 2026-10-29 in its own copy of the repository, and boxd-turbo on 2026-10-30.
  Both start from `vercel/ai` at `dfed8e8` with the same `ci` tags.
- Both sides had a warm remote cache for everything the push did not touch, which is the everyday case.
  A boxd snapshot also carries a local Turborepo cache from its last promotion, so a boxd machine
  restores a dependency's outputs from its own disk where a Vercel CI task downloads them.
- Both ran tasks on 2 CPUs. A boxd task machine has 8 GiB of memory, a Vercel CI task 4 GB.
- No push changed the lockfile. A push that does pays for one install on boxd-turbo too.
- Times include GitHub's own delay in delivering the push event, on both sides.
- boxd-turbo's time ends at the run's own finish, which it sends as the check's `completed_at`. The update
  reaches GitHub a fraction of a second later. Vercel CI's ends at its commit status. GitHub gives both
  to the second, so the docs-only figure carries about a second of rounding.
- The cost leaves out snapshot storage, kept machines of failed tasks (hibernated, disk only) and the
  promotion that follows a green push to the default branch. The benchmark pushed to branches, so it
  triggered none.
