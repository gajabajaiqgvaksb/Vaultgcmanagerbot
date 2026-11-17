import { test } from "node:test";
import assert from "node:assert/strict";
import { createBot } from "../src/bot.js";
import { lockedFeatures } from "../src/plans.js";

const BOT_ID = 999;
const SUPER = 1;
const OWNER = 50;
const OTHER = 60;
const CHANNEL = "@freechan";

// Fake Telegram: `joined` lists users who are members of the free-plan channel.
function fakeTelegram(joined = new Set()) {
  const calls = [];
  let msgId = 700;
  const fetchImpl = async (url, opts) => {
    const method = url.split("/").pop();
    const params = JSON.parse(opts.body);
    calls.push({ method, params });
    const ok = (result) => ({ status: 200, json: async () => ({ ok: true, result }) });
    if (method === "getMe") return ok({ id: BOT_ID, username: "vaultbot", is_bot: true, can_read_all_group_messages: true });
    if (method === "getChatMember") {
      if (params.user_id === BOT_ID) {
        return ok({ status: "administrator", can_delete_messages: true, can_restrict_members: true, can_pin_messages: true });
      }
      if (params.chat_id === CHANNEL) {
        return ok({ status: joined.has(params.user_id) ? "member" : "left", user: { id: params.user_id } });
      }
      if (params.user_id === SUPER) return ok({ status: "administrator", user: { id: SUPER } });
      return ok({ status: "member", user: { id: params.user_id } });
    }
    if (method === "sendMessage") return ok({ message_id: msgId++ });
    return ok(true);
  };
  return { fetchImpl, calls };
}

const group = { id: -2001, type: "supergroup", title: "Owner Group" };
const group2 = { id: -2002, type: "supergroup", title: "Second Group" };

function makeBot(tg) {
  const bot = createBot(
    { token: "1:t", ownerIds: [SUPER], pollTimeoutSec: 1, apiBase: "https://api.telegram.org", mode: "polling", freePlanChannel: CHANNEL },
    { fetchImpl: tg.fetchImpl, dbPath: ":memory:" },
  );
  bot.store.ensureGroup(group.id, group.title);
  bot.store.ensureGroup(group2.id, group2.title);
  return bot;
}

const addBot = (bot, chat, adderId) =>
  bot.handleUpdate({
    update_id: Math.floor(Math.random() * 1e9),
    my_chat_member: { chat, from: { id: adderId, first_name: "Owner" }, new_chat_member: { status: "administrator" } },
  });

const claimPress = (bot, chat, from) =>
  bot.handleUpdate({
    update_id: Math.floor(Math.random() * 1e9),
    callback_query: { id: "c" + Math.random(), from, data: `plan:claim:${chat.id}`, message: { chat, message_id: 1 } },
  });

const lastSent = (tg) => tg.calls.filter((c) => c.method === "sendMessage").pop();
const lastAnswer = (tg) => tg.calls.filter((c) => c.method === "answerCallbackQuery").pop();

test("a normal user who adds the bot gets the free plan prompt and becomes the group owner", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await addBot(bot, group, OWNER);

  assert.equal(bot.store.isActive(group.id), false);
  assert.equal(bot.store.ownerIdOf(group.id), OWNER);
  const buttons = lastSent(tg).params.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.url === "https://t.me/freechan"));
  assert.ok(buttons.some((b) => b.callback_data === `plan:claim:${group.id}`));
});

test("claiming without joining the channel is refused", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);
  await addBot(bot, group, OWNER);

  await claimPress(bot, group, { id: OWNER });

  assert.equal(bot.store.isActive(group.id), false);
  assert.match(lastAnswer(tg).params.text, /Join @freechan first/);
});

test("after joining the channel the owner claims the free plan and can manage the group", async () => {
  const tg = fakeTelegram(new Set([OWNER]));
  const bot = makeBot(tg);
  await addBot(bot, group, OWNER);

  await claimPress(bot, group, { id: OWNER });

  assert.equal(bot.store.isActive(group.id), true);
  assert.equal(bot.store.getSettings(group.id).subscription.plan, "free");
  assert.equal(bot.permissions.canManageGroup(group.id, OWNER), true);
});

test("only the person who added the bot can claim", async () => {
  const tg = fakeTelegram(new Set([OWNER, OTHER]));
  const bot = makeBot(tg);
  await addBot(bot, group, OWNER);

  await claimPress(bot, group, { id: OTHER });

  assert.equal(bot.store.isActive(group.id), false);
  assert.match(lastAnswer(tg).params.text, /Only the person who added/);
});

test("one free group per person", async () => {
  const tg = fakeTelegram(new Set([OWNER]));
  const bot = makeBot(tg);
  await addBot(bot, group, OWNER);
  await claimPress(bot, group, { id: OWNER });

  await addBot(bot, group2, OWNER);
  await claimPress(bot, group2, { id: OWNER });

  assert.equal(bot.store.isActive(group2.id), false);
  assert.match(lastAnswer(tg).params.text, /one group per person/);
  assert.match(lastAnswer(tg).params.text, /Owner Group/);
});

test("free plan locks premium emojis and advanced thresholds for the owner, not for super admins", async () => {
  const tg = fakeTelegram(new Set([OWNER]));
  const bot = makeBot(tg);
  await addBot(bot, group, OWNER);
  await claimPress(bot, group, { id: OWNER });

  assert.ok(lockedFeatures(bot.store.getSettings(group.id)).has("emoji"));

  const ownerTurn = await bot.panel.handleCallback({ from: { id: OWNER }, data: `pn:${group.id}:warnings:c:wl` });
  assert.match(ownerTurn.alert, /paid plan/);

  const ownerEmoji = await bot.panel.handleCallback({ from: { id: OWNER }, data: `pn:${group.id}:emoji:i:e_ok` });
  assert.match(ownerEmoji.alert, /paid plan/);

  const superTurn = await bot.panel.handleCallback({ from: { id: SUPER }, data: `pn:${group.id}:warnings:c:wl` });
  assert.equal(superTurn.alert, undefined, "super admin is not locked");
  assert.equal(superTurn.screen, "warnings");
});

test("the owner cannot run templates on the free plan", async () => {
  const tg = fakeTelegram(new Set([OWNER]));
  const bot = makeBot(tg);
  await addBot(bot, group, OWNER);
  await claimPress(bot, group, { id: OWNER });

  await bot.handleUpdate({
    update_id: 9,
    message: { message_id: 3, chat: group, from: { id: OWNER, first_name: "Owner" }, text: "/settemplate" },
  });

  assert.match(lastSent(tg).params.text, /paid plan/);
  assert.equal(bot.store.getTemplate(), null);
});

test("/plan shows the free plan and the coming-soon paid plan", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate({
    update_id: 10,
    message: { message_id: 4, chat: group, from: { id: OTHER, first_name: "X" }, text: "/plan" },
  });

  assert.match(lastSent(tg).params.text, /Paid plan: coming soon/);
  assert.match(lastSent(tg).params.text, /@freechan/);
});
