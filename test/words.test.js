import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WORDS } from "../src/default_words.js";
import { checkBannedWords, DEFAULT_BANNED_WORDS } from "../src/moderation.js";
import { describeViolation } from "../src/pipeline.js";
import { openDatabase } from "../src/db.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

test("default list is deduplicated and has no single-letter or generic insult entries", () => {
  assert.equal(new Set(DEFAULT_WORDS).size, DEFAULT_WORDS.length);
  assert.ok(DEFAULT_WORDS.every((w) => w.length >= 2));
  assert.ok(!DEFAULT_WORDS.includes("stupid"));
  assert.ok(!DEFAULT_WORDS.includes("free"), "phrases are not split into single words");
  assert.ok(DEFAULT_WORDS.includes("free money"));
  assert.equal(DEFAULT_BANNED_WORDS, DEFAULT_WORDS);
});

test("finds every distinct banned word in a message", () => {
  const found = checkBannedWords("tum to chutiya ho, aur ye fuck hai", DEFAULT_WORDS);
  assert.deepEqual(found.matched.sort(), ["chutiya", "fuck"]);
});

test("whole-word only: substrings of clean words do not match", () => {
  assert.equal(checkBannedWords("the classroom assessment was fine", ["ass"]), null);
  assert.equal(checkBannedWords("I love my assistant", ["ass"]), null);
});

test("more than four banned words gets a generic reason without listing them", () => {
  const text = "fuck shit bitch cunt slut whore";
  const v = checkBannedWords(text, DEFAULT_WORDS);
  assert.ok(v.matched.length > 4);
  assert.equal(describeViolation(v, 4), "Message contains several prohibited words");
});

test("four or fewer banned words are named in the warning", () => {
  const v = checkBannedWords("this is fuck and shit", DEFAULT_WORDS);
  assert.equal(describeViolation(v, 4), "Banned word used: <code>fuck</code>, <code>shit</code>");
});

test("reveal can be turned off (0) or lowered in settings", () => {
  const v = checkBannedWords("fuck", DEFAULT_WORDS);
  assert.equal(describeViolation(v, 0), "Message contains several prohibited words");
  assert.equal(DEFAULT_SETTINGS.warnings.revealWordsUpTo, 4);
});

test("template saved from one group is applied to another, keeping that group's channel", () => {
  const store = openDatabase(":memory:");
  store.ensureGroup(-1, "Source");
  store.ensureGroup(-2, "Target");

  const src = store.getSettings(-1);
  src.welcome.text = "Welcome to the premium group, {first_name}!";
  src.warnings.limit = 5;
  src.forceSubscribe.channel = "@source_channel";
  store.saveSettings(-1, src);
  store.saveTemplate(store.getSettings(-1));

  const tgt = store.getSettings(-2);
  tgt.forceSubscribe = { enabled: true, channel: "@target_channel" };
  tgt.subscription.active = true;
  store.saveSettings(-2, tgt);

  assert.equal(store.applyTemplate(-2), true);
  const after = store.getSettings(-2);
  assert.equal(after.welcome.text, "Welcome to the premium group, {first_name}!");
  assert.equal(after.warnings.limit, 5);
  assert.equal(after.forceSubscribe.channel, "@target_channel", "channel is kept per group");
  assert.equal(after.subscription.active, true, "subscription state is kept");
});

test("applyTemplate returns false when no template exists", () => {
  const store = openDatabase(":memory:");
  store.ensureGroup(-5, "x");
  assert.equal(store.applyTemplate(-5), false);
});
