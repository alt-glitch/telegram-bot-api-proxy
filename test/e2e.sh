#!/usr/bin/env bash
# End-to-end verifier for the Telegram-via-Cloudflare-Worker setup.
#
# Runs the whole chain and prints a PASS/FAIL/TODO report:
#   1. Deployed Worker reachable + relays to Telegram (works from inside the block)
#   2. Token-safety: the bot token never appears in any Worker response
#   3. Hermes config wired (telegram.extra.base_url points at the Worker)
#   4. Gateway picked up the base_url (log line) and Telegram is connected
#   5. (optional, with a REAL token) getMe returns ok:true through the proxy
#
# Safe to run repeatedly. Read-only except it does NOT touch config or restart
# anything — steps 3-4 just REPORT what still needs doing.
#
# Usage:
#   bash test/e2e.sh                  # full report, fake token for the relay probe
#   BOT_TOKEN=123:abc bash test/e2e.sh   # also do a REAL getMe through the proxy
set -u

WORKER="${WORKER_URL:-https://telegram-bot-api-proxy.balyan-sid.workers.dev}"
CONFIG="${HERMES_CONFIG:-$HOME/.hermes/config.yaml}"
GWLOG="${GATEWAY_LOG:-$HOME/.hermes/logs/gateway.log}"

pass(){ printf '  \033[32m✓ PASS\033[0m  %s\n' "$1"; }
fail(){ printf '  \033[31m✗ FAIL\033[0m  %s\n' "$1"; FAILED=1; }
todo(){ printf '  \033[33m▱ TODO\033[0m  %s\n' "$1"; }
hdr(){  printf '\n\033[1m%s\033[0m\n' "$1"; }
FAILED=0

hdr "Worker: $WORKER"

# ── 1. Worker liveness ──────────────────────────────────────────────────────
hdr "1. Deployed Worker reachable"
HZ=$(curl -s -m10 "$WORKER/healthz" 2>/dev/null)
[ "$HZ" = '{"ok":true}' ] && pass "/healthz -> $HZ" || fail "/healthz returned: ${HZ:-<no response>}"

LAND=$(curl -s -m10 "$WORKER/" 2>/dev/null | grep -c "Deploy your own")
[ "${LAND:-0}" -ge 1 ] && pass "landing page renders (deploy-your-own notice present)" || fail "landing page missing/unexpected"

J=$(curl -s -m10 "$WORKER/wp-login.php" 2>/dev/null)
echo "$J" | grep -q '"error_code":404' && pass "junk path -> clean 404 (never hits upstream)" || fail "junk path response: $J"

# ── 2. Relay to Telegram + token-safety ─────────────────────────────────────
hdr "2. Relay reaches Telegram (from inside the block) + token never leaks"
SECRET=$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9_-' | head -c 35)
FAKETOK="123456789:${SECRET}"
R=$(curl -s -m20 -w '|%{http_code}|%{time_total}' "$WORKER/bot${FAKETOK}/getMe" 2>/dev/null)
BODY="${R%|*|*}"; REST="${R##*|}"; CODE=$(echo "$R" | awk -F'|' '{print $(NF-1)}')
if echo "$BODY" | grep -q '"error_code":401'; then
  pass "getMe(fake token) -> Telegram 401 Unauthorized in ${REST}s  (relay reached api.telegram.org)"
elif echo "$BODY" | grep -q '"error_code":502'; then
  fail "getMe -> 502 (Worker could not reach Telegram — CF edge problem, NOT the block on your side)"
else
  fail "getMe unexpected (HTTP $CODE): $BODY"
fi
if printf '%s' "$BODY" | grep -qF "$SECRET"; then
  fail "TOKEN LEAK — the secret appeared in the response body"
else
  pass "token-safety: the secret does NOT appear anywhere in the response"
fi

# ── 3. Hermes config wired ──────────────────────────────────────────────────
hdr "3. Hermes config wired (telegram.extra.base_url)"
# Look for base_url whose value contains the worker host, indented under telegram.extra.
WANT_HOST=$(printf '%s' "$WORKER" | sed -E 's#https?://##')
if grep -qE "base_url:[[:space:]]*https?://${WANT_HOST}/bot" "$CONFIG" 2>/dev/null; then
  pass "config.yaml has base_url -> $WORKER/bot"
  WIRED=1
else
  WIRED=0
  todo "add under the top-level  telegram: -> extra:  block in $CONFIG :"
  printf '            \033[2mbase_url: %s/bot\033[0m\n' "$WORKER"
fi

# ── 4. Gateway picked it up + Telegram connected ────────────────────────────
hdr "4. Gateway using the proxy + Telegram connected"
if grep -qiE "custom Telegram base_url" "$GWLOG" 2>/dev/null; then
  LINE=$(grep -iE "custom Telegram base_url" "$GWLOG" | tail -1)
  pass "gateway log confirms custom base_url: ${LINE##*: }"
else
  if [ "$WIRED" = 1 ]; then
    todo "config is wired but gateway hasn't logged it — RESTART:  systemctl --user restart hermes-gateway.service"
  else
    todo "wire config (step 3) then restart the gateway (you, not the agent — self-kill rule)"
  fi
fi
# Connection health: take the single most-recent Telegram connection event and
# judge by what it is. MUST include the success signals or a stale timeout wins.
RECENT=$(grep -iE "Telegram\] Connected to Telegram|✓ telegram connected|Connect attempt.*failed|Disconnected from Telegram|telegram connect timed out" "$GWLOG" 2>/dev/null | tail -1)
if echo "$RECENT" | grep -qiE "Connected to Telegram|✓ telegram connected"; then
  pass "Telegram is CONNECTED (latest event): ${RECENT##*: }"
elif echo "$RECENT" | grep -qiE "timed out|failed|Disconnected"; then
  todo "latest Telegram event is a timeout/disconnect — if you JUST restarted, wait ~30s and re-run; else the proxy isn't taking effect: ${RECENT##*telegram*: }"
elif [ -n "$RECENT" ]; then
  pass "latest Telegram event: ${RECENT##*: }"
fi

# ── 5. Optional real getMe ──────────────────────────────────────────────────
hdr "5. Real getMe through the proxy (optional)"
if [ -n "${BOT_TOKEN:-}" ]; then
  RR=$(curl -s -m20 "$WORKER/bot${BOT_TOKEN}/getMe" 2>/dev/null)
  if echo "$RR" | grep -q '"ok":true'; then
    UN=$(echo "$RR" | grep -oE '"username":"[^"]*"' | head -1)
    pass "REAL getMe -> ok:true  ($UN)  — your bot is reachable through the proxy 🎉"
  else
    fail "real getMe did not return ok:true: $RR"
  fi
else
  todo "set BOT_TOKEN=<your real token> to do a live getMe through the proxy"
fi

# ── verdict ─────────────────────────────────────────────────────────────────
hdr "Verdict"
if [ "$FAILED" = 0 ]; then
  printf '  \033[32mNo failures.\033[0m Worker + relay verified. Any ▱ TODO items above are the remaining manual steps (config edit + gateway restart).\n'
else
  printf '  \033[31mThere are failures above — fix those before relying on the proxy.\033[0m\n'
fi
