import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";

// Simulates a restart: state saved from one store must restore into a fresh one.
test("exported state restores everything into a fresh store", () => {
  const before = openDatabase(":memory:");
  before.ensureGroup(-100, "Restored Group");
  const s = before.getSettings(-100);
  s.welcome.text = "<b>Hi</b> {first_name}";
  s.emoji.ok = "5368324170671202286";
  s.warnings.limit = 5;
  s.subscription.ownerId = 77;
  before.saveSettings(-100, s);
  before.setActive(-100, true);
  before.addWord(-100, "casino royale");
  before.setRules(-100, "Be kind.");
  before.setWarnings(-100, 9, 2);
  before.setClaim(77, -100);
  before.addAdmin(-100, 5);
  before.log(-100, "warn", { targetId: 9 });
  before.setMeta("offset", 123);
  before.saveTemplate(before.getSettings(-100));

  const snapshot = JSON.parse(JSON.stringify(before.exportAll()));

  const after = openDatabase(":memory:");
  after.importAll(snapshot);

  const g = after.getGroup(-100);
  assert.equal(g.title, "Restored Group");
  assert.equal(g.rules, "Be kind.");
  assert.equal(after.getSettings(-100).welcome.text, "<b>Hi</b> {first_name}");
  assert.equal(after.getSettings(-100).emoji.ok, "5368324170671202286");
  assert.equal(after.getSettings(-100).warnings.limit, 5);
  assert.equal(after.isActive(-100), true);
  assert.equal(after.ownerIdOf(-100), 77);
  assert.deepEqual(after.listWords(-100), ["casino royale"]);
  assert.equal(after.getWarnings(-100, 9), 2);
  assert.equal(after.claimOf(77), -100);
  assert.equal(after.isBotAdmin(-100, 5), true);
  assert.equal(after.recentLogs(-100).length, 1);
  assert.equal(after.getMeta("offset"), 123);
  assert.equal(after.getTemplate().warnings.limit, 5);
});

test("importing a new snapshot replaces old state rather than merging", () => {
  const store = openDatabase(":memory:");
  store.ensureGroup(-1, "Old");
  store.addWord(-1, "oldword");
  store.importAll({ groups: [], banned_words: [] });
  assert.equal(store.getGroup(-1), null);
  assert.deepEqual(store.listWords(-1), []);
});
