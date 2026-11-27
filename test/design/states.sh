#!/bin/bash
# The states an address alone cannot show: the phone menu, a dialog, a question before a removal, a search being
# typed, a saved line, a list that is already there, and what a keyboard does. Screenshots and a few facts.
#   test/design/states.sh <out folder>      (after test/design/seed.ts; uses the same browser command as shots.sh)
set -u
OUT=$1; mkdir -p "$OUT"
B=${BROWSER:-agent-browser}
FULL=http://localhost:${FULL_PORT:-4611}; LIVE=http://localhost:${LIVE_PORT:-4613}
go() { timeout 20 "$B" open "$1" >/dev/null 2>&1; "$B" wait "${2:-800}" >/dev/null 2>&1; }
snap() { timeout 25 "$B" screenshot "$OUT/$1.png" >/dev/null 2>&1 || echo "failed: $1"; }
js() { "$B" eval "$1" 2>&1 | tail -1; }
tap() { js "[...document.querySelectorAll('button,a')].find(b=>b.textContent.trim()==='$1').click()" >/dev/null; "$B" wait "${2:-500}" >/dev/null 2>&1; }

"$B" set media light >/dev/null; "$B" set viewport 390 844 >/dev/null
go "$FULL/runs"
"$B" click "#menu-open" >/dev/null; "$B" wait 400 >/dev/null
snap menu-open.phone
echo "menu: open=$(js 'document.getElementById("menu").open') focus-inside=$(js 'document.getElementById("menu").contains(document.activeElement)')"
"$B" press Escape >/dev/null; "$B" wait 300 >/dev/null
echo "menu after Escape: open=$(js 'document.getElementById("menu").open')"
# By keyboard from the top: the first stop is the way past the menu.
go "$FULL/runs"
"$B" press Tab >/dev/null
echo "first Tab lands on: $(js 'document.activeElement.textContent')"
snap skip-link.phone

go "$FULL/tables?table=sales_heads"
js "[...document.querySelectorAll('td button')].find(b=>b.textContent.includes('@')).click()" >/dev/null; "$B" wait 900 >/dev/null
snap answer-source.phone
"$B" press Escape >/dev/null

"$B" set viewport 1280 800 >/dev/null
go "$FULL/tables?table=company_list"
"$B" click "input[name=q]" >/dev/null
"$B" keyboard type "kestrel 6" >/dev/null 2>&1 || "$B" type "input[name=q]" "kestrel 6" >/dev/null
"$B" wait 1200 >/dev/null
echo "search: address=$(js 'location.search') still-typing-in-box=$(js 'document.activeElement.name') shown=$(js 'document.querySelector(".pager p").textContent') rows-in-page=$(js 'document.querySelectorAll("tbody tr").length')"
snap search.desktop
go "$FULL/tables?table=company_list&page=100"
echo "last page of 10,000: $(js 'document.querySelector(".pager p").textContent'), rows held by the page: $(js 'document.querySelectorAll("tbody tr").length')"

# Only the fake provider's key is ever typed here: a key typed for a real card is tried at that provider.
go "$FULL/keys"
"$B" fill "input[name=fakedata]" "sk-design-123" >/dev/null 2>&1
tap Save 900
snap key-saved.desktop
go "$FULL/keys"
tap Save 600
snap nothing-typed.desktop

go "$LIVE/door"
if timeout 10 "$B" fill "#name" "Maya" >/dev/null 2>&1; then "$B" fill "#password" "team-pass-1" >/dev/null; "$B" click "#enter" >/dev/null; "$B" wait 800 >/dev/null; fi
go "$LIVE/connect"
tap Remove 500
snap remove-token.desktop
echo "remove asks first: dialog-open=$(js '!!document.querySelector("dialog.dialog[open]")') focus-on=$(js 'document.activeElement.textContent')"
"$B" press Escape >/dev/null; "$B" wait 300 >/dev/null
echo "after Escape the token is still there: $(js 'document.querySelectorAll("main li").length') connected"
"$B" set viewport 390 844 >/dev/null
go "$LIVE/people"
js "(()=>{const s=document.querySelector('select');s.value='manage';s.dispatchEvent(new Event('change',{bubbles:true}))})()" >/dev/null; "$B" wait 500 >/dev/null
snap give-manage.phone
"$B" press Escape >/dev/null
