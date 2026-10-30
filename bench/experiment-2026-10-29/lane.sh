#!/bin/bash
# lane.sh <remote> <branch:scenario>...: per branch, 1 warm-up push then 3 measured, one at a time.
E=$(cd "$(dirname "$0")" && pwd); remote=$1; shift
for t in "$@"; do
  "$E/run.sh" "$remote" "${t%%:*}" "${t#*:}" warmup 1
  "$E/run.sh" "$remote" "${t%%:*}" "${t#*:}" measured 3
done
echo "lane done: $*"
