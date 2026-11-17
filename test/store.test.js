import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { DEFAULT_SETTINGS, mergeSettings, toggle, setBoundedNumber } from "../src/settings.js";
import { Enforcer } from "../src/enforce.js";
import { renderWelcome, parseButtons } from "../src/welcome.js";
import { parseChatRef, parseUserRef, parseDuration, esc } from "../src/util.js";

test("unknown group returns default settings", () => {
  const store = openDatabase(":memory:");
  assert.deepEqual(store.getSettings(-100), DEFAULT_SETTINGS);
});

test("saved settings persist and merge with defaults", () => {
  const store = openDatabase(":memory:");
  store.ensureGroup(-100, "Test");
  const s = store.getSettings(-100);
  s.links.allowExternal = true;
  store.saveSettings(-100, s);
  const loaded = store.getSettings(-100);
  assert.equal(loaded.links.allowExternal, true);
  assert.equal(loaded.flood.maxMessages, DEFAULT_SETTINGS.flood.maxMessages);
});

test("groups are isolated from each other", () => {
  const store = openDatabase(":memory:");
  store.ensureGroup(-1, "A");
  store.ensureGroup(-2, "B");
  const a = store.getSettings(-1);
  a.welcome.enabled = true;
  store.saveSettings(-1, a);
  assert.equal(store.getSettings(-2).welcome.enabled, false);
});

test("banned words are per group and case-normalized", () => {
  const store = openDatabase(":memory:");
  store.ensureGroup(-1);
  store.ensureGroup(-2);
  store.addWord(-1, "Spamword");
  assert.deepEqual(store.listWords(-1), ["spamword"]);
  assert.deepEqual(store.listWords(-2), []);
  assert.equal(store.removeWord(-1, "SPAMWORD"), true);
  assert.equal(store.removeWord(-1, "SPAMWORD"), false);
});

test("admins are per group", () => {
  const store = openDatabase(":memory:");
  store.addAdmin(-1, 42);
  assert.equal(store.isBotAdmin(-1, 42), true);
  assert.equal(store.isBotAdmin(-2, 42), false);
  store.removeAdmin(-1, 42);
  assert.equal(store.isBotAdmin(-1, 42), false);
});

test("logs can be disabled per group", () => {
  const store = openDatabase(":memory:");
  store.ensureGroup(-1);
  store.log(-1, "warn", { targetId: 5 });
  assert.equal(store.recentLogs(-1).length, 1);
  const s = store.getSettings(-1);
  s.logs.enabled = false;
  store.saveSettings(-1, s);
  store.log(-1, "warn", { targetId: 5 });
  assert.equal(store.recentLogs(-1).length, 1);
});

test("offset metadata round-trips", () => {
  const store = openDatabase(":memory:");
  assert.equal(store.getMeta("offset"), null);
  store.setMeta("offset", 99);
  assert.equal(store.getMeta("offset"), 99);
});

test("mergeSettings ignores unknown keys and bad types", () => {
  const merged = mergeSettings({ bogus: 1, flood: { maxMessages: "many", perSeconds: 7 } });
  assert.equal(merged.bogus, undefined);
  assert.equal(merged.flood.maxMessages, DEFAULT_SETTINGS.flood.maxMessages);
  assert.equal(merged.flood.perSeconds, 7);
});

test("toggle flips booleans and rejects non-booleans", () => {
  const s = mergeSettings({});
  toggle(s, "links.enabled");
  assert.equal(s.links.enabled, false);
  assert.throws(() => toggle(s, "flood.maxMessages"));
});

test("bounded numbers are enforced", () => {
  const s = mergeSettings({});
  setBoundedNumber(s, "warnings.limit", "5", 1, 20);
  assert.equal(s.warnings.limit, 5);
  assert.throws(() => setBoundedNumber(s, "warnings.limit", "0", 1, 20));
});

test("warnings escalate to the configured action and reset", async () => {
  const store = openDatabase(":memory:");
  store.ensureGroup(-1);
  const s = store.getSettings(-1);
  s.warnings.limit = 2;
  s.warnings.action = "ban";
  store.saveSettings(-1, s);

  const calls = [];
  const client = {
    banMember: async (c, u) => calls.push(["ban", c, u]),
    unbanMember: async () => {},
    restrictMember: async () => calls.push(["restrict"]),
  };
  const enforcer = new Enforcer({ client, store });

  const first = await enforcer.warn(-1, 9, {});
  assert.equal(first.count, 1);
  assert.equal(first.actioned, null);

  const second = await enforcer.warn(-1, 9, {});
  assert.equal(second.actioned, "ban");
  assert.deepEqual(calls, [["ban", -1, 9]]);
  assert.equal(store.getWarnings(-1, 9), 0, "counter resets after escalation");
});

test("unwarn never goes below zero", async () => {
  const store = openDatabase(":memory:");
  store.ensureGroup(-1);
  const enforcer = new Enforcer({ client: {}, store });
  assert.equal(await enforcer.unwarn(-1, 3), 0);
});

test("welcome placeholders are escaped and the user is mentioned", () => {
  const user = { id: 77, first_name: "<Eve>", username: "eve" };
  const out = renderWelcome("Hi {first_name} ({username}) in {group}", { user, groupTitle: "A&B" });
  assert.match(out, /&lt;Eve&gt;/);
  assert.match(out, /A&amp;B/);
  assert.match(out, /tg:\/\/user\?id=77/);
});

test("welcome template without placeholders still mentions the user", () => {
  const user = { id: 5, first_name: "Sam" };
  assert.match(renderWelcome("Glad you are here.", { user }), /tg:\/\/user\?id=5/);
});

test("parseButtons keeps only valid http(s) buttons", () => {
  const out = parseButtons("Site | https://example.com\nbad line\nNo | ftp://x\nRules | http://t.me/x");
  assert.deepEqual(out, [
    { text: "Site", url: "https://example.com" },
    { text: "Rules", url: "http://t.me/x" },
  ]);
});

test("parseChatRef accepts ids, handles and links", () => {
  assert.equal(parseChatRef("-1001234567890"), -1001234567890);
  assert.equal(parseChatRef("@my_channel"), "@my_channel");
  assert.equal(parseChatRef("https://t.me/my_channel"), "@my_channel");
  assert.equal(parseChatRef("not a channel!!"), null);
});

test("parseUserRef and parseDuration", () => {
  assert.deepEqual(parseUserRef("123456"), { id: 123456 });
  assert.deepEqual(parseUserRef("@some_user"), { username: "some_user" });
  assert.equal(parseUserRef("x"), null);
  assert.equal(parseDuration("30"), 30);
  assert.equal(parseDuration("2h"), 120);
  assert.equal(parseDuration("1d"), 1440);
  assert.equal(parseDuration("0m"), null);
  assert.equal(esc("<a&b>"), "&lt;a&amp;b&gt;");
});
