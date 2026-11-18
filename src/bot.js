// Wires every component together and routes Telegram updates to handlers.

import { openDatabase } from "./db.js";
import { TelegramClient, TelegramError } from "./telegram.js";
import { PermissionService } from "./permissions.js";
import { Enforcer } from "./enforce.js";
import { ForceSubscribe } from "./forcesub.js";
import { ModerationPipeline } from "./pipeline.js";
import { Commands } from "./commands.js";
import { Panel, PendingInputs } from "./panel.js";
import { renderWelcome, welcomeKeyboard } from "./welcome.js";
import { FreePlan } from "./plans.js";
import { esc, mention, SUBSCRIPTION_SOON } from "./util.js";

export function createBot(config, { fetchImpl, dbPath } = {}) {
  const store = openDatabase(dbPath ?? config.dbPath);
  const client = new TelegramClient({ token: config.token, apiBase: config.apiBase, fetchImpl });
  const permissions = new PermissionService({ client, ownerIds: config.ownerIds, store });
  const enforcer = new Enforcer({ client, store });
  const forceSub = new ForceSubscribe({ client });
  const pipeline = new ModerationPipeline({ client, store, permissions, enforcer, forceSub });
  const inputs = new PendingInputs();
  const panel = new Panel({ client, store, permissions, inputs });
  const freePlan = new FreePlan({ store, forceSub, channel: config.freePlanChannel });
  const commands = new Commands({ client, store, permissions, enforcer, panel, freePlan });
  return new Bot({ client, store, permissions, pipeline, commands, panel, inputs, forceSub, freePlan, config });
}

export class Bot {
  constructor(deps) {
    Object.assign(this, deps);
    this.counters = { updates: 0, lastUpdateAt: null, botUsername: null };
  }

  stats() {
    return {
      updates: this.counters.updates,
      lastUpdateAt: this.counters.lastUpdateAt,
      botUsername: this.counters.botUsername,
      database: "sqlite (local file; free Render disk is wiped on every redeploy)",
      canReadAll: this.permissions.botCanReadAll,
    };
  }

  async handleUpdate(update) {
    this.counters.updates += 1;
    this.counters.lastUpdateAt = Date.now();
    try {
      if (update.my_chat_member) return await this.onMyChatMember(update.my_chat_member);
      if (update.callback_query) return await this.onCallback(update.callback_query);
      if (update.message) return await this.onMessage(update.message);
    } catch (err) {
      // One bad update must never stop the polling loop.
      const where = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? "?";
      console.error(`[update ${update.update_id}] chat ${where}:`, err instanceof TelegramError ? err.message : err);
      // Private chats have no other feedback, so tell the admin something went wrong.
      const chat = update.message?.chat ?? update.callback_query?.message?.chat;
      if (chat?.type === "private") {
        await this.client.sendMessage(chat.id, "Something went wrong. Please try again.").catch(() => {});
      }
    }
  }

  async onMyChatMember(update) {
    const chat = update.chat;
    if (chat.type === "private") return;
    const added = ["member", "administrator"].includes(update.new_chat_member.status);
    if (!added) return;

    this.store.ensureGroup(chat.id, chat.title ?? "");
    const adder = update.from;
    this.store.log(chat.id, "bot_added", { actorId: adder?.id ?? null });

    // Super admins activate immediately. Anyone else may claim the free plan.
    if (!adder || !this.permissions.isOwner(adder.id)) {
      if (!adder || !this.freePlan.enabled) {
        return this.client.sendMessage(chat.id, SUBSCRIPTION_SOON);
      }
      this.store.setOwner(chat.id, adder.id);
      return this.client.sendMessage(
        chat.id,
        `${mention(adder)}, to use this bot in this group, claim the free plan:\n` +
          `1. Join ${esc(this.freePlan.channel)}\n2. Tap <b>I JOINED</b> (or send /claim).\n` +
          "One free group per person. Paid plan: coming soon.",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "JOIN CHANNEL", url: this.freePlan.channelLink() }],
              [{ text: "I JOINED", callback_data: `plan:claim:${chat.id}` }],
            ],
          },
        },
      );
    }

    this.store.setActive(chat.id, true);
    const fromTemplate = this.store.applyTemplate(chat.id);
    const rights = await this.permissions.botRights(chat.id);
    const rightsNote = rights
      ? "Ready."
      : "To moderate, I need admin rights: delete messages, restrict members, pin messages and invite users.";
    const templateNote = fromTemplate ? " Saved template applied." : "";
    await this.client.sendMessage(chat.id, `Group activated.${templateNote} ${rightsNote} Send /panel to configure.`);
  }

  async onCallback(query) {
    const data = query.data ?? "";
    const chatId = query.message?.chat?.id;

    if (data.startsWith("pn:")) {
      // Settings live in the admin's private chat with the bot. The group id is
      // in the callback data, so the panel can be edited from anywhere.
      if (query.message?.chat?.type !== "private") {
        return this.client.answerCallbackQuery(
          query.id,
          "Settings open in a private chat with the bot. Use the Open settings button from /panel.",
          true,
        );
      }
      const groupId = Number(data.split(":")[1]);
      const result = await this.panel.handleCallback(query);
      if (result.alert) return this.client.answerCallbackQuery(query.id, result.alert, true);
      if (result.prompt) {
        await this.client.answerCallbackQuery(query.id);
        return this.client.sendMessage(query.from.id, `${result.prompt}\nSend /cancel to abort.`);
      }
      await this.client.answerCallbackQuery(query.id, result.alert ?? "");
      if (result.screen) {
        const view = this.panel.render(groupId, result.screen, this.permissions.isOwner(query.from.id));
        await this.client.editMessageText(query.message.chat.id, query.message.message_id, view.text, {
          reply_markup: view.reply_markup,
        });
      }
      return;
    }

    if (data.startsWith("fs:check:")) {
      const targetId = Number(data.split(":")[2]);
      const channel = this.store.getSettings(chatId).forceSubscribe.channel;
      const res = await this.forceSub.handleCheck({
        chatId,
        channel,
        pressedBy: query.from.id,
        targetId,
      });
      return this.client.answerCallbackQuery(query.id, res.alert, !res.ok);
    }

    if (data.startsWith("plan:claim:")) {
      const res = await this.freePlan.claim(chatId, query.from.id);
      await this.client.answerCallbackQuery(query.id, res.text, !res.ok);
      if (res.ok) await this.client.sendMessage(chatId, esc(res.text));
      return;
    }

    if (data === "rules:show") {
      const group = this.store.getGroup(chatId);
      await this.client.answerCallbackQuery(query.id);
      const body = group?.rules ? esc(group.rules) : "No rules have been set yet.";
      return this.client.sendMessage(chatId, `<b>Group rules</b>\n${body}`);
    }

    return this.client.answerCallbackQuery(query.id);
  }

  async onMessage(message) {
    if (message.chat.type === "private") return this.onPrivate(message);

    // A basic group was upgraded to a supergroup and got a new chat id:
    // carry its settings over, otherwise the new chat starts empty.
    if (message.migrate_from_chat_id) {
      this.migrateGroup(message.migrate_from_chat_id, message.chat.id, message.chat.title ?? "");
      return;
    }

    // Member joins: welcome them if enabled.
    if (message.new_chat_members?.length) {
      await this.welcome(message);
      return;
    }
    if (message.left_chat_member || message.new_chat_title) {
      if (message.new_chat_title) this.store.ensureGroup(message.chat.id, message.new_chat_title);
      return;
    }

    if (await this.commands.handle(message)) return;
    await this.pipeline.handle(message);
  }

  async onPrivate(message) {
    const text = message.text ?? "";
    if (text.startsWith("/owner")) {
      if (!this.permissions.isOwner(message.from.id)) {
        return this.client.sendMessage(message.chat.id, "This command is for bot owners only.");
      }
      return this.sendOwnerPanel(message.from.id);
    }
    // A pending settings prompt (e.g. "send the banned word") is answered here.
    const confirmation = await this.panel.handleInput(message);
    if (confirmation !== null) return this.client.sendMessage(message.chat.id, confirmation);
    return this.commands.handle(message);
  }

  async welcome(message) {
    const chatId = message.chat.id;
    if (!this.store.isActive(chatId)) return;
    const settings = this.store.getSettings(chatId);
    if (!settings.welcome.enabled) return;
    const group = this.store.getGroup(chatId);
    for (const user of message.new_chat_members) {
      if (user.is_bot) continue;
      const text = renderWelcome(settings.welcome.text, { user, groupTitle: group?.title });
      await this.client.sendMessage(chatId, text, {
        reply_markup: welcomeKeyboard(settings, Boolean(group?.rules)),
      });
    }
  }

  // Copies settings, rules and admins from an old group id to its new supergroup id.
  migrateGroup(oldId, newId, title) {
    const old = this.store.getGroup(oldId);
    if (!old) return;
    this.store.ensureGroup(newId, title || old.title);
    this.store.saveSettings(newId, old.settings);
    this.store.setRules(newId, old.rules);
    for (const userId of this.store.listAdmins(oldId)) this.store.addAdmin(newId, userId);
    this.store.log(newId, "group_migrated", { detail: `from ${oldId}` });
  }

  async sendOwnerPanel(userId) {
    const groups = this.store.listGroups();
    const lines = groups.map((g) => `• ${esc(g.title || "(untitled)")} — <code>${g.chatId}</code>`);
    const text =
      `<b>Owner panel</b>\nGroups served: ${this.store.countGroups()}\n\n` +
      (lines.length ? lines.join("\n") : "No groups yet.");
    await this.client.sendMessage(userId, text);
  }

  // Starts receiving updates. In webhook mode Telegram pushes updates to the
  // HTTP server, so this returns right away. In polling mode it loops forever.
  async start() {
    const me = await this.client.getMe();
    this.counters.botUsername = me.username;
    // False means BotFather privacy mode is ON: the bot only sees commands and
    // replies in groups, not normal messages, so moderation cannot work.
    this.permissions.botCanReadAll = me.can_read_all_group_messages === true;
    if (!this.permissions.botCanReadAll) {
      console.warn(
        "WARNING: privacy mode is ON. In @BotFather send /setprivacy, choose this bot, then Disable.",
      );
    }

    if (this.config.mode === "webhook") {
      const url = `${this.config.publicUrl}/telegram`;
      await this.client.setWebhook(url, this.config.webhookSecret);
      console.log(`Connected as @${me.username} (${me.id}). Webhook set to ${url}`);
      return;
    }

    // An active webhook makes getUpdates fail with 409, so clear it first.
    await this.client.deleteWebhook();
    console.log(`Connected as @${me.username} (${me.id}). Polling for updates...`);
    return this.poll();
  }

  async poll() {
    let offset = this.loadOffset();

    let running = true;
    const stop = () => {
      running = false;
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    while (running) {
      let updates;
      try {
        updates = await this.client.getUpdates(offset, this.config.pollTimeoutSec);
      } catch (err) {
        console.error("getUpdates failed:", err.message);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      for (const update of updates) {
        await this.handleUpdate(update);
        offset = update.update_id + 1;
        this.saveOffset(offset);
      }
    }
    console.log("Shutting down.");
  }

  loadOffset() {
    return this.store.getMeta("offset") ?? 0;
  }

  saveOffset(offset) {
    this.store.setMeta("offset", offset);
  }
}
