#!/bin/bash
# Screenshot every screen and state of the Flowbounds test/design/seed.ts started, at a phone's and a desktop's
# width, light and dark.
#   test/design/shots.sh <out folder> [name filter]
# Needs a browser command in $BROWSER (default: agent-browser).
set -u
OUT=$1; ONLY=${2:-}
B=${BROWSER:-agent-browser}
FULL=http://localhost:${FULL_PORT:-4611}; EMPTY=http://localhost:${EMPTY_PORT:-4612}; LIVE=http://localhost:${LIVE_PORT:-4613}
mkdir -p "$OUT"
# name | address | wait ms
PAGES="
needs|$FULL/needs
empty-needs|$EMPTY/needs
runs|$FULL/runs
run-done|$FULL/runs?run=2
run-capped|$FULL/runs?run=4
run-asked|$FULL/runs?run=5
run-running|$FULL/runs?run=9
tables|$FULL/tables
table-results|$FULL/tables?table=sales_heads
table-10000|$FULL/tables?table=company_list
workflows|$FULL/workflows
workflow|$FULL/workflows?workflow=find-sales-heads
workflow-no-summary|$FULL/workflows?workflow=score-accounts
keys|$FULL/keys
permissions|$FULL/permissions
empty-runs|$EMPTY/runs
empty-tables|$EMPTY/tables
empty-workflows|$EMPTY/workflows
empty-keys|$EMPTY/keys
empty-permissions|$EMPTY/permissions
sign-in|$LIVE/door
sign-in-refused|$LIVE/door?no=password
live-people|$LIVE/people
live-connect|$LIVE/connect
error|$FULL/runs?run=999
missing-table|$FULL/tables?table=nope
"
[ -n "${PAGES_FILE:-}" ] && PAGES=$(cat "$PAGES_FILE")
# The browser is shared: a screenshot hangs when another tab has come in front. Then take a new tab and try again.
shot() { # address, file, width, height, theme
  for try in 1 2 3; do
    timeout 20 "$B" open "$1" >/dev/null 2>&1 && timeout 10 "$B" wait "${WAIT:-900}" >/dev/null 2>&1 && timeout 25 "$B" screenshot "$2" --full >/dev/null 2>&1 && return 0
    timeout 20 "$B" tab new "$1" >/dev/null 2>&1
    timeout 10 "$B" set viewport "$3" "$4" >/dev/null 2>&1
    timeout 10 "$B" set media "$5" >/dev/null 2>&1
  done
  echo "failed: $2"
}
round() { # the names to take: a pattern for grep -E
  for size in "phone 390 844" "desktop 1280 800"; do
    set -- $size; label=$1; w=$2; h=$3
    "$B" set viewport "$w" "$h" >/dev/null
    for theme in light dark; do
      "$B" set media $theme >/dev/null
      for line in $(echo "$PAGES" | grep -E "$SIDE"); do
        name=${line%%|*}; url=${line#*|}
        [ -n "$ONLY" ] && [[ "$name" != *$ONLY* ]] && continue
        [ -n "${SKIP_DONE:-}" ] && [ -s "$OUT/$name.$label.$theme.png" ] && continue
        shot "$url" "$OUT/$name.$label.$theme.png" "$w" "$h" "$theme"
      done
    done
  done
}
# Signed out first (the sign-in pages), then in through the team password for the pages behind the door.
SIDE='^sign-in' round
timeout 20 "$B" open "$LIVE/door" >/dev/null 2>&1
if timeout 10 "$B" fill "#name" "Maya" >/dev/null 2>&1; then
  "$B" fill "#password" "team-pass-1" >/dev/null 2>&1; "$B" click "#enter" >/dev/null 2>&1; "$B" wait 800 >/dev/null 2>&1
fi
SIDE='^[^s]|^s[^i]' round
"$B" set media light >/dev/null
ls "$OUT" | wc -l
