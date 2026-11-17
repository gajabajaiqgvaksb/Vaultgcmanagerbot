import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHttpServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";

const received = [];
const fakeBot = {
  handleUpdate: async (u) => received.push(u),
  stats: () => ({ updates: received.length, lastUpdateAt: null, botUsername: "vaultbot", database: "sqlite" }),
};
const config = { mode: "webhook", webhookSecret: "s3cret_value" };

let server;
let base;

before(async () => {
  server = createHttpServer({ bot: fakeBot, config });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test("health endpoint returns ok for uptime pings", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
});

test("status page shows mode, bot name and database note", async () => {
  const res = await fetch(`${base}/`);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(body, /Mode:\s+webhook/);
  assert.match(body, /@vaultbot/);
  assert.match(body, /Database:\s+sqlite/);
});

test("unknown paths are 404", async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
});

test("webhook rejects a missing or wrong secret header", async () => {
  const before = received.length;
  const none = await fetch(`${base}/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ update_id: 1 }),
  });
  const wrong = await fetch(`${base}/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "nope" },
    body: JSON.stringify({ update_id: 2 }),
  });
  assert.equal(none.status, 403);
  assert.equal(wrong.status, 403);
  assert.equal(received.length, before, "no update was processed");
});

test("webhook accepts a valid update and dispatches it", async () => {
  const res = await fetch(`${base}/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "s3cret_value" },
    body: JSON.stringify({ update_id: 42, message: { text: "hi" } }),
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(received.some((u) => u.update_id === 42), "update reached the bot");
});

test("webhook rejects malformed JSON", async () => {
  const res = await fetch(`${base}/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "s3cret_value" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
});

test("config: webhook mode requires https PUBLIC_URL and a secret", () => {
  assert.throws(() => loadConfig({ BOT_TOKEN: "t", MODE: "webhook" }), /PUBLIC_URL/);
  assert.throws(
    () => loadConfig({ BOT_TOKEN: "t", MODE: "webhook", PUBLIC_URL: "https://x.onrender.com" }),
    /WEBHOOK_SECRET/,
  );
  const ok = loadConfig({
    BOT_TOKEN: "t",
    MODE: "webhook",
    PUBLIC_URL: "https://x.onrender.com/",
    WEBHOOK_SECRET: "abc-123",
    PORT: "10000",
  });
  assert.equal(ok.publicUrl, "https://x.onrender.com");
  assert.equal(ok.port, 10000);
});

test("config: defaults to polling and rejects unknown modes", () => {
  assert.equal(loadConfig({ BOT_TOKEN: "t" }).mode, "polling");
  assert.throws(() => loadConfig({ BOT_TOKEN: "t", MODE: "soap" }), /MODE/);
  assert.throws(() => loadConfig({ BOT_TOKEN: "t", PORT: "abc" }), /PORT/);
});
