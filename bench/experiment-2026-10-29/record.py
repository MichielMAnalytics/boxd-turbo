"""record.py <sha>: wait for the result of a pushed commit (Vercel CI on vbench-ai, boxd-ci on
bench-ai), then append one line to results.jsonl. wall_s: end of `git push` to the result on GitHub
(Vercel CI's final commit status, or the boxd-ci check run's completed_at), to the second."""
import json, os, re, subprocess, sys, time
from datetime import datetime
E = os.path.dirname(os.path.abspath(__file__)); B = f"{E}/../base"
sha = sys.argv[1]
push = [json.loads(l) for l in open(f"{E}/pushes.jsonl") if json.loads(l)["sha"] == sha][-1]
ts = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
gh = lambda path: json.loads(subprocess.run(["gh", "api", path], capture_output=True, text=True).stdout or "{}")
row = {k: push[k] for k in ("branch", "scenario", "role", "sha")}
if push["remote"] == "origin":  # Vercel CI
    row["platform"] = "vercel"
    while True:
        st = [x for x in gh(f"repos/azin-tech/vbench-ai/commits/{sha}/statuses") if x["context"] == "Vercel CI" and x["state"] != "pending"]
        if st: break
        time.sleep(15)
    row.update(result=st[0]["state"], wall_s=round(ts(st[0]["created_at"]) - push["push_end"], 1), description=st[0].get("description"))
    p = subprocess.run(["vercel", "ci", "ls", "--branch", push["branch"], "--commit", sha, "--scope", os.environ["VERCEL_SCOPE"], "--format", "json"], cwd=B, capture_output=True, text=True)
    runs = json.loads(p.stdout or "{}").get("runs", [])
    if runs:
        rid = runs[0]["id"]; row["run_id"] = rid
        ins = json.loads(subprocess.run(["vercel", "ci", "inspect", rid, "--scope", os.environ["VERCEL_SCOPE"], "--format", "json"], cwd=B, capture_output=True, text=True).stdout or "{}")
        tasks = [t for j in ins.get("jobs", []) for t in j.get("tasks", [])]
        ran = [t for t in tasks if t.get("durationMs") is not None]
        jobs = ins.get("jobs", [])
        row.update(tasks=len(tasks), ran=len(ran), cached=sum(t["status"] == "cached" for t in tasks),
                   failed=[t["name"] for t in tasks if t["status"] == "failed"][:10],
                   task_s_max=round(max([t["durationMs"] for t in ran], default=0) / 1000, 1),
                   cpu_min=round(sum(2 * -(-t["durationMs"] // 1000) for t in ran) / 60, 1),
                   bootstrap_s=round(min(ts(j["startedAt"]) for j in jobs if j.get("startedAt")) - ts(ins["run"]["createdAt"]), 1) if any(j.get("startedAt") for j in jobs) else None)
else:  # boxd-ci
    row["platform"] = "boxd"; row["variant"] = push["branch"].split("-")[0]
    while True:
        cr = [c for c in gh(f"repos/azin-tech/bench-ai/commits/{sha}/check-runs").get("check_runs", []) if c["name"] == "boxd-ci"]
        if cr and cr[0]["status"] == "completed": break
        time.sleep(15)
    c = cr[0]; summary = c["output"].get("summary") or ""
    shards = {m.group(2): float(m.group(3)) for m in re.finditer(r"\| (✓|✗) \| `(shard \d+/\d+)` \| ([\d.]+)s \|", summary)}
    row.update(result=c["conclusion"], wall_s=round(ts(c["completed_at"]) - push["push_end"], 1), title=c["output"].get("title"),
               shards=len(shards), shard_s_max=max(shards.values(), default=None), shard_s_median=sorted(shards.values())[len(shards) // 2] if shards else None,
               restore=(re.search(r"Restored from `[^`]+` in ([\d.]+)s", summary) or [None, None])[1])
print(json.dumps(row), flush=True)
open(f"{E}/results.jsonl", "a").write(json.dumps(row) + "\n")
