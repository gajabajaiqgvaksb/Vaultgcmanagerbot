import { test } from "node:test";
import assert from "node:assert/strict";
import { entitiesToHtml, firstCustomEmojiId } from "../src/entities.js";
import { emojiHtml, emojiPlain, EMOJI_SLOTS } from "../src/emoji.js";
import { mergeSettings } from "../src/settings.js";
import { openDatabase } from "../src/db.js";
import { Panel, PendingInputs } from "../src/panel.js";
import { PermissionService } from "../src/permissions.js";
import { renderWelcome } from "../src/welcome.js";

test("plain text is escaped and unchanged otherwise", () => {
  assert.equal(entitiesToHtml("a < b & c"), "a &lt; b &amp; c");
});

test("custom emoji entity becomes a tg-emoji tag with its fallback character", () => {
  const text = "Hi ⭐ there";
  const html = entitiesToHtml(text, [{ type: "custom_emoji", offset: 3, length: 1, custom_emoji_id: "5368324170671202286" }]);
  assert.equal(html, 'Hi <tg-emoji emoji-id="5368324170671202286">⭐</tg-emoji> there');
});

test("offsets work after astral characters (surrogate pairs)", () => {
  // 😀 is two UTF-16 code units, so the star starts at offset 3, not 2.
  const text = "😀 ⭐";
  const html = entitiesToHtml(text, [{ type: "custom_emoji", offset: 3, length: 1, custom_emoji_id: "123456789" }]);
  assert.equal(html, '😀 <tg-emoji emoji-id="123456789">⭐</tg-emoji>');
});

test("bold and links keep formatting and are escaped", () => {
  const text = "Read rules now";
  const html = entitiesToHtml(text, [
    { type: "bold", offset: 0, length: 4 },
    { type: "text_link", offset: 11, length: 3, url: "https://example.com/?a=1&b=2" },
  ]);
  assert.equal(html, '<b>Read</b> rules <a href="https://example.com/?a=1&amp;b=2">now</a>');
});

test("firstCustomEmojiId finds the premium emoji or returns null", () => {
  assert.equal(firstCustomEmojiId([{ type: "bold" }, { type: "custom_emoji", custom_emoji_id: "42" }]), "42");
  assert.equal(firstCustomEmojiId([{ type: "bold" }]), null);
  assert.equal(firstCustomEmojiId(undefined), null);
});

test("emojiHtml uses the premium tag when a slot is mapped, otherwise the default", () => {
  assert.equal(emojiHtml("ok", {}), "✅");
  assert.equal(emojiHtml("ok", { ok: "999888777" }), '<tg-emoji emoji-id="999888777">✅</tg-emoji>');
  assert.equal(emojiPlain("warn"), EMOJI_SLOTS.warn.fallback);
});

test("settings keep only valid numeric emoji ids", () => {
  const s = mergeSettings({ emoji: { ok: "5368324170671202286", off: "abc", warn: "12" } });
  assert.deepEqual(s.emoji, { ok: "5368324170671202286" });
});

test("welcome text saved from a premium emoji message renders with the premium tag", () => {
  const user = { id: 5, first_name: "Sam" };
  const stored = entitiesToHtml("Welcome {first_name} ⭐", [
    { type: "custom_emoji", offset: 21, length: 1, custom_emoji_id: "5368324170671202286" },
  ]);
  const out = renderWelcome(stored, { user, groupTitle: "G" });
  assert.match(out, /Welcome Sam <tg-emoji emoji-id="5368324170671202286">⭐<\/tg-emoji>/);
});

test("admin sets a premium emoji for a slot from the panel; a normal emoji is rejected", async () => {
  const store = openDatabase(":memory:");
  store.ensureGroup(-7, "G");
  const permissions = new PermissionService({ client: { getChatMember: async () => ({ status: "member" }) }, ownerIds: [1] });
  const inputs = new PendingInputs();
  const panel = new Panel({ client: {}, store, permissions, inputs });

  const press = await panel.handleCallback({ from: { id: 1 }, data: "pn:-7:emoji:i:e_ok" });
  assert.match(press.prompt, /premium/);

  const rejected = await panel.handleInput({ chat: { id: -7 }, from: { id: 1 }, text: "✅", entities: [] });
  assert.match(rejected, /not a premium emoji/);
  // The prompt is consumed by the first message, so re-arm for the real test.
  inputs.set(-7, 1, "e_ok");

  const accepted = await panel.handleInput({
    chat: { id: -7 },
    from: { id: 1 },
    text: "✅",
    entities: [{ type: "custom_emoji", offset: 0, length: 1, custom_emoji_id: "5368324170671202286" }],
  });
  assert.match(accepted, /now uses your premium emoji/);
  assert.equal(store.getSettings(-7).emoji.ok, "5368324170671202286");

  await panel.handleCallback({ from: { id: 1 }, data: "pn:-7:emoji:x:ce_ok" });
  assert.equal(store.getSettings(-7).emoji.ok, undefined);
});

test("welcome input from an admin is stored as HTML with formatting kept", async () => {
  const store = openDatabase(":memory:");
  store.ensureGroup(-8, "G");
  const permissions = new PermissionService({ client: {}, ownerIds: [1] });
  const inputs = new PendingInputs();
  const panel = new Panel({ client: {}, store, permissions, inputs });
  inputs.set(-8, 1, "wt");

  await panel.handleInput({
    chat: { id: -8 },
    from: { id: 1 },
    text: "Hello {first_name} ⭐ <rules>",
    entities: [
      { type: "bold", offset: 0, length: 5 },
      { type: "custom_emoji", offset: 19, length: 1, custom_emoji_id: "5368324170671202286" },
    ],
  });

  assert.equal(
    store.getSettings(-8).welcome.text,
    '<b>Hello</b> {first_name} <tg-emoji emoji-id="5368324170671202286">⭐</tg-emoji> &lt;rules&gt;',
  );
});
