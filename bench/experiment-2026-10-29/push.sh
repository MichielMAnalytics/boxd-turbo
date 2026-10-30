#!/bin/bash
# push.sh <remote> <branch> <scenario: none|leaf|core|docs> <role>: one benchmark push from the base checkout.
# leaf/core/docs append a comment with a fresh nonce to one file, so exactly that file changes.
set -euo pipefail
E=$(cd "$(dirname "$0")" && pwd); B=$E/../base; remote=$1 branch=$2 scenario=$3 role=$4
lock="$E/.lock"; until mkdir "$lock" 2>/dev/null; do sleep 0.3; done; trap 'rmdir "$lock"' EXIT
cd "$B"; git checkout -q "$branch"
nonce=$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.UTC).isoformat())')
case $scenario in
  leaf) f=packages/mistral/src/index.ts; echo "// bench: $nonce" >> $f ;;
  core) f=packages/provider-utils/src/index.ts; echo "// bench: $nonce" >> $f ;;
  docs) f=$(cat "$E/docs-file"); printf '\n{/* bench: %s */}\n' "$nonce" >> $f ;;
  none) f="" ;;
esac
git -c user.name=boxd-bench -c user.email=bench@boxd.sh commit -q --allow-empty -am "bench: $scenario $role $nonce${BENCH_MSG:+ $BENCH_MSG}"
sha=$(git rev-parse HEAD); t0=$(python3 -c 'import time; print(time.time())')
git push -q "$remote" "$branch" 2>&1 | grep -v "^remote:" || true
t1=$(python3 -c 'import time; print(time.time())')
echo "{\"remote\": \"$remote\", \"branch\": \"$branch\", \"scenario\": \"$scenario\", \"role\": \"$role\", \"sha\": \"$sha\", \"push_start\": $t0, \"push_end\": $t1}" | tee -a "$E/pushes.jsonl"
