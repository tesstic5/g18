#!/usr/bin/env bash
# scripts/smoke.sh — curl-based end-to-end smoke against a running stack (api on :4000).
# Prereq: infra up + migrated + seeded + api running (pnpm --filter @casino/api dev).
set -euo pipefail
API="${API:-http://localhost:4000/api/v1}"
PHONE="03$(date +%s | tail -c 10)"  # unique, valid 03xx mobile per run
PASS="password123"

echo "→ health"
ORIGIN="${API%/api/v1}"
curl -sf "$ORIGIN/health" | head -c 120; echo

echo "→ signup ($PHONE)"
SIGNUP=$(curl -sf -X POST "$API/auth/signup" -H 'content-type: application/json' \
  -d "{\"phone\":\"$PHONE\",\"password\":\"$PASS\",\"fingerprint\":{\"userAgent\":\"smoke\",\"screenRes\":\"1x1\",\"timezone\":\"UTC\",\"language\":\"en\"}}")
TOKEN=$(echo "$SIGNUP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["accessToken"])')
echo "   token: ${TOKEN:0:16}…"

echo "→ me"
curl -sf "$API/auth/me" -H "authorization: Bearer $TOKEN" | head -c 120; echo

echo "→ admin login + fund"
ADMIN=$(curl -sf -X POST "$API/panel/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"${ADMIN_USER:-superadmin}\",\"password\":\"${ADMIN_PASS:-change-this-immediately}\"}" -c /tmp/smoke-cookies.txt)
CSRF=$(awk '$6 == "csrf_token" { print $7 }' /tmp/smoke-cookies.txt | tail -1)
USER_ID=$(curl -sf "$API/auth/me" -H "authorization: Bearer $TOKEN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
curl -sf -X POST "$API/panel/users/$USER_ID/fund" -H 'content-type: application/json' \
  -H "x-csrf-token: $CSRF" -b /tmp/smoke-cookies.txt \
  -d '{"walletType":"real","amount":1000,"reason":"smoke test"}' > /dev/null
echo "   funded ₨1,000"

echo "→ dice bet"
CLIENT_SEED=$(curl -sf "$API/provably-fair/active-seed" -H "authorization: Bearer $TOKEN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["clientSeed"])')
REQUEST_ID=$(python3 -c 'import uuid; print(uuid.uuid4())')
BET=$(curl -sf -X POST "$API/games/dice/bet" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"amount\":10,\"choices\":{\"over\":true,\"target\":50},\"clientSeed\":\"$CLIENT_SEED\",\"requestId\":\"$REQUEST_ID\"}")
echo "   $(echo "$BET" | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];print(f"round {d[chr(114)+chr(111)+chr(117)+chr(110)+chr(100)+chr(73)+chr(100)][:8]} result={d[chr(114)+chr(101)+chr(115)+chr(117)+chr(108)+chr(116)]} payout={d[chr(112)+chr(97)+chr(121)+chr(111)+chr(117)+chr(116)+chr(65)+chr(109)+chr(111)+chr(117)+chr(110)+chr(116)]}")')"

echo "→ verify round (seed rotates first)"
ROUND_ID=$(echo "$BET" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["roundId"])')
curl -sf -X POST "$API/provably-fair/rotate-seed" -H "authorization: Bearer $TOKEN" > /dev/null
VERIFY=$(curl -sf "$API/provably-fair/round/$ROUND_ID" -H "authorization: Bearer $TOKEN")
echo "   $(echo "$VERIFY" | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];print("serverSeedHash present:", bool(d.get("serverSeedHash")),"· raw:", d.get("rawOutcome"))')"

echo "✅ SMOKE PASS"
