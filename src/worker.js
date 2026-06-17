/**
 * Telegram Bot API reverse proxy — Cloudflare Worker.
 *
 * Relays  https://<your-worker>.workers.dev/bot<TOKEN>/<method>
 *     ->  https://api.telegram.org/bot<TOKEN>/<method>
 * (and the file path  /file/bot<TOKEN>/<path>  ->  api.telegram.org/file/bot<TOKEN>/<path>)
 *
 * WHY THIS EXISTS
 *   The Telegram Bot API is reached over HTTPS at api.telegram.org. When that
 *   host / Telegram's IP ranges are blocked at the network level (e.g. India's
 *   nationwide block, Iran, Russia), a bot running inside the blocked region
 *   cannot reach it. Cloudflare's edge (workers.dev) usually remains reachable,
 *   so a thin reverse proxy on a Worker restores access WITHOUT a VPN or a
 *   server you have to run.
 *
 * ── THE ONE INVARIANT ─────────────────────────────────────────────────────
 *   A Telegram bot token IS the bot's full credential, and on the Bot API it
 *   travels in the URL PATH (/bot<TOKEN>/...). A reverse proxy therefore sees
 *   every token of every bot routed through it. This Worker is written so the
 *   token NEVER reaches a log line, a stats counter, an error message, or any
 *   stored state. Nothing here calls console.* with a URL, path, or token, and
 *   the upstream fetch is the ONLY place the path is used. KEEP IT THAT WAY:
 *   if you add logging, scrub the token first (see redactPath()).
 *
 *   This is also why you should DEPLOY YOUR OWN instance and not route your
 *   token through someone else's hosted proxy. Trust the code you can read and
 *   run yourself — not a stranger's endpoint.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Config lives in CONFIG below (no secrets — all behavioural). Override the
 * country gate / rate limits there before deploying if you want.
 */

const UPSTREAM = "https://api.telegram.org";

const CONFIG = {
  // Country gate. Cloudflare tags each request with request.cf.country (ISO-2).
  //   allowedCountries: [] (empty)  => allow every country (default; simplest).
  //   allowedCountries: ["IN","IR"] => allow ONLY these; everything else 403.
  // A gate shrinks your exposure as an open relay but is easy to get wrong
  // (e.g. you travel). Empty + rate limits is a fine default for a personal box.
  allowedCountries: [],
  // If allowedCountries is empty, you may instead block specific countries:
  blockedCountries: [],

  // Per-minute rate limits (best-effort, in-memory per Worker isolate — NOT a
  // global guarantee, but enough to blunt abuse of a personal instance).
  rateLimits: {
    perIp: 600, // requests / IP / minute
    global: 6000, // requests / isolate / minute
  },

  // Upstream fetch behaviour.
  //
  // Total wall-clock budget per upstream attempt. Generous because getUpdates
  // long-polls (the bot asks Telegram to hold the connection open up to ~50s
  // waiting for new messages). A normal call returns in well under a second; a
  // BLOCKED host fails its TCP connect fast (workerd surfaces connect refusal
  // quickly), so this ceiling mainly bounds the long-poll, not the block case.
  upstreamTimeoutMs: 55000,
  // Retry ONLY genuine upstream server errors (HTTP 502/503/504 returned BY
  // Telegram). We do NOT retry network/connect failures or aborts: if the host
  // is blocked or unreachable, retrying just stacks more dead waits (same
  // lesson as retrying a blocked auth — pure waste). One clean failure is
  // better than three slow ones.
  retriesOn5xx: 1,
  retryBaseMs: 300,
};

// ───────────────────────── token-safe helpers ─────────────────────────────

// A Bot API path looks like /bot<digits>:<base64ish>/<method> or
// /file/bot<digits>:<rest>/<filepath>. We validate the shape WITHOUT ever
// emitting the token.
const BOT_PATH_RE = /^\/(file\/)?bot(\d{5,}):([A-Za-z0-9_-]{20,})\/(.+)$/;

// Replace the token in any path with bot<id>:<REDACTED> so it is SAFE to log.
// (Used only if you choose to add logging — nothing logs by default.)
function redactPath(path) {
  return path.replace(
    /\/bot(\d{5,}):[A-Za-z0-9_-]+/g,
    "/bot$1:<REDACTED>",
  );
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

// Telegram-style error envelope so bot libraries parse it cleanly.
function tgError(status, description) {
  return json({ ok: false, error_code: status, description }, status, SECURITY_HEADERS);
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer", // never leak the token-bearing URL via Referer
  "x-frame-options": "DENY",
};

// ───────────────────────── rate limiting (best-effort) ────────────────────

// In-memory, per-isolate. Resets when the isolate recycles. Good enough to
// throttle a personal instance; not a distributed quota.
const buckets = new Map(); // key -> { count, resetAt }

function rateLimited(key, max) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + 60000 });
    return false;
  }
  b.count += 1;
  return b.count > max;
}

// ───────────────────────── country gate ───────────────────────────────────

function countryAllowed(cc) {
  const { allowedCountries, blockedCountries } = CONFIG;
  if (allowedCountries.length > 0) return allowedCountries.includes(cc);
  if (blockedCountries.length > 0) return !blockedCountries.includes(cc);
  return true;
}

// ───────────────────────── landing page (no token) ────────────────────────

function landingPage(origin) {
  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram Bot API proxy</title>
<style>
  :root{color-scheme:dark light}
  body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1.2rem}
  code,pre{font-family:ui-monospace,monospace;background:#8881;border-radius:.3rem}
  code{padding:.1rem .3rem}pre{padding:.9rem;overflow:auto}
  .warn{border-left:3px solid #e44;padding:.2rem 0 .2rem .9rem;background:#e441}
  h1{font-size:1.4rem}small{opacity:.7}
</style></head><body>
<h1>Telegram Bot API proxy</h1>
<p>This is a reverse proxy for the Telegram Bot API. Point your bot at this
origin instead of <code>api.telegram.org</code> to reach Telegram from a region
where it is blocked.</p>
<p><b>Base URL:</b> <code>${origin}</code></p>
<div class="warn"><b>Deploy your own.</b> A bot token travels in the request
path and grants full control of the bot. Whoever runs a proxy can see it. Do
<b>not</b> route your token through someone else's instance — run this code
yourself. Source: a single auditable <code>src/worker.js</code>.</div>
<h2>Hermes Agent</h2>
<pre># config.yaml
platforms:
  telegram:
    extra:
      base_url: "${origin}/bot"</pre>
<h2>Health</h2>
<p><code>GET ${origin}/healthz</code> — liveness (no token, no upstream call).</p>
<p><small>No request paths, tokens, IPs, or bodies are logged or stored by this Worker.</small></p>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS },
  });
}

// ───────────────────────── upstream relay ─────────────────────────────────

async function relay(request, url) {
  const target = UPSTREAM + url.pathname + url.search;

  // Forward method, body, and a minimal, safe header set. We deliberately do
  // NOT forward client IP / Referer / cookies upstream.
  const headers = new Headers();
  const ct = request.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  const accept = request.headers.get("accept");
  if (accept) headers.set("accept", accept);

  const init = {
    method: request.method,
    headers,
    // Stream the body through for uploads (sendDocument/sendPhoto/etc.).
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    // Required by Workers runtime when forwarding a streaming request body.
    ...(request.body ? { duplex: "half" } : {}),
  };

  // Retry budget applies ONLY to genuine upstream 5xx responses. A network
  // failure / abort (blocked or unreachable host) breaks out immediately —
  // retrying it just stacks dead waits.
  for (let attempt = 0; attempt <= CONFIG.retriesOn5xx; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CONFIG.upstreamTimeoutMs);
    let resp;
    try {
      resp = await fetch(target, { ...init, signal: ac.signal });
    } catch (err) {
      clearTimeout(timer);
      // NB: err may stringify the target URL (with token) — NEVER log err.
      // Connect/abort failures are not retried (see above).
      const reason = err && err.name === "AbortError" ? "upstream timeout" : "upstream unreachable";
      return tgError(502, `Bad Gateway: ${reason}`);
    }
    clearTimeout(timer);

    // Retry a real upstream server error, if budget remains.
    if (resp.status >= 502 && resp.status <= 504 && attempt < CONFIG.retriesOn5xx) {
      await sleep(CONFIG.retryBaseMs * 2 ** attempt);
      continue;
    }

    const out = new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    return out;
  }
  // Exhausted 5xx retries.
  return tgError(502, "Bad Gateway: upstream error");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ───────────────────────── request entrypoint ─────────────────────────────

export default {
  async fetch(request, _env, _ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Non-relay endpoints first (cheap, no token, no upstream).
    if (path === "/" || path === "") return landingPage(url.origin);
    if (path === "/healthz") return json({ ok: true });
    if (path === "/favicon.ico") return new Response(null, { status: 204 });

    // Only GET/POST are meaningful for the Bot API.
    if (request.method !== "GET" && request.method !== "POST" && request.method !== "HEAD") {
      return tgError(405, "Method Not Allowed");
    }

    // Must be a well-formed Bot API path. This both routes and rejects junk
    // probes WITHOUT echoing the token anywhere.
    if (!BOT_PATH_RE.test(path)) {
      return tgError(404, "Not Found: expected /bot<token>/<method>");
    }

    // Country gate.
    const cc = (request.cf && request.cf.country) || "XX";
    if (!countryAllowed(cc)) {
      return tgError(403, "Forbidden: region not allowed by this proxy");
    }

    // Rate limits (best-effort). Key the per-IP bucket on CF-Connecting-IP;
    // the IP is used ONLY as an ephemeral in-memory map key, never logged.
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (rateLimited(`ip:${ip}`, CONFIG.rateLimits.perIp)) {
      return tgError(429, "Too Many Requests (per-IP)");
    }
    if (rateLimited("global", CONFIG.rateLimits.global)) {
      return tgError(429, "Too Many Requests (global)");
    }

    return relay(request, url);
  },
};

// Exported for unit tests; not used at runtime.
export const __test__ = { BOT_PATH_RE, redactPath, countryAllowed, rateLimited, buckets, CONFIG };
