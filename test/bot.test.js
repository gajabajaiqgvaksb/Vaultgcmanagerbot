// End-to-end tests: drive the real dispatcher against a fake Telegram API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBot } from "../src/bot.js";

const BOT_ID = 999;
const ADMIN = 1;
const SPAMMER = 2;
const CHANNEL = "@news_chan";

function fakeTelegram({ memberStatus = {} } = {}) {
  const calls = [];
  let nextMsgId = 500;
  const fetchImpl = async (url, opts) => {
    const method = url.split("/").pop();
    const params = JSON.parse(opts.body);
    calls.push({ method, params });
    const ok = (result) => ({ status: 200, json: async () => ({ ok: true, result }) });
    switch (method) {
      case "getMe":
        return ok({ id: BOT_ID, username: "vaultbot", is_bot: true });
      case "getChatMember": {
        const uid = params.user_id;
        if (uid === BOT_ID) {
          return ok({ status: "administrator", can_delete_messages: true, can_restrict_members: true, can_pin_messages: true, can_promote_members: true });
        }
        if (uid === ADMIN) return ok({ status: "administrator", user: { id: ADMIN } });
        if (params.chat_id === CHANNEL) {
          const joined = memberStatus[uid] ?? false;
          return ok({ status: joined ? "member" : "left", user: { id: uid } });
        }
        return ok({ status: "member", user: { id: uid, first_name: "x" } });
      }
      case "sendMessage":
        return ok({ message_id: nextMsgId++ });
      default:
        return ok(true);
    }
  };
  return { fetchImpl, calls };
}

function makeBot(tg) {
  const config = { token: "123:test", ownerIds: [], pollTimeoutSec: 1, apiBase: "https://api.telegram.org" };
  return createBot(config, { fetchImpl: tg.fetchImpl, dbPath: ":memory:" });
}

const group = { id: -1001, type: "supergroup", title: "Test Group" };
const msg = (from, text, extra = {}) => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: { message_id: 10, chat: group, from, text, ...extra },
});

test("regular user posting a banned word gets the message deleted and a warning", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);
  bot.store.ensureGroup(group.id, group.title);

  await bot.handleUpdate(msg({ id: SPAMMER, first_name: "Spam" }, "Quick FREE MONEY here"));

  const del = tg.calls.find((c) => c.method === "deleteMessage");
  assert.ok(del, "message was deleted");
  assert.equal(del.params.message_id, 10);
  const warning = tg.calls.filter((c) => c.method === "sendMessage").pop();
  assert.match(warning.params.text, /prohibited word/);
  assert.equal(bot.store.getWarnings(group.id, SPAMMER), 1);
});

test("group admins are never moderated", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);
  bot.store.ensureGroup(group.id, group.title);

  await bot.handleUpdate(msg({ id: ADMIN, first_name: "Boss" }, "free money everyone"));

  assert.equal(tg.calls.some((c) => c.method === "deleteMessage"), false);
});

test("force subscribe blocks an unsubscribed member and shows the gate buttons", async () => {
  const tg = fakeTelegram({ memberStatus: { [SPAMMER]: false } });
  const bot = makeBot(tg);
  bot.store.ensureGroup(group.id, group.title);
  const s = bot.store.getSettings(group.id);
  s.forceSubscribe = { enabled: true, channel: CHANNEL };
  bot.store.saveSettings(group.id, s);

  await bot.handleUpdate(msg({ id: SPAMMER, first_name: "New" }, "hi all"));

  assert.ok(tg.calls.some((c) => c.method === "deleteMessage"), "unsubscribed message deleted");
  const gate = tg.calls.filter((c) => c.method === "sendMessage").pop();
  const buttons = gate.params.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.url === "https://t.me/news_chan"), "JOIN CHANNEL button");
  assert.ok(buttons.some((b) => b.callback_data === `fs:check:${SPAMMER}`), "I SUBSCRIBED button");
});

test("I SUBSCRIBED is rejected while the user has not joined, and only the target may press it", async () => {
  const tg = fakeTelegram({ memberStatus: { [SPAMMER]: false } });
  const bot = makeBot(tg);
  bot.store.ensureGroup(group.id, group.title);
  const s = bot.store.getSettings(group.id);
  s.forceSubscribe = { enabled: true, channel: CHANNEL };
  bot.store.saveSettings(group.id, s);

  const press = (from) => ({
    update_id: 1,
    callback_query: { id: "cb1", from, data: `fs:check:${SPAMMER}`, message: { chat: group, message_id: 3 } },
  });

  await bot.handleUpdate(press({ id: 77 }));
  const wrong = tg.calls.filter((c) => c.method === "answerCallbackQuery").pop();
  assert.match(wrong.params.text, /sent to/);
  assert.equal(wrong.params.show_alert, true);

  await bot.handleUpdate(press({ id: SPAMMER }));
  const notJoined = tg.calls.filter((c) => c.method === "answerCallbackQuery").pop();
  assert.match(notJoined.params.text, /not joined/);
});

test("I SUBSCRIBED succeeds once Telegram confirms membership", async () => {
  const tg = fakeTelegram({ memberStatus: { [SPAMMER]: true } });
  const bot = makeBot(tg);
  bot.store.ensureGroup(group.id, group.title);
  const s = bot.store.getSettings(group.id);
  s.forceSubscribe = { enabled: true, channel: CHANNEL };
  bot.store.saveSettings(group.id, s);

  await bot.handleUpdate({
    update_id: 2,
    callback_query: { id: "cb2", from: { id: SPAMMER }, data: `fs:check:${SPAMMER}`, message: { chat: group, message_id: 3 } },
  });
  const ans = tg.calls.filter((c) => c.method === "answerCallbackQuery").pop();
  assert.match(ans.params.text, /confirmed/);
  assert.equal(ans.params.show_alert, false);
});

test("non-admins cannot operate the panel", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);
  bot.store.ensureGroup(group.id, group.title);

  await bot.handleUpdate({
    update_id: 3,
    callback_query: {
      id: "cb3",
      from: { id: SPAMMER },
      data: `pn:${group.id}:flood:t:fl`,
      message: { chat: group, message_id: 4 },
    },
  });

  const ans = tg.calls.filter((c) => c.method === "answerCallbackQuery").pop();
  assert.match(ans.params.text, /Only group admins/);
  assert.equal(bot.store.getSettings(group.id).flood.enabled, true, "setting untouched");
});

test("an admin toggles a setting from the panel and the change persists", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);
  bot.store.ensureGroup(group.id, group.title);

  await bot.handleUpdate({
    update_id: 4,
    callback_query: {
      id: "cb4",
      from: { id: ADMIN },
      data: `pn:${group.id}:flood:t:fl`,
      message: { chat: group, message_id: 4 },
    },
  });

  assert.equal(bot.store.getSettings(group.id).flood.enabled, false);
  assert.ok(tg.calls.some((c) => c.method === "editMessageText"), "panel re-rendered in place");
});

test("a banned word typed by an admin during a prompt is saved, not moderated", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);
  bot.store.ensureGroup(group.id, group.title);
  bot.inputs.set(group.id, ADMIN, "ai");

  await bot.handleUpdate(msg({ id: ADMIN, first_name: "Boss" }, "casino royale"));

  assert.deepEqual(bot.store.listWords(group.id), ["casino royale"]);
  assert.equal(tg.calls.some((c) => c.method === "deleteMessage"), false);
});

test("/rules is available to ordinary members", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);
  bot.store.ensureGroup(group.id, group.title);
  bot.store.setRules(group.id, "Be kind.");

  await bot.handleUpdate(msg({ id: SPAMMER, first_name: "Member" }, "/rules"));

  const reply = tg.calls.filter((c) => c.method === "sendMessage").pop();
  assert.match(reply.params.text, /Be kind\./);
});

test("admin-only commands are refused for ordinary members", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);
  bot.store.ensureGroup(group.id, group.title);

  await bot.handleUpdate(msg({ id: SPAMMER, first_name: "Member" }, "/lock"));

  assert.equal(tg.calls.some((c) => c.method === "setChatPermissions"), false);
  const reply = tg.calls.filter((c) => c.method === "sendMessage").pop();
  assert.match(reply.params.text, /Only group admins/);
});
