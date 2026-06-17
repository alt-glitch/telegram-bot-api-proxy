# Copy-paste setup prompt

Paste the block below into **your AI agent** (Hermes, Claude, ChatGPT, Cursor,
Codex, whatever). It turns the agent into a step-by-step wizard that walks you
through deploying this proxy to **your own** Cloudflare account and wiring it
into Hermes Agent so Telegram works from a region where it's blocked.

> Why an agent prompt instead of just docs? The setup spans a browser (Cloudflare
> login), a config file edit, and a service restart — an agent can run the
> checks, generate the exact edit for your machine, and catch mistakes as you go.

---

<details open>
<summary><b>📋 Click to expand — copy everything inside the box</b></summary>

````text
You are helping me set up a self-hosted Telegram Bot API proxy so my Telegram
bot can reach api.telegram.org from a region where Telegram is blocked at the
network level. The proxy is a Cloudflare Worker (HTTPS reverse proxy for the
Bot API). Repo: https://github.com/alt-glitch/hermes-telegram-proxy

Be a patient step-by-step guide. Do ONE step at a time, wait for me to confirm
it worked (ask me to paste output/screenshots) before moving on. Explain what
each step does in one sentence. Do not dump all steps at once.

CRITICAL FACTS you must respect:
- A Telegram bot token IS the bot's full credential and travels in the Bot API
  URL path. Any proxy operator can see it. So I must deploy MY OWN instance and
  must NOT route my token through anyone else's proxy. Reassure me this Worker
  is written to never log the token, but the safety only holds for my own deploy.
- The Worker is an HTTPS reverse proxy, NOT a SOCKS/VPN/MTProto proxy. It only
  relays the Bot API. (MTProto proxies are a different thing, for the Telegram
  app, not bots.)
- You (the agent) must NOT edit my Hermes config.yaml with a write tool if it's
  blocked, and must NEVER restart my Hermes gateway yourself (a gateway-internal
  restart is self-terminating). Guide ME to do the config edit and restart.

Walk me through these phases:

PHASE 1 — Deploy the Worker to MY Cloudflare account (pick ONE path):
  Path A (easiest, no CLI): open the repo's README and click the
    "Deploy to Cloudflare" button. It clones the repo into my GitHub and deploys
    to my Cloudflare account. Tell me I'll need a free Cloudflare account and a
    GitHub account, and that at the end Cloudflare shows me my Worker URL.
  Path B (CLI): have me run, in a clone of the repo:
    npx wrangler login        (browser OAuth — if I'm on a remote/SSH server,
                               tell me I may need an SSH tunnel for the
                               localhost:8976 callback, and how)
    npx wrangler deploy       (prints my URL)
  Either way, the result is a URL like:
    https://hermes-telegram-proxy.<my-subdomain>.workers.dev
  Ask me to paste that URL back to you.

PHASE 2 — Verify the Worker works (before touching Hermes):
  Have me run:
    curl https://<MY-WORKER-URL>/healthz          # expect {"ok":true}
  Then prove it actually relays to Telegram with a throwaway fake token (no real
  secret): have me run a curl to /bot123456789:<35+ url-safe chars>/getMe and
  expect Telegram's {"ok":false,"error_code":401,"description":"Unauthorized"}.
  A 401 = the relay reached Telegram. A 502 = the Worker can't reach Telegram
  (rare; CF-side). Confirm with me before continuing.

PHASE 3 — Wire it into Hermes Agent:
  The gateway's Telegram platform reads a custom Bot API base URL from
  config.yaml at:  telegram -> extra -> base_url
  The value MUST be my Worker URL with a trailing /bot (PTB appends
  <token>/<method>):  https://<MY-WORKER-URL>/bot
  Show me EXACTLY this edit to make in ~/.hermes/config.yaml — find the
  top-level "telegram:" block and add base_url under its "extra:" key, e.g.:

      telegram:
        reactions: false
        channel_prompts: {}
        allowed_chats: ''
        extra:
          rich_messages: true
          base_url: https://<MY-WORKER-URL>/bot

  (My existing keys under telegram/extra may differ — preserve them, just add
  the base_url line at the same indentation as the other extra keys, 4 spaces.)
  Tell me to back up config.yaml first (cp ~/.hermes/config.yaml ~/.hermes/config.yaml.bak).
  Then have ME (not you) restart the gateway:
    hermes gateway restart
    #   or, if my install uses systemd:  systemctl --user restart hermes-gateway.service
  (If my Hermes runs differently — Docker, a different service manager — ask how
  I run it and adapt; never restart it from inside an agent session.)

PHASE 4 — Confirm end to end:
  Have me check the gateway log for the pickup + connection:
    grep -i "custom Telegram base_url" ~/.hermes/logs/gateway.log | tail -1
    grep -iE "Connected to Telegram|telegram connected|connect timed out" ~/.hermes/logs/gateway.log | tail -3
  Success = a "Using custom Telegram base_url: ..." line AND a recent
  "Connected to Telegram" / "telegram connected" with no fresh "connect timed
  out" after the restart. Then have me send my bot a Telegram message and
  confirm it replies.

TROUBLESHOOTING to offer if stuck:
- Still timing out after restart: re-check the base_url has the trailing /bot,
  the indentation is correct (under telegram.extra), and that I actually saved
  the file before restarting. Re-run the grep on the log.
- 502 from /healthz relay test: the Worker deployed but can't reach Telegram —
  redeploy / check the Cloudflare dashboard for the Worker.
- I'm on a remote server and wrangler login won't open a browser: guide me to
  ssh -L 8976:localhost:8976 <server> and paste the OAuth callback URL through
  that tunnel.

Start with Phase 1. Ask me whether I want Path A (one-click button) or Path B
(CLI), and whether I'm setting this up on my local machine or a remote server.
````

</details>

---

## What the agent will do for you

1. **Deploy** the Worker to *your* Cloudflare account (one-click button or `wrangler`).
2. **Verify** it relays to Telegram (`/healthz` + a fake-token `getMe` → expect `401`).
3. **Wire** it into `~/.hermes/config.yaml` as `telegram.extra.base_url: <url>/bot`.
4. **Confirm** the gateway picked it up and connected — then you message your bot.

The prompt is written so the agent **guides you** through the browser login,
the config edit, and the restart, rather than doing the security-sensitive parts
itself (config edits and gateway restarts are yours to run).
