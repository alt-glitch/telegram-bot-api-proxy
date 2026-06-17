/**
 * Unit tests for the token-safety + routing invariants.
 * Run with: npm test   (uses Node's built-in test runner, no deps)
 *
 * These are behaviour/invariant tests, not snapshots:
 *  - the Bot API path regex accepts real shapes and rejects junk
 *  - redactPath() removes the token from ANY path (the core safety property)
 *  - the country gate honours allow/block/empty semantics
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../src/worker.js";

const { BOT_PATH_RE, redactPath, countryAllowed, rateLimited, buckets, CONFIG } = __test__;

const FAKE_TOKEN = "123456789:AAFakeFakeFakeFakeFakeFakeFakeFakeFake";

test("BOT_PATH_RE accepts a valid bot method path", () => {
  assert.ok(BOT_PATH_RE.test(`/bot${FAKE_TOKEN}/sendMessage`));
});

test("BOT_PATH_RE accepts a valid file path", () => {
  assert.ok(BOT_PATH_RE.test(`/file/bot${FAKE_TOKEN}/documents/file_1.pdf`));
});

test("BOT_PATH_RE rejects junk / probes / missing token", () => {
  for (const p of ["/", "/healthz", "/sendMessage", "/bot/sendMessage", "/botNOTATOKEN/x", "/wp-login.php"]) {
    assert.ok(!BOT_PATH_RE.test(p), `should reject ${p}`);
  }
});

test("redactPath removes the token from a method path", () => {
  const out = redactPath(`/bot${FAKE_TOKEN}/sendMessage`);
  assert.equal(out, "/bot123456789:<REDACTED>/sendMessage");
  assert.ok(!out.includes("AAFake"), "secret half must be gone");
});

test("redactPath removes the token from a file path too", () => {
  const out = redactPath(`/file/bot${FAKE_TOKEN}/x.bin`);
  assert.ok(!out.includes("AAFake"));
  assert.equal(out, "/file/bot123456789:<REDACTED>/x.bin");
});

test("redactPath is a no-op on token-free paths", () => {
  assert.equal(redactPath("/healthz"), "/healthz");
});

test("country gate: empty allow+block => allow all", () => {
  CONFIG.allowedCountries = [];
  CONFIG.blockedCountries = [];
  assert.ok(countryAllowed("IN"));
  assert.ok(countryAllowed("XX"));
});

test("country gate: allowlist restricts", () => {
  CONFIG.allowedCountries = ["IN", "IR"];
  CONFIG.blockedCountries = [];
  assert.ok(countryAllowed("IN"));
  assert.ok(!countryAllowed("US"));
  CONFIG.allowedCountries = []; // reset
});

test("country gate: blocklist excludes", () => {
  CONFIG.allowedCountries = [];
  CONFIG.blockedCountries = ["RU"];
  assert.ok(!countryAllowed("RU"));
  assert.ok(countryAllowed("IN"));
  CONFIG.blockedCountries = []; // reset
});

test("rate limiter trips after max in a window", () => {
  buckets.clear();
  const key = "test:ip";
  for (let i = 0; i < 3; i++) assert.ok(!rateLimited(key, 3), `req ${i + 1} under limit`);
  assert.ok(rateLimited(key, 3), "4th request over limit trips");
  buckets.clear();
});
