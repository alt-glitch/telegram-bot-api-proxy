#!/usr/bin/env bash
# Local smoke test against `wrangler dev` on :8787.
# Generates a valid-SHAPED fake token in-script (no real secret) so we never
# type a token literal on a command line.
set -u
B="http://localhost:8787"
# digits : 35 url-safe chars  -> matches BOT_PATH_RE (/(\d{5,}):([A-Za-z0-9_-]{20,}))
SECRET=$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9_-' | head -c 35)
TOK="987654321:${SECRET}"
echo "## token shape: 987654321:<${#SECRET} url-safe chars>"

echo "## 1 healthz"; curl -s -m5 "$B/healthz"; echo
echo "## 2 landing has 'Deploy your own'"; curl -s -m5 "$B/" | grep -c "Deploy your own"
echo "## 3 junk -> 404"; curl -s -m5 "$B/wp-login.php"; echo
echo "## 4 method-only no token -> 404"; curl -s -m5 "$B/sendMessage"; echo

echo "## 5 relay valid-shaped token -> upstream (TG blocked here) -> clean 502 after timeout"
echo "##   (allow up to 70s for abort+retries)"
RESP=$(curl -s -m75 -D /tmp/smoke_hdr.txt -w $'\nHTTP_STATUS=%{http_code} TIME=%{time_total}s' "$B/bot${TOK}/getMe")
echo "$RESP"

echo "## 6 security headers on the relayed response"
grep -iE "referrer-policy|x-content-type-options" /tmp/smoke_hdr.txt || echo "(none — check if relay returned before setting them)"

echo "## 7 token leak check (the random secret must NOT appear anywhere)"
if printf '%s' "$RESP$(cat /tmp/smoke_hdr.txt)" | grep -qF "$SECRET"; then
  echo "LEAK!! the token secret appeared in the response — FAIL"
else
  echo "no token leaked — OK"
fi
