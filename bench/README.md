# Benchmark

Push to green on [`vercel/ai`](https://github.com/vercel/ai) for three kinds of change, on boxd CI and
on Vercel CI, with the same commit, the same Turborepo version (2.11.10) and the same tasks: the
`type-check` and `test` tasks of every package, tagged `ci` in each package's `turbo.json` the way
Vercel CI asks for (249 tasks with their builds).

| Scenario | The push changes | What has to run |
|---|---|---|
| docs | `content/docs/00-introduction/index.mdx` | nothing, every result is in the cache |
| leaf | `packages/mistral/src/index.ts` | mistral's build, type-check and test |
| core | `packages/provider-utils/src/index.ts` | most of the repository: provider-utils is a dependency of nearly every package |

Each push appends a comment with a fresh timestamp to that one file. Per scenario: one warm-up push,
then three measured pushes, one at a time. The time is from the end of `git push` to the result on
GitHub: the `boxd-ci` check run's `completed_at` for boxd CI, Vercel CI's commit status for Vercel CI.
The tables and charts use the median of the three.

## Files

| File | What it holds |
|---|---|
| `results/boxd-ci.jsonl` | every boxd CI push: scenario, time, result, tasks, machines, machine seconds |
| `results/experiment-2026-10-29.jsonl` | the earlier lanes: Vercel CI, and the boxd prototype that ran fixed test shards |
| `results/experiment-2026-10-29-summary.json` | their medians and cost per run |
| `results/core-run.json` | the run record behind the task-by-task chart |
| `push.ts` | the harness that made `boxd-ci.jsonl` |

## Cost

boxd CI: every task machine for every second it was up, from the create call to its delete, at $0.059
per vCPU-hour and $0.018 per GiB-hour, plus the server machine (2 vCPU, 8 GiB) for the length of the
run. Vercel CI: $0.0035 per CPU-minute, with tasks at 2 CPUs and bootstrapping at 4 CPUs, from
`vercel ci inspect`.

## Run it yourself

```bash
gh repo fork vercel/ai --clone   # then tag type-check and test with ci, push, and run boxd-ci init
npx tsx bench/push.ts ../ai docs:1:3 leaf:1:3 core:1:3
npx tsx scripts/charts.ts        # redraws assets/ from the results
```

## Caveats

- One repository. `vercel/ai` is a TypeScript monorepo with many small packages and one large one,
  which suits per-task machines. A repository with a few long tasks gains less.
- The Vercel CI lane ran on 2026-10-29 in its own copy of the repository, and boxd CI on 2026-10-30.
  Both start from `vercel/ai` at `dfed8e8` with the same `ci` tags.
- Both sides had a warm cache for everything the push did not touch, which is the everyday case.
- Times include GitHub's own delay in delivering the push event, on both sides.
- boxd CI's time ends at the run's own finish, which it sends as the check's `completed_at`. The update
  reaches GitHub a fraction of a second later. Vercel CI's ends at its commit status. GitHub gives both
  to the second, so the docs-only figure carries about a second of rounding.
- The cost leaves out snapshot storage, kept machines of failed tasks (hibernated, disk only) and the
  promotion that follows a green push to the default branch. The benchmark pushed to branches, so it
  triggered none.
