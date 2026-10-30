#!/bin/bash
# run.sh <remote> <branch> <scenario> <role> <count>: <count> pushes in a row on one branch, each
# recorded before the next push. Prints one result line per run.
E=$(cd "$(dirname "$0")" && pwd)
for i in $(seq 1 "$5"); do
  sha=$("$E/push.sh" "$1" "$2" "$3" "$4" | tail -1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])')
  python3 "$E/record.py" "$sha" | python3 -c 'import json,sys
d = json.loads(sys.stdin.read())
print(d["platform"], d.get("variant", ""), d["scenario"], d["role"], d["result"], "wall", d["wall_s"], {k: d.get(k) for k in ("ran", "cached", "tasks", "bootstrap_s", "task_s_max", "shards", "shard_s_max", "restore", "failed") if k in d})' 
done
