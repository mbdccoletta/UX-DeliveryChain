#!/usr/bin/env bash
# Deploys the built app, one tenant after another, logging in as rarely as
# possible.
#
# dt-app keeps ONE login, in .dt-app/.tokens.json, for one tenant at a time.
# Deploying to five tenants in a row overwrote it four times, so every deploy
# opened a browser login for every tenant. This script keeps a login per
# tenant in .dt-app/sso/<tenant>.json (git-ignored, never printed) and puts
# the right one in place before each deploy; dt-app then refreshes it on its
# own and only asks the browser when that tenant's refresh token has expired.
#
# A platform token in .dt-app/<tenant>-token.txt (scopes app-engine:apps:install,
# app-engine:apps:run) skips the login entirely and is preferred when present.
#
#   tools/deploy/deploy.sh <tenant-id> [<tenant-id> ...]
#
# Tenants listed in .dt-app/deploy-refuse.txt (one id per line, git-ignored) are
# refused — a production estate on hold stays out of every deploy loop.
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
live="$root/.dt-app/.tokens.json"
store="$root/.dt-app/sso"
mkdir -p "$store" && chmod 700 "$store"
for t in "$@"; do
  if [ -s "$root/.dt-app/deploy-refuse.txt" ] && grep -qx "$t" "$root/.dt-app/deploy-refuse.txt"; then
    echo "== $t: refused (listed in .dt-app/deploy-refuse.txt)"; continue
  fi
  case "$t" in
    *.*) url="https://$t" ;;
    fxz0998d) url="https://fxz0998d.dev.apps.dynatracelabs.com" ;;
    *) url="https://$t.apps.dynatrace.com" ;;
  esac
  f="$root/.dt-app/${t}-token.txt"
  [ -s "$f" ] || f="$root/.dt-app/${t:0:3}-token.txt"   # short alias, e.g. fxz-token.txt
  echo "== $t"
  if [ -s "$f" ]; then
    DT_APP_PLATFORM_TOKEN="$(tr -d '[:space:]' < "$f")" \
      npx dt-app deploy --skip-build --environment-url "$url" </dev/null 2>&1 \
      | grep -E "deployed|rror|denied|401|403" | tail -2
    continue
  fi
  # this tenant's own login, if we have kept one
  if [ -s "$store/$t.json" ]; then cp "$store/$t.json" "$live"; else rm -f "$live"; fi
  npx dt-app deploy --skip-build --environment-url "$url" </dev/null 2>&1 \
    | grep -E "deployed|rror|denied|401|403" | tail -2
  # keep whatever login this deploy ended with, for next time
  if [ -s "$live" ]; then cp "$live" "$store/$t.json" && chmod 600 "$store/$t.json"; fi
done
