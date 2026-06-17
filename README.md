# telegram-bot-api-proxy

A small, **auditable Cloudflare Worker** that reverse-proxies the Telegram Bot
API so a bot can reach `api.telegram.org` from a region where Telegram is
blocked at the network level (e.g. India's nationwide block, Iran, Russia) —
**without a VPN and without running a server.**

```
your bot ──HTTPS──▶  https://<you>.workers.dev/bot<TOKEN>/<method>
                              │  (Cloudflare edge — reachable from the blocked region)
                              ▼
                     https://api.telegram.org/bot<TOKEN>/<method>
```

It is one file — [`src/worker.js`](src/worker.js) — with no dependencies, no
secrets, and no stored state.

---

## ⚠️ Read this before you use ANY Telegram proxy

A Telegram **bot token is the bot's entire credential**, and on the Bot API it
travels **in the URL path** (`/bot<TOKEN>/sendMessage`). There is no separate
header, no signature, no scoping. That means **any reverse proxy sees the token
of every bot routed through it** and could log it, store it, or impersonate the
bot.

**Therefore: deploy your OWN instance. Never route your token through a proxy
someone else hosts** — not this author's, not a stranger's "free" endpoint. The
only trustworthy version of this is *code you can read and run yourself*, which
is exactly what this repo is.

This Worker is written so the token **never reaches a log line, a counter, an
error message, or any stored state**. The only place the token-bearing path is
used is the single upstream `fetch()`. (If you add logging, scrub it first with
the provided `redactPath()` helper.) But that guarantee only protects *your own*
deployment — it cannot make a shared/hosted instance safe, because the operator
always sees the raw request.

---

## Deploy your own (≈3 minutes, free tier)

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up).

### Option A — Wrangler CLI

```bash
git clone <this-repo> && cd telegram-bot-api-proxy
npx wrangler login          # opens a browser, authorizes your CF account
npx wrangler deploy
```

Wrangler prints your URL, e.g.
`https://telegram-bot-api-proxy.<your-subdomain>.workers.dev`.

### Option B — Cloudflare dashboard (no CLI)

1. Workers & Pages → **Create** → **Worker** → name it → **Deploy**.
2. **Edit code**, delete the placeholder, paste the entire contents of
   [`src/worker.js`](src/worker.js), **Save and deploy**.

Verify it's live (no token needed):

```bash
curl https://<your-worker>.workers.dev/healthz      # -> {"ok":true}
```

---

## Point Hermes Agent at it

The gateway's Telegram platform accepts a custom Bot API base URL
(`Application.builder().base_url(...)` under the hood). Set it in `config.yaml`:

```yaml
platforms:
  telegram:
    extra:
      base_url: "https://<your-worker>.workers.dev/bot"
```

Then restart the gateway. That's it — every Bot API call (send + `getUpdates`
long-poll) now flows through your Worker. No code changes, no env vars.

> The trailing `/bot` matters: Hermes/PTB appends `<token>/<method>` to it, so
> the final URL is `https://<you>.workers.dev/bot<token>/<method>`, which this
> Worker matches.

### Using it from a raw bot (any library)

Replace `https://api.telegram.org` with `https://<you>.workers.dev` as the
API base. python-telegram-bot: `ApplicationBuilder().base_url("https://<you>.workers.dev/bot")`.
aiogram / node-telegram-bot-api: set the API base to `https://<you>.workers.dev`.

---

## Endpoints

| Path | Purpose |
| --- | --- |
| `/` | Landing page — shows your base URL + the deploy-your-own warning. No token. |
| `/healthz` | Liveness — `{"ok":true}`. No token, no upstream call. |
| `/bot<TOKEN>/<method>` | Bot API relay. |
| `/file/bot<TOKEN>/<path>` | File download relay. |

Anything that isn't a well-formed Bot API path gets a clean Telegram-style
`404` envelope (so junk probes don't even reach the upstream).

---

## Configuration

Behavioural only — there are **no secrets**. Edit the `CONFIG` block at the top
of [`src/worker.js`](src/worker.js) before deploying:

| Key | Default | Meaning |
| --- | --- | --- |
| `allowedCountries` | `[]` (all) | If non-empty, only these ISO-2 countries may use the proxy. |
| `blockedCountries` | `[]` | If `allowedCountries` is empty, block these. |
| `rateLimits.perIp` | `600`/min | Best-effort per-IP throttle (in-memory per isolate). |
| `rateLimits.global` | `6000`/min | Best-effort per-isolate throttle. |
| `upstreamTimeoutMs` | `55000` | Per-attempt budget (long enough for `getUpdates` long-poll). |
| `retriesOn5xx` | `1` | Retries on a real upstream 5xx. Network/connect failures are **not** retried. |

For a personal instance, the defaults (allow-all + rate limits) are fine. A
country allowlist shrinks your exposure but is easy to get wrong (e.g. you
travel, or Cloudflare geolocates you oddly).

---

## Threat model / limits (be honest with yourself)

- **The operator sees every token.** Mitigated by "deploy your own" + never
  logging the path. Not mitigated for a shared instance — there is no fix for
  that; it's inherent to the Bot API. Don't host a public one.
- **Cloudflare sees the traffic.** You're trusting Cloudflare's edge (you
  already do if you use CF). Telegram still sees the real bot activity.
- **A well-known shared hostname is easily blocked.** Your own `workers.dev`
  subdomain is obscure; a famous "everyone uses this" URL gets added to ISP
  blocklists fast. Another reason to self-deploy.
- **Free-tier quota.** `workers.dev` free = ~100k requests/day. A single
  polling bot (`getUpdates` ~1/s) uses ~86k/day — fine for *your* bots, not for
  a crowd. (Webhook mode uses far fewer requests than long-polling.)
- **Rate limiting is best-effort**, per-isolate and in-memory — it blunts abuse,
  it is not a hard distributed quota.

---

## Development

```bash
npm test            # unit tests (Node built-in runner): token redaction, path
                    # routing, country gate, rate limiter — invariant tests
npx wrangler dev    # run locally on http://localhost:8787 (real workerd runtime)
bash test/smoke.sh  # end-to-end smoke against a running `wrangler dev`
```

The unit tests assert the **token-safety invariant** directly: `redactPath()`
strips the secret from any path shape, and the router rejects non-Bot-API paths
before any upstream call.

---

## License

MIT — see [LICENSE](LICENSE). Built for, and tested with,
[Hermes Agent](https://hermes-agent.nousresearch.com).
