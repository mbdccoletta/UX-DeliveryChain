#!/usr/bin/env bash
# Parses every DQL query this app sends, on a LAB tenant, before a build.
#
# `dtctl verify query` validates syntax without reading Grail storage: no scan,
# no cost. It exists because a query that only fails at runtime fails in front
# of the customer. Never point it at a customer's environment.
#
#   tools/dql-verify/verify.sh [dtctl-context]     (default: fxz)
set -uo pipefail
ctx="${1:-fxz}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

npx --yes esbuild "$root/ui/app/utils/dql.ts" --bundle --platform=node --format=esm \
  --outfile="$work/dql.mjs" --log-level=error || exit 2
mkdir -p "$work/q"
node "$root/tools/dql-verify/render.mjs" "$work/dql.mjs" "$work/q" || exit 2

# Expected refusals: the classic entity model is retired on lab tenants, and
# the app only reaches it inside a try, as a fallback for classic estates.
expected="qServicesGen2Calls"

ok=0; bad=0
for f in "$work/q/"*.dql; do
  name="$(basename "$f" .dql)"
  out="$(dtctl verify query -f "$f" --context "$ctx" --plain -o json 2>&1)"
  if [ $? -eq 0 ]; then ok=$((ok + 1)); continue; fi
  if [[ " $expected " == *" $name "* ]]; then echo "~ $name (expected on a lab tenant)"; continue; fi
  bad=$((bad + 1))
  echo "✗ $name: $(echo "$out" | grep -oE '"(errorMessage|message)": *"[^"]*"' | head -1)"
done
echo "valid=$ok invalid=$bad"
[ "$bad" -eq 0 ]
