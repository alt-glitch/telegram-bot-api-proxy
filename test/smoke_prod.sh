#!/usr/bin/env bash
# Prove the DEPLOYED Worker relays to Telegram end-to-end.
# Uses a valid-SHAPED but fake token generated in-script (no real secret typed).
set -u
# NOTE: live Worker URL (named telegram-bot-api-proxy on CF; repo renamed to
# hermes-telegram-proxy without a redeploy, so this URL is unchanged).
B="https://telegram-bot-api-proxy.balyan-sid.workers.dev"
SECRET=$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9_-' | head -c 35)
TOK="123456789:${SECRET}"

echo "## token shape: 123456789:<${#SECRET} url-safe chars>"
echo "## getMe through the deployed Worker (expect Telegram 401 'Unauthorized' = relay reached TG)"
RESP=$(curl -s -m20 -w $'\n[HTTP %{http_code} in %{time_total}s]' "$B/bot${TOK}/getMe")
echo "$RESP"
echo
echo "## token-leak check (the random secret must NOT appear in the response)"
if printf '%s' "$RESP" | grep -qF "$SECRET"; then echo "LEAK — FAIL"; else echo "no token in response — OK"; fi
