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
import { esc, mention, SUBSCRIPTION_SOON } from "./util.js";

export function createBot(config, { fetchImpl, dbPath } = {}) {
  const store = openDatabase(dbPath ?? config.dbPath);
  const client = new TelegramClient({ token: config.token, apiBase: config.apiBase, fetchImpl });
  const permissions = new PermissionService({ client, ownerIds: config.ownerIds });
  const enforcer = new Enforcer({ client, store });
  const forceSub = new ForceSubscribe({ client });
  const pipeline = new ModerationPipeline({ client, store, permissions, enforcer, forceSub });
  const inputs = new PendingInputs();
  const panel = new Panel({ client, store, permissions, inputs });
  const commands = new Commands({ client, store, permissions, enforcer, panel });
  return new Bot({ client, store, permissions, pipeline, commands, panel, inputs, forceSub, config });
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

    // Only a super admin who adds the bot activates the group.
    if (!adder || !this.permissions.canManageGroup(chat.id, adder.id)) {
      return this.client.sendMessage(chat.id, SUBSCRIPTION_SOON);
    }

    this.store.setActive(chat.id, true);
    const rights = await this.permissions.botRights(chat.id);
    const rightsNote = rights
      ? "Ready."
      : "To moderate, I need admin rights: delete messages, restrict members, pin messages and invite users.";
    await this.client.sendMessage(chat.id, `Group activated. ${rightsNote} Send /panel to configure.`);
  }

  async onCallback(query) {
    const data = query.data ?? "";
    const chatId = query.message?.chat?.id;

    if (data.startsWith("pn:")) {
      const result = await this.panel.handleCallback(query);
      if (result.alert) return this.client.answerCallbackQuery(query.id, result.alert, true);
      if (result.prompt) {
        await this.client.answerCallbackQuery(query.id);
        return this.client.sendMessage(chatId, `${mention(query.from)}: ${result.prompt}\nSend /cancel to abort.`);
      }
      await this.client.answerCallbackQuery(query.id, result.alert ?? "");
      if (result.screen && query.message) {
        const view = this.panel.render(chatId, result.screen);
        await this.client.editMessageText(chatId, query.message.message_id, view.text, { reply_markup: view.reply_markup });
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

    // Member joins: welcome them if enabled.
    if (message.new_chat_members?.length) {
      await this.welcome(message);
      return;
    }
    if (message.left_chat_member || message.new_chat_title) {
      if (message.new_chat_title) this.store.ensureGroup(message.chat.id, message.new_chat_title);
      return;
    }

    // A super admin answering a pending prompt (e.g. "send the banned word").
    if (message.from && this.permissions.canManageGroup(message.chat.id, message.from.id)) {
      const confirmation = await this.panel.handleInput(message);
      if (confirmation !== null) {
        await this.client.sendMessage(message.chat.id, confirmation, {
          reply_to_message_id: message.message_id,
          allow_sending_without_reply: true,
        });
        return;
      }
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
