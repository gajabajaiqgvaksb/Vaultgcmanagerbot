// End-to-end tests: drive the real dispatcher against a fake Telegram API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBot } from "../src/bot.js";
import { SUBSCRIPTION_SOON } from "../src/util.js";

const BOT_ID = 999;
const SUPER = 1; // super admin (OWNER_IDS)
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
        if (uid === SUPER) return ok({ status: "administrator", user: { id: SUPER } });
        if (params.chat_id === CHANNEL) {
          const joined = memberStatus[uid] ?? false;
          return ok({ status: joined ? "member" : "left", user: { id: uid } });
        }
        return ok({ status: "member", user: { id: uid, first_name: "x" } });
      }
      case "getChatAdministrators":
        return ok([
          { status: "creator", user: { id: SUPER, first_name: "Boss" } },
          { status: "administrator", user: { id: BOT_ID, first_name: "vaultbot", is_bot: true } },
        ]);
      case "sendMessage":
        return ok({ message_id: nextMsgId++ });
      default:
        return ok(true);
    }
  };
  return { fetchImpl, calls };
}

// A bot whose only super admin is SUPER. The group is activated unless told otherwise.
function makeBot(tg, { activate = true } = {}) {
  const config = { token: "123:test", ownerIds: [SUPER], pollTimeoutSec: 1, apiBase: "https://api.telegram.org", mode: "polling" };
  const bot = createBot(config, { fetchImpl: tg.fetchImpl, dbPath: ":memory:" });
  bot.store.ensureGroup(group.id, group.title);
  if (activate) bot.store.setActive(group.id, true);
  return bot;
}

const group = { id: -1001, type: "supergroup", title: "Test Group" };
const msg = (from, text, extra = {}) => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: { message_id: 10, chat: group, from, text, ...extra },
});
const lastSent = (tg) => tg.calls.filter((c) => c.method === "sendMessage").pop();
const lastAnswer = (tg) => tg.calls.filter((c) => c.method === "answerCallbackQuery").pop();

test("regular user posting a banned word gets the message deleted and a warning", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate(msg({ id: SPAMMER, first_name: "Spam" }, "Quick FREE MONEY here"));

  const del = tg.calls.find((c) => c.method === "deleteMessage");
  assert.ok(del, "message was deleted");
  assert.equal(del.params.message_id, 10);
  assert.match(lastSent(tg).params.text, /Banned word used: <code>free money<\/code>/);
  assert.equal(bot.store.getWarnings(group.id, SPAMMER), 1);
});

test("moderation is off in groups that are not activated", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg, { activate: false });

  await bot.handleUpdate(msg({ id: SPAMMER, first_name: "Spam" }, "Quick FREE MONEY here"));

  assert.equal(tg.calls.some((c) => c.method === "deleteMessage"), false);
});

test("super admins are never moderated", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate(msg({ id: SUPER, first_name: "Boss" }, "free money everyone"));

  assert.equal(tg.calls.some((c) => c.method === "deleteMessage"), false);
});

test("adding the bot as a normal user leaves the group inactive and says subscription coming soon", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg, { activate: false });

  await bot.handleUpdate({
    update_id: 10,
    my_chat_member: {
      chat: group,
      from: { id: SPAMMER, first_name: "Normal" },
      new_chat_member: { status: "administrator" },
    },
  });

  assert.equal(bot.store.isActive(group.id), false);
  assert.equal(lastSent(tg).params.text, SUBSCRIPTION_SOON);
});

test("adding the bot as a super admin activates the group", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg, { activate: false });

  await bot.handleUpdate({
    update_id: 11,
    my_chat_member: {
      chat: group,
      from: { id: SUPER, first_name: "Super" },
      new_chat_member: { status: "administrator" },
    },
  });

  assert.equal(bot.store.isActive(group.id), true);
  assert.match(lastSent(tg).params.text, /Group activated/);
});

test("normal group admins cannot use admin commands; they get the subscription message", async () => {
  const tg = fakeTelegram();
  const groupAdmin = 3;
  // This user is a Telegram admin of the group, but not a super admin.
  const original = tg.fetchImpl;
  const fetchImpl = async (url, opts) => {
    const params = JSON.parse(opts.body);
    if (url.endsWith("/getChatMember") && params.user_id === groupAdmin) {
      return { status: 200, json: async () => ({ ok: true, result: { status: "administrator", user: { id: groupAdmin } } }) };
    }
    return original(url, opts);
  };
  const bot = createBot(
    { token: "123:test", ownerIds: [SUPER], pollTimeoutSec: 1, apiBase: "https://api.telegram.org", mode: "polling" },
    { fetchImpl, dbPath: ":memory:" },
  );
  bot.store.ensureGroup(group.id, group.title);
  bot.store.setActive(group.id, true);

  await bot.handleUpdate(msg({ id: groupAdmin, first_name: "GroupAdmin" }, "/lock"));

  assert.equal(tg.calls.some((c) => c.method === "setChatPermissions"), false);
  assert.equal(lastSent(tg).params.text, SUBSCRIPTION_SOON);
});

test("force subscribe blocks an unsubscribed member and shows the gate buttons", async () => {
  const tg = fakeTelegram({ memberStatus: { [SPAMMER]: false } });
  const bot = makeBot(tg);
  const s = bot.store.getSettings(group.id);
  s.forceSubscribe = { enabled: true, channel: CHANNEL };
  bot.store.saveSettings(group.id, s);

  await bot.handleUpdate(msg({ id: SPAMMER, first_name: "New" }, "hi all"));

  assert.ok(tg.calls.some((c) => c.method === "deleteMessage"), "unsubscribed message deleted");
  const buttons = lastSent(tg).params.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.url === "https://t.me/news_chan"), "JOIN CHANNEL button");
  assert.ok(buttons.some((b) => b.callback_data === `fs:check:${SPAMMER}`), "I SUBSCRIBED button");
});

test("I SUBSCRIBED is rejected while the user has not joined, and only the target may press it", async () => {
  const tg = fakeTelegram({ memberStatus: { [SPAMMER]: false } });
  const bot = makeBot(tg);
  const s = bot.store.getSettings(group.id);
  s.forceSubscribe = { enabled: true, channel: CHANNEL };
  bot.store.saveSettings(group.id, s);

  const press = (from) => ({
    update_id: 1,
    callback_query: { id: "cb1", from, data: `fs:check:${SPAMMER}`, message: { chat: group, message_id: 3 } },
  });

  await bot.handleUpdate(press({ id: 77 }));
  assert.match(lastAnswer(tg).params.text, /sent to/);
  assert.equal(lastAnswer(tg).params.show_alert, true);

  await bot.handleUpdate(press({ id: SPAMMER }));
  assert.match(lastAnswer(tg).params.text, /not joined/);
});

test("I SUBSCRIBED succeeds once Telegram confirms membership", async () => {
  const tg = fakeTelegram({ memberStatus: { [SPAMMER]: true } });
  const bot = makeBot(tg);
  const s = bot.store.getSettings(group.id);
  s.forceSubscribe = { enabled: true, channel: CHANNEL };
  bot.store.saveSettings(group.id, s);

  await bot.handleUpdate({
    update_id: 2,
    callback_query: { id: "cb2", from: { id: SPAMMER }, data: `fs:check:${SPAMMER}`, message: { chat: group, message_id: 3 } },
  });
  assert.match(lastAnswer(tg).params.text, /confirmed/);
  assert.equal(lastAnswer(tg).params.show_alert, false);
  const del = tg.calls.filter((c) => c.method === "deleteMessage").pop();
  assert.deepEqual(del.params, { chat_id: group.id, message_id: 3 }, "the gate message is cleared once subscribed");
});

test("the banned-word warning shows the admin's configured emoji", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);
  const s = bot.store.getSettings(group.id);
  s.emoji.warn = "🔥";
  bot.store.saveSettings(group.id, s);

  await bot.handleUpdate(msg({ id: SPAMMER, first_name: "Spam" }, "free money free money"));
  assert.match(lastSent(tg).params.text, /^🔥 /, "banned-word warning uses the configured emoji");
});

test("the force-subscribe gate message shows the admin's configured emoji", async () => {
  const tg = fakeTelegram({ memberStatus: { [SPAMMER]: false } });
  const bot = makeBot(tg);
  const s = bot.store.getSettings(group.id);
  s.emoji.channel = "📢";
  s.forceSubscribe = { enabled: true, channel: CHANNEL };
  bot.store.saveSettings(group.id, s);

  await bot.handleUpdate(msg({ id: SPAMMER, first_name: "Spam" }, "hello"));
  assert.match(lastSent(tg).params.text, /^📢 /, "gate message uses the configured emoji");
});

test("non-super-admins cannot operate the panel; they see the subscription message", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate({
    update_id: 3,
    callback_query: {
      id: "cb3",
      from: { id: SPAMMER },
      data: `pn:${group.id}:flood:t:fl`,
      message: { chat: { id: SPAMMER, type: "private" }, message_id: 4 },
    },
  });

  assert.equal(lastAnswer(tg).params.text, SUBSCRIPTION_SOON);
  assert.equal(bot.store.getSettings(group.id).flood.enabled, true, "setting untouched");
});

test("a super admin toggles a setting from the panel and the change persists", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate({
    update_id: 4,
    callback_query: {
      id: "cb4",
      from: { id: SUPER },
      data: `pn:${group.id}:flood:t:fl`,
      message: { chat: { id: SUPER, type: "private" }, message_id: 4 },
    },
  });

  assert.equal(bot.store.getSettings(group.id).flood.enabled, false);
  assert.ok(tg.calls.some((c) => c.method === "editMessageText"), "panel re-rendered in place");
});

test("a banned word typed by a super admin during a prompt is saved, not moderated", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);
  bot.inputs.set(SUPER, "ai", group.id);

  // The admin types the word in their private chat with the bot.
  await bot.handleUpdate({
    update_id: 77,
    message: { message_id: 11, chat: { id: SUPER, type: "private" }, from: { id: SUPER, first_name: "Boss" }, text: "casino royale" },
  });

  assert.deepEqual(bot.store.listWords(group.id), ["casino royale"]);
  assert.equal(tg.calls.some((c) => c.method === "deleteMessage"), false);
});

test("/rules is available to ordinary members", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);
  bot.store.setRules(group.id, "Be kind.");

  await bot.handleUpdate(msg({ id: SPAMMER, first_name: "Member" }, "/rules"));

  assert.match(lastSent(tg).params.text, /Be kind\./);
});

test("admin-only commands are refused for ordinary members", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate(msg({ id: SPAMMER, first_name: "Member" }, "/lock"));

  assert.equal(tg.calls.some((c) => c.method === "setChatPermissions"), false);
  assert.equal(lastSent(tg).params.text, SUBSCRIPTION_SOON);
});

test("/activate and /deactivate work only for super admins", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg, { activate: false });

  await bot.handleUpdate(msg({ id: SPAMMER, first_name: "Member" }, "/activate"));
  assert.equal(bot.store.isActive(group.id), false);

  await bot.handleUpdate(msg({ id: SUPER, first_name: "Super" }, "/activate"));
  assert.equal(bot.store.isActive(group.id), true);

  await bot.handleUpdate(msg({ id: SUPER, first_name: "Super" }, "/deactivate"));
  assert.equal(bot.store.isActive(group.id), false);
});

test("/status reports activation and privacy mode to a super admin", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);
  bot.permissions.botCanReadAll = false;

  await bot.handleUpdate(msg({ id: SUPER, first_name: "Super" }, "/status"));

  const text = lastSent(tg).params.text;
  assert.match(text, /Activated: yes/);
  assert.match(text, /Sees all messages: NO/);
  assert.match(text, /Bot is admin: yes/);
});

test("/status is refused for normal members", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate(msg({ id: SPAMMER, first_name: "Member" }, "/status"));

  assert.equal(lastSent(tg).params.text, SUBSCRIPTION_SOON);
});

test("/panel in a group opens the admin panel directly in the group", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate(msg({ id: SUPER, first_name: "Boss" }, "/panel"));

  const sent = lastSent(tg).params;
  assert.equal(sent.chat_id, group.id);
  assert.match(sent.text, /Admin panel/);
});

test("a panel button pressed in the group toggles the setting in place, no DM needed", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate({
    update_id: 90,
    callback_query: {
      id: "cb90",
      from: { id: SUPER },
      data: `pn:${group.id}:flood:t:fl`,
      message: { chat: group, message_id: 4 },
    },
  });

  assert.equal(bot.store.getSettings(group.id).flood.enabled, false);
  assert.ok(tg.calls.some((c) => c.method === "editMessageText"), "panel re-rendered in the group");
});

test("a text prompt from the group panel is sent to the admin's DM, and typing the answer in the group still works", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate({
    update_id: 91,
    callback_query: {
      id: "cb91",
      from: { id: SUPER },
      data: `pn:${group.id}:words:i:ai`,
      message: { chat: group, message_id: 4 },
    },
  });
  assert.match(lastSent(tg).params.text, /banned word/);
  assert.equal(lastSent(tg).params.chat_id, SUPER, "prompt goes to the admin's DM");

  await bot.handleUpdate(msg({ id: SUPER, first_name: "Boss" }, "casino royale"));

  assert.deepEqual(bot.store.listWords(group.id), ["casino royale"]);
});

test("deep link /start g<id> opens the group's settings in the admin's private chat", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate({
    update_id: 78,
    message: { message_id: 12, chat: { id: SUPER, type: "private" }, from: { id: SUPER, first_name: "Boss" }, text: "/start g1001" },
  });

  const sent = lastSent(tg).params;
  assert.equal(sent.chat_id, SUPER);
  assert.match(sent.text, /Admin panel/);
  assert.match(sent.text, /Test Group/);
  assert.ok(JSON.stringify(sent.reply_markup).includes(`pn:${group.id}:`));
});

test("a non-admin following the settings link gets the subscription message, not the panel", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate({
    update_id: 79,
    message: { message_id: 13, chat: { id: SPAMMER, type: "private" }, from: { id: SPAMMER, first_name: "Member" }, text: "/start g1001" },
  });

  assert.equal(lastSent(tg).params.text, SUBSCRIPTION_SOON);
});

test("when a group is upgraded to a supergroup, its settings and rules move to the new chat id", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);
  bot.store.setRules(group.id, "Old rules");

  await bot.handleUpdate({
    update_id: 80,
    message: {
      message_id: 14,
      chat: { id: -1009, type: "supergroup", title: "Test Group" },
      from: { id: SUPER, first_name: "Boss" },
      migrate_from_chat_id: group.id,
    },
  });

  assert.equal(bot.store.getGroup(-1009).rules, "Old rules");
  assert.equal(bot.store.isActive(-1009), true);
});

test("enabling welcome from the panel makes the bot greet a new member", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  // welcome.enabled is off by default: toggle it on through the panel, in the group.
  await bot.handleUpdate({
    update_id: 92,
    callback_query: {
      id: "cb92",
      from: { id: SUPER },
      data: `pn:${group.id}:welcome:t:wc`,
      message: { chat: group, message_id: 4 },
    },
  });
  assert.equal(bot.store.getSettings(group.id).welcome.enabled, true);

  await bot.handleUpdate({
    update_id: 93,
    message: {
      message_id: 20,
      chat: group,
      new_chat_members: [{ id: 42, first_name: "Newbie", is_bot: false }],
    },
  });

  const welcomeMsg = tg.calls.filter((c) => c.method === "sendMessage").pop();
  assert.equal(welcomeMsg.params.chat_id, group.id);
  assert.match(welcomeMsg.params.text, /Newbie/);
});

test("welcome stays off until explicitly enabled, even once a group is active", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate({
    update_id: 94,
    message: {
      message_id: 21,
      chat: group,
      new_chat_members: [{ id: 43, first_name: "Quiet", is_bot: false }],
    },
  });

  assert.equal(tg.calls.some((c) => c.method === "sendMessage" && /Quiet/.test(c.params.text ?? "")), false);
});

test("welcome also fires from a chat_member update (Telegram often skips the join service message)", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);
  const s = bot.store.getSettings(group.id);
  s.welcome.enabled = true;
  bot.store.saveSettings(group.id, s);

  await bot.handleUpdate({
    update_id: 95,
    chat_member: {
      chat: group,
      from: { id: 55, first_name: "Someone" },
      old_chat_member: { status: "left", user: { id: 55, first_name: "Someone" } },
      new_chat_member: { status: "member", user: { id: 55, first_name: "Someone" } },
    },
  });

  const welcomeMsg = lastSent(tg);
  assert.match(welcomeMsg.params.text, /Someone/);
});

test("chat_member for someone who was already a member (e.g. promoted) is not a join, no welcome", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);
  const s = bot.store.getSettings(group.id);
  s.welcome.enabled = true;
  bot.store.saveSettings(group.id, s);

  await bot.handleUpdate({
    update_id: 96,
    chat_member: {
      chat: group,
      from: { id: 56, first_name: "Promoted" },
      old_chat_member: { status: "member", user: { id: 56, first_name: "Promoted" } },
      new_chat_member: { status: "administrator", user: { id: 56, first_name: "Promoted" } },
    },
  });

  assert.equal(tg.calls.some((c) => c.method === "sendMessage" && /Promoted/.test(c.params.text ?? "")), false);
});

test("a join reported by both new_chat_members and chat_member only welcomes once", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);
  const s = bot.store.getSettings(group.id);
  s.welcome.enabled = true;
  bot.store.saveSettings(group.id, s);

  await bot.handleUpdate({
    update_id: 97,
    chat_member: {
      chat: group,
      from: { id: 57, first_name: "Dup" },
      old_chat_member: { status: "left", user: { id: 57, first_name: "Dup" } },
      new_chat_member: { status: "member", user: { id: 57, first_name: "Dup" } },
    },
  });
  await bot.handleUpdate({
    update_id: 98,
    message: {
      message_id: 22,
      chat: group,
      new_chat_members: [{ id: 57, first_name: "Dup", is_bot: false }],
    },
  });

  const welcomes = tg.calls.filter((c) => c.method === "sendMessage" && /Dup/.test(c.params.text ?? ""));
  assert.equal(welcomes.length, 1);
});

test("/start in a private chat shows an Add-to-group, My groups, and Subscription button", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate({
    update_id: 95,
    message: { message_id: 22, chat: { id: SUPER, type: "private" }, from: { id: SUPER, first_name: "Boss" }, text: "/start" },
  });

  const sent = lastSent(tg).params;
  const buttons = sent.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.url === "https://t.me/vaultbot?startgroup=true"), "Add me to a group button");
  assert.ok(buttons.some((b) => b.callback_data === "dm:mygroups"), "My groups button");
  assert.ok(buttons.some((b) => b.callback_data === "dm:plan"), "Subscription button");
});

test("the My groups button lists groups the admin manages, pressed from the private chat", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate({
    update_id: 96,
    callback_query: {
      id: "cb96",
      from: { id: SUPER },
      data: "dm:mygroups",
      message: { chat: { id: SUPER, type: "private" }, message_id: 23 },
    },
  });

  const sent = lastSent(tg).params;
  assert.match(sent.text, /Your groups/);
  assert.ok(JSON.stringify(sent.reply_markup).includes(`pn:${group.id}:`));
});

test("the Subscription button explains the free plan and the admin-only rule", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate({
    update_id: 97,
    callback_query: {
      id: "cb97",
      from: { id: SUPER },
      data: "dm:plan",
      message: { chat: { id: SUPER, type: "private" }, message_id: 24 },
    },
  });

  assert.match(lastSent(tg).params.text, /admin of the group can activate/);
});

test("/tban temporarily bans a user with an until_date", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate(
    msg({ id: SUPER, first_name: "Boss" }, "/tban 2h spam", {
      reply_to_message: { from: { id: SPAMMER, first_name: "Spam" }, message_id: 9 },
    }),
  );

  const ban = tg.calls.filter((c) => c.method === "banChatMember").pop();
  assert.equal(ban.params.user_id, SPAMMER);
  assert.ok(ban.params.until_date > Date.now() / 1000, "until_date is in the future");
  assert.match(lastSent(tg).params.text, /banned for 120 minute/);
});

test("/admins lists the group's admins (bots excluded)", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate(msg({ id: SPAMMER, first_name: "Member" }, "/admins"));

  assert.match(lastSent(tg).params.text, /Group admins/);
  assert.match(lastSent(tg).params.text, /Boss/);
  assert.equal(/vaultbot/.test(lastSent(tg).params.text), false, "the bot itself is excluded");
});

test("/report tags the admins on the replied message, available to any member", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate(msg({ id: SPAMMER, first_name: "Member" }, "/report", {
    reply_to_message: { message_id: 42, from: { id: 55, first_name: "Jerk" } },
  }));

  const sent = lastSent(tg).params;
  assert.equal(sent.reply_to_message_id, 42);
  assert.match(sent.text, /reported a message/);
  assert.match(sent.text, /Boss/);
});

test("/del removes the replied message and the command itself", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.handleUpdate(msg({ id: SUPER, first_name: "Boss" }, "/del", {
    reply_to_message: { message_id: 42, from: { id: SPAMMER } },
  }));

  const deletes = tg.calls.filter((c) => c.method === "deleteMessage").map((c) => c.params.message_id);
  assert.ok(deletes.includes(42), "the reported message is deleted");
});

test("the command menu is registered for private chats, members and admins", async () => {
  const tg = fakeTelegram();
  const bot = makeBot(tg);

  await bot.registerCommands();

  const setCalls = tg.calls.filter((c) => c.method === "setMyCommands");
  assert.equal(setCalls.length, 3);
  const scopes = setCalls.map((c) => c.params.scope.type).sort();
  assert.deepEqual(scopes, ["all_chat_administrators", "all_group_chats", "all_private_chats"]);
});
