#!/bin/bash
# Walk through the live door against the stand-in: sign in, make a token, lock a key, ask with the token, say yes as a person.
cd "${1:-$(dirname "$0")}"
U=${U:-http://localhost:4130}
J='content-type: application/json'
step() { echo; echo "== $1"; }

step "1. a page without signing in is turned to the door"
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" $U/runs

step "2. wrong team password, then the right one"
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" -d "password=nope&name=Dana" $U/door/password
JAR=$(mktemp)
curl -s -c $JAR -o /dev/null -d "password=team-pass-1&name=Dana" $U/door/password
curl -s -b $JAR -c $JAR -o /dev/null -w "the door lets Dana in: %{http_code} -> %{redirect_url}\n" "$U/door/in?to=/runs"
COOKIE=$(awk '!/^#/ || /^#HttpOnly_/ { if (NF >= 7) printf "%s=%s; ", $6, $7 }' $JAR)
echo "signed in: cookie ${COOKIE:0:14}..."

step "3. a signed-in person makes a token (shown once)"
TOKEN=$(curl -s -H "$J" --cookie "$COOKIE" -H "x-flowbound-via: page" -d '{"label":"test agent"}' $U/api/make-token | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).result.token')
test -n "$TOKEN"
A="authorization: Bearer $TOKEN"

BAD_TOKEN="invalid-test-token"
step "4. no token, bad token"
curl -s -H "$J" -d '{}' $U/api/tables; echo
curl -s -H "$J" -H "authorization: Bearer $BAD_TOKEN" -d '{}' $U/api/tables; echo

step "5. the token imports a list"
node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({csv:fs.readFileSync("targets.csv","utf8"),csvName:"targets.csv"}))' > /tmp/fb-import.json
curl -s -H "$J" -H "$A" -d @/tmp/fb-import.json $U/api/import; echo

step "6. the token cannot save a key; the person can; the database holds it locked"
curl -s -H "$J" -H "$A" -d '{"name":"fakedata","value":"sk-test-123"}' $U/api/set-key; echo
curl -s -H "$J" -H "cookie: $COOKIE" -H "x-flowbound-via: page" -d '{"name":"fakedata","value":"sk-test-123"}' $U/api/set-key; echo
docker exec fb-test-pg psql -U postgres -d flowbound -At -c "select name, left(locked, 40) || '...' , position('sk-test' in locked) as plain_key_found from fb_keys.keys"

step "7. the token can read with SQL, not write"
curl -s -H "$J" -H "$A" -d '{"query":"select count(*) from target_list"}' $U/api/sql; echo
curl -s -H "$J" -H "$A" -d '{"query":"delete from target_list"}' $U/api/sql; echo

step "8. the token tries (no yes needed)"
curl -s -H "$J" -H "$A" -d '{"workflow":"find-sales-heads","try":10}' $U/api/run | node -pe 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")).result; JSON.stringify({state:r.state,fields:r.fields,spent:r.spent.text,suggested:r.tryout.suggestedUsd})'

step "9. the token asks for the full run: it waits for a person"
RUN=$(curl -s -H "$J" -H "$A" -d '{"workflow":"find-sales-heads","maxUsd":0.5}' $U/api/run | node -pe 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")).result; console.error(JSON.stringify({run:r.run,state:r.state,yesBy:r.yesBy,page:r.page})); r.run')
curl -s -H "$J" -H "$A" -d "{\"run\":$RUN,\"maxUsd\":0.5}" $U/api/yes; echo

step "10. the person taps yes on the page (the name she typed when entering is saved with it, as not checked)"
curl -s -H "$J" -H "cookie: $COOKIE" -H "x-flowbound-via: page" -d "{\"run\":$RUN,\"maxUsd\":0.5}" $U/api/yes | node -pe 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")); JSON.stringify(r.ok ? {state:r.result.state} : r)'
sleep 6
curl -s -H "$J" -H "$A" -d "{\"run\":$RUN}" $U/api/runs | node -pe 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")).result; JSON.stringify({state:r.state,rows:r.rows,spent:r.spent.text,yesBy:r.yesBy})'

step "11. MCP over HTTP with the token"
curl -s -H "$J" -H "$A" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' $U/mcp | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).result.tools.map(t=>t.name).join(", ")'
curl -s -H "$J" -H "$A" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"run","arguments":{"tool":"tables"}}}' $U/mcp | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).result.content[0].text.replace(/\s+/g," ")'
curl -s -o /dev/null -w "MCP without a token: %{http_code}\n" -H "$J" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' $U/mcp
