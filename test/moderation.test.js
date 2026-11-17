import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkLinks,
  checkBannedWords,
  checkExcessive,
  checkForwarded,
  DuplicateTracker,
  FloodTracker,
  DEFAULT_BANNED_WORDS,
} from "../src/moderation.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

const links = DEFAULT_SETTINGS.links;

test("allows plain text", () => {
  assert.equal(checkLinks("hello everyone, how are you", links), null);
});

test("blocks external URLs by default", () => {
  assert.equal(checkLinks("see https://example.com/page", links).rule, "links");
  assert.equal(checkLinks("visit example.com today", links).rule, "links");
});

test("blocks telegram links by default", () => {
  assert.match(checkLinks("join t.me/somegroup", links).reason, /Telegram/);
});

test("allows everything when link protection is disabled", () => {
  const off = { ...links, enabled: false };
  assert.equal(checkLinks("https://example.com t.me/x", off), null);
});

test("allows external links when explicitly permitted", () => {
  const open = { ...links, allowExternal: true };
  assert.equal(checkLinks("https://example.com", open), null);
});

test("shortener links are promotional even when external links are allowed", () => {
  const open = { ...links, allowExternal: true };
  assert.match(checkLinks("grab it at bit.ly/abc", open).reason, /Promotional/);
});

test("banned words match whole words only", () => {
  assert.equal(checkBannedWords("this is FREE MONEY", DEFAULT_BANNED_WORDS)?.rule, "bannedWords");
  assert.equal(checkBannedWords("freedom of speech", ["free"]), null);
});

test("banned word matching is case and unicode-width insensitive", () => {
  assert.notEqual(checkBannedWords("ｆｒｅｅ ｍｏｎｅｙ", ["free money"]), null);
});

test("empty word list never matches", () => {
  assert.equal(checkBannedWords("anything", []), null);
});

test("excessive length and emoji limits", () => {
  const cfg = { enabled: true, maxChars: 10, maxEmojis: 2 };
  assert.match(checkExcessive("x".repeat(11), cfg).reason, /longer/);
  assert.match(checkExcessive("😀😀😀", cfg).reason, /emojis/);
  assert.equal(checkExcessive("short", cfg), null);
});

test("forwarded messages are flagged when enabled", () => {
  assert.equal(checkForwarded({ forward_date: 1 }, { enabled: false }), null);
  assert.equal(checkForwarded({ forward_date: 1 }, { enabled: true }).rule, "forwardSpam");
  assert.equal(checkForwarded({}, { enabled: true }), null);
});

test("duplicate: first occurrence allowed, identical repeat blocked", () => {
  let t = 0;
  const dup = new DuplicateTracker(() => t);
  assert.equal(dup.check(1, 7, "buy now", 300), null);
  assert.equal(dup.check(1, 7, "buy now", 300)?.rule, "duplicates");
});

test("duplicate: different user or different text is not a duplicate", () => {
  let t = 0;
  const dup = new DuplicateTracker(() => t);
  dup.check(1, 7, "hello there", 300);
  assert.equal(dup.check(1, 8, "hello there", 300), null);
  assert.equal(dup.check(1, 7, "something else", 300), null);
});

test("duplicate: repeat outside the window is allowed again", () => {
  let t = 0;
  const dup = new DuplicateTracker(() => t);
  dup.check(1, 7, "same", 60);
  t = 61_000;
  assert.equal(dup.check(1, 7, "same", 60), null);
});

test("flood: exceeding the rate triggers once per burst", () => {
  let t = 0;
  const flood = new FloodTracker(() => t);
  const cfg = { maxMessages: 3, perSeconds: 10 };
  assert.equal(flood.check(1, 7, cfg), null);
  assert.equal(flood.check(1, 7, cfg), null);
  assert.equal(flood.check(1, 7, cfg), null);
  assert.equal(flood.check(1, 7, cfg)?.rule, "flood");
  assert.equal(flood.check(1, 7, cfg), null, "window resets after triggering");
});

test("flood: slow messages never trigger", () => {
  let t = 0;
  const flood = new FloodTracker(() => t);
  const cfg = { maxMessages: 2, perSeconds: 10 };
  for (let i = 0; i < 10; i++) {
    t += 6_000;
    assert.equal(flood.check(1, 7, cfg), null);
  }
});
