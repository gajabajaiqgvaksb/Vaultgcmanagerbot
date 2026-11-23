// Owner panel: bot-wide /start message, activity log channel, and stats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBot } from "../src/bot.js";

const BOT_ID = 999;
const SUPER = 1;
const OTHER = 2;
const LOG_CHANNEL = "@owner_logs";

function fakeTelegram() {
  const calls = [];
  let nextMsgId = 800;
  const fetchImpl = async (url, opts) => {
    const method = url.split("/").pop();
    const params = JSON.parse(opts.body);
    calls.push({ method, params });
    const ok = (result) => ({ status: 200, json: async () => ({ ok: true, result }) });
    switch (method) {
      case "getMe":
        return ok({ id: BOT_ID, username: "vaultbot", is_bot: true });
      case "getChatMember": {
        if (params.user_id === BOT_ID) {
          return ok({ status: "administrator", can_delete_messages: true, can_restrict_members: true, can_pin_messages: true, can_promote_members: true });
        }
        if (params.user_id === SUPER) return ok({ status: "administrator", user: { id: SUPER } });
        return ok({ status: "member", user: { id: params.user_id } });
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
  return createBot(
    { token: "1:t", ownerIds: [SUPER], pollTimeoutSec: 1, apiBase: "https://api.telegram.org", mode: "polling" },
    { fetchImpl: tg.fetchImpl, dbPath: ":memory:" },
  );
}

const dm = (from, text) => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: { message_id: 1, chat: { id: from.id, type: "private" }, from, text },
});
const press = (from, data, chatId = from.id) => ({
  update_id: Math.floor(Math.random() * 1e9),
  callback_query: { id: "c" + Math.random(), from, data, message: { chat: { id: chatId, type: "private" }, message_id: 5 } },
});
const lastSent = (tg) => tg.calls.filter((c) => c.method === "sendMessage").pop();
const sentTo = (tg, chatId) => tg.calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === chatId);

test("/owner opens the owner panel for a super admin, and is refused for anyone else", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate(dm({ id: SUPER, first_name: "Boss" }, "/owner"));
  assert.match(lastSent(tg).params.text, /Owner panel/);
  assert.match(lastSent(tg).params.text, /Groups:/);

  await bot.handleUpdate(dm({ id: OTHER, first_name: "Random" }, "/owner"));
  assert.match(lastSent(tg).params.text, /owners only/i);
});

test("the owner can edit the /start message, with premium emoji kept, and it shows up for every DM user", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate(press({ id: SUPER }, "ow:i:st"));
  assert.match(lastSent(tg).params.text, /start message/);

  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 2,
      chat: { id: SUPER, type: "private" },
      from: { id: SUPER, first_name: "Boss" },
      text: "Welcome ⭐",
      entities: [{ type: "custom_emoji", offset: 8, length: 1, custom_emoji_id: "123456" }],
    },
  });
  assert.match(lastSent(tg).params.text, /Start message updated/);

  await bot.handleUpdate(dm({ id: OTHER, first_name: "Newbie" }, "/start"));
  assert.match(lastSent(tg).params.text, /tg-emoji emoji-id="123456"/);
});

test("the owner can set a log channel, and new DM users are reported there", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate(press({ id: SUPER }, "ow:i:lc"));
  await bot.handleUpdate(dm({ id: SUPER, first_name: "Boss" }, LOG_CHANNEL));
  assert.match(lastSent(tg).params.text, /log channel set/i);

  await bot.handleUpdate(dm({ id: OTHER, first_name: "Newbie" }, "hello"));

  const toChannel = sentTo(tg, LOG_CHANNEL);
  assert.ok(toChannel.some((c) => /New user started the bot/.test(c.params.text)));

  // A second message from the same user is not reported again.
  const before = toChannel.length;
  await bot.handleUpdate(dm({ id: OTHER, first_name: "Newbie" }, "hello again"));
  assert.equal(sentTo(tg, LOG_CHANNEL).length, before);
});

test("a group being added is reported to the log channel", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);
  bot.store.setLogChannel(LOG_CHANNEL);

  await bot.handleUpdate({
    update_id: 2,
    my_chat_member: {
      chat: { id: -500, type: "supergroup", title: "New Group" },
      from: { id: SUPER, first_name: "Boss" },
      new_chat_member: { status: "administrator" },
    },
  });

  const toChannel = sentTo(tg, LOG_CHANNEL);
  assert.ok(toChannel.some((c) => /Added to.*New Group/.test(c.params.text)));
});

test("a non-owner cannot operate the owner panel's callbacks", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate(press({ id: OTHER }, "ow:i:st"));
  const answer = tg.calls.filter((c) => c.method === "answerCallbackQuery").pop();
  assert.match(answer.params.text, /Owners only/);
});
