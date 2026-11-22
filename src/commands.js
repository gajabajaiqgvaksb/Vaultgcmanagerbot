// Admin and utility slash commands. Every admin command re-verifies the caller
// and refuses to act on another admin or on the bot itself.

import { TelegramError } from "./telegram.js";
import { FULL_PERMISSIONS, NO_PERMISSIONS } from "./enforce.js";
import { esc, mention, parseDuration, parseUserRef, SUBSCRIPTION_SOON } from "./util.js";
import { FEATURES, lockedFeatures, PAID_PLAN_TEXT } from "./plans.js";
import { emojiHtml } from "./emoji.js";

// Commands any user may run to claim or check a plan (they check ownership themselves).
const PLAN_COMMANDS = new Set(["claim", "plan"]);

const MAX_PURGE = 100;

// Commands any member may use. Everything else is admin-only.
const PUBLIC_COMMANDS = new Set(["help", "id", "rules"]);

export class Commands {
  constructor({ client, store, permissions, enforcer, panel, freePlan }) {
    this.client = client;
    this.store = store;
    this.permissions = permissions;
    this.enforcer = enforcer;
    this.panel = panel;
    this.freePlan = freePlan;
  }

  // Returns true when the message was a command this handler processed.
  async handle(message) {
    const text = message.text;
    if (!text?.startsWith("/")) return false;

    const [head, ...rest] = text.trim().split(/\s+/);
    const name = head.slice(1).split("@")[0].toLowerCase();
    const args = rest.join(" ");
    const isPrivate = message.chat.type === "private";

    if (isPrivate) return this.handlePrivate(name, message, args);

    const handler = this.groupHandlers()[name];
    if (!handler) return false;

    try {
      if (PLAN_COMMANDS.has(name)) {
        await handler(message, args);
        return true;
      }
      if (!PUBLIC_COMMANDS.has(name) && !this.permissions.canManageGroup(message.chat.id, message.from.id)) {
        await this.reply(message, SUBSCRIPTION_SOON);
        return true;
      }
      await handler(message, args);
    } catch (err) {
      await this.reply(message, `Failed: ${esc(friendly(err))}`);
    }
    return true;
  }

  // Commands sent in the private chat with the bot. Group settings are managed
  // here: /panel lists the groups you manage, and the group's "Open settings"
  // button arrives as /start g<groupId>.
  async handlePrivate(name, message, args) {
    const userId = message.from.id;

    if (name === "start" && args.startsWith("g")) {
      const groupId = -Math.abs(Number(args.slice(1)));
      if (!Number.isSafeInteger(groupId) || groupId === 0) return this.sendDm(message, "That settings link is invalid.");
      return this.openDmPanel(message, groupId);
    }

    if (name === "start" || name === "help") {
      await this.sendDm(
        message,
        "<b>VaultGC Manager</b>\nAdd me to a group as an admin with delete, restrict, pin and invite rights. " +
          "Then open the group and send /panel, and I will send the settings here.\n" +
          "Send /panel here to see your groups.",
      );
      return true;
    }

    if (name === "panel") {
      const groups = this.store
        .listGroups()
        .filter((g) => this.permissions.canManageGroup(g.chatId, userId));
      if (!groups.length) {
        await this.sendDm(message, SUBSCRIPTION_SOON);
        return true;
      }
      const rows = groups.map((g) => [
        { text: (g.title || String(g.chatId)).slice(0, 60), callback_data: `pn:${g.chatId}:home:g` },
      ]);
      await this.client.sendMessage(message.chat.id, "<b>Your groups</b>\nChoose a group to configure:", {
        reply_markup: { inline_keyboard: rows },
      });
      return true;
    }

    return false;
  }

  async sendDm(message, text, extra = {}) {
    return this.client.sendMessage(message.chat.id, text, extra);
  }

  async openDmPanel(message, groupId) {
    const userId = message.from.id;
    if (!this.store.getGroup(groupId)) {
      return this.sendDm(message, "I have not seen that group yet. Send /panel inside the group first.");
    }
    if (!this.permissions.canManageGroup(groupId, userId)) {
      return this.sendDm(message, SUBSCRIPTION_SOON);
    }
    const view = this.panel.render(groupId, "home", this.permissions.isOwner(userId));
    await this.sendDm(message, view.text, { reply_markup: view.reply_markup });
    return true;
  }

  groupHandlers() {
    return {
      help: (m) => this.reply(m, HELP_TEXT),
      panel: (m) => this.openPanel(m),
      status: (m) => this.statusCmd(m),
      claim: (m) => this.claimCmd(m),
      plan: (m) => this.planCmd(m),
      settemplate: (m) => this.setTemplate(m),
      applytemplate: (m) => this.applyTemplateCmd(m),
      activate: (m) => this.setActive(m, true),
      deactivate: (m) => this.setActive(m, false),
      ban: (m, a) => this.targetAction(m, a, "ban"),
      unban: (m, a) => this.targetAction(m, a, "unban"),
      kick: (m, a) => this.targetAction(m, a, "kick"),
      mute: (m, a) => this.muteCmd(m, a),
      unmute: (m, a) => this.targetAction(m, a, "unmute"),
      warn: (m, a) => this.warnCmd(m, a),
      unwarn: (m, a) => this.unwarnCmd(m, a),
      warnings: (m, a) => this.warningsCmd(m, a),
      purge: (m) => this.purgeCmd(m),
      id: (m) => this.idCmd(m),
      info: (m, a) => this.infoCmd(m, a),
      rules: (m) => this.rulesCmd(m),
      setrules: (m, a) => this.setRulesCmd(m, a),
      lock: (m) => this.lockCmd(m, true),
      unlock: (m) => this.lockCmd(m, false),
      pin: (m) => this.pinCmd(m, true),
      unpin: (m) => this.pinCmd(m, false),
      promote: (m, a) => this.promoteCmd(m, a, true),
      demote: (m, a) => this.promoteCmd(m, a, false),
    };
  }

  // ---- helpers ----

  async reply(message, text, extra = {}) {
    return this.client.sendMessage(message.chat.id, text, {
      reply_to_message_id: message.message_id,
      allow_sending_without_reply: true,
      ...extra,
    });
  }

  // Resolves the target user from a reply, or from a numeric id in args.
  // Returns { user, rest } or null after replying with an explanation.
  async resolveTarget(message, args) {
    if (message.reply_to_message?.from) {
      return { user: message.reply_to_message.from, rest: args };
    }
    const first = args.split(/\s+/)[0] ?? "";
    const ref = parseUserRef(first);
    if (ref?.id) {
      const member = await this.client.getChatMember(message.chat.id, ref.id).catch(() => null);
      const user = member?.user ?? { id: ref.id, first_name: String(ref.id) };
      return { user, rest: args.slice(first.length).trim() };
    }
    await this.reply(
      message,
      "Reply to a user's message, or pass a numeric user ID. Usernames cannot be resolved by the Bot API.",
    );
    return null;
  }

  async guardTarget(message, user) {
    if (user.id === (await this.botId())) {
      await this.reply(message, "I will not act on myself.");
      return false;
    }
    if (await this.permissions.isGroupAdmin(message.chat.id, user.id)) {
      await this.reply(message, "That user is an admin and cannot be moderated with this command.");
      return false;
    }
    return true;
  }

  async botId() {
    return (this.botUser ??= await this.client.getMe()).id;
  }

  // ---- command implementations ----

  async statusCmd(message) {
    const chatId = message.chat.id;
    const rights = await this.permissions.botRights(chatId);
    const active = this.store.isActive(chatId);
    const canReadAll = this.permissions.botCanReadAll === true;
    const lines = [
      "<b>Group status</b>",
      `Activated: ${active ? "yes" : "NO (moderation off; a super admin must /activate)"}`,
      `Sees all messages: ${canReadAll ? "yes" : "NO (BotFather /setprivacy -> Disable)"}`,
      `Bot is admin: ${rights ? "yes" : "NO (promote it with delete, restrict, pin, invite rights)"}`,
      rights
        ? `Rights: delete ${rights.canDelete ? "ok" : "MISSING"}, restrict ${rights.canRestrict ? "ok" : "MISSING"}, pin ${rights.canPin ? "ok" : "MISSING"}`
        : "",
    ].filter(Boolean);
    await this.reply(message, lines.join("\n"), { parse_mode: "HTML" });
  }

  async setTemplate(message) {
    const settings = this.store.getSettings(message.chat.id);
    if (!this.permissions.isOwner(message.from.id) && lockedFeatures(settings).has(FEATURES.TEMPLATES)) {
      return this.reply(message, "Templates are part of the paid plan. " + PAID_PLAN_TEXT);
    }
    this.store.saveTemplate(settings);
    this.store.log(message.chat.id, "template_save", { actorId: message.from.id });
    await this.reply(
      message,
      "Template saved from this group's settings (welcome text and buttons, warnings, links, duplicates, flood, banned-word settings). New groups will start with it; use /applytemplate to apply it here.",
    );
  }

  async applyTemplateCmd(message) {
    if (!this.permissions.isOwner(message.from.id) && lockedFeatures(this.store.getSettings(message.chat.id)).has(FEATURES.TEMPLATES)) {
      return this.reply(message, "Templates are part of the paid plan. " + PAID_PLAN_TEXT);
    }
    if (!this.store.applyTemplate(message.chat.id)) {
      return this.reply(message, "No template saved yet. Set up this group, then send /settemplate.");
    }
    this.store.log(message.chat.id, "template_apply", { actorId: message.from.id });
    await this.reply(message, "Template applied to this group. Channel and subscription settings were kept.");
  }

  async setActive(message, active) {
    this.store.ensureGroup(message.chat.id, message.chat.title ?? "");
    this.store.setActive(message.chat.id, active);
    this.store.log(message.chat.id, active ? "activate" : "deactivate", { actorId: message.from.id });
    await this.reply(message, active ? "Group activated. Send /panel to configure it." : "Group deactivated. Moderation is off.");
  }

  async claimCmd(message) {
    if (!this.freePlan.enabled) return this.reply(message, "The free plan is not available right now.");
    const res = await this.freePlan.claim(message.chat.id, message.from.id);
    await this.reply(message, esc(res.text));
  }

  async planCmd(message) {
    const s = this.store.getSettings(message.chat.id);
    const plan = s.subscription.plan === "free" ? "Free (claimed by the bot's adder)" : s.subscription.plan === "" && s.subscription.active ? "Super admin managed" : "Not activated";
    const lines = [
      "<b>Plan</b>",
      `This group: ${esc(plan)}`,
      `Free plan: ${this.freePlan.enabled ? `join ${esc(this.freePlan.channel)}, then tap I JOINED or send /claim (one group per person)` : "not available right now"}`,
      "Free plan locks: premium emojis, templates, advanced warning and flood thresholds.",
      PAID_PLAN_TEXT,
    ];
    await this.reply(message, lines.join("\n"), { parse_mode: "HTML" });
  }

  // /panel opens the admin panel directly in the group, same as every other
  // admin command. It can also be opened from a private chat with the bot
  // (see handlePrivate), which is handy when the group chat is noisy.
  async openPanel(message) {
    const view = this.panel.render(message.chat.id, "home", this.permissions.isOwner(message.from.id));
    await this.client.sendMessage(message.chat.id, view.text, { reply_markup: view.reply_markup });
  }

  async targetAction(message, args, kind) {
    const resolved = await this.resolveTarget(message, args);
    if (!resolved) return;
    const { user, rest } = resolved;
    if (!(await this.guardTarget(message, user))) return;
    const reason = rest.trim();
    const opts = { actorId: message.from.id, reason };
    const chatId = message.chat.id;
    const who = mention(user);

    if (kind === "ban") await this.enforcer.ban(chatId, user.id, opts);
    if (kind === "unban") await this.enforcer.unban(chatId, user.id, opts);
    if (kind === "kick") await this.enforcer.kick(chatId, user.id, opts);
    if (kind === "unmute") await this.enforcer.unmute(chatId, user.id, opts);

    const verbs = { ban: "banned", unban: "unbanned", kick: "kicked", unmute: "unmuted" };
    const icons = { ban: "ban", unban: "ok", kick: "ban", unmute: "ok" };
    const icon = emojiHtml(icons[kind], this.store.getSettings(chatId).emoji);
    await this.reply(message, `${icon} ${who} has been ${verbs[kind]}.`, { parse_mode: "HTML" });
  }

  async muteCmd(message, args) {
    const resolved = await this.resolveTarget(message, args);
    if (!resolved) return;
    const { user, rest } = resolved;
    if (!(await this.guardTarget(message, user))) return;
    const [durToken, ...reasonParts] = rest.split(/\s+/).filter(Boolean);
    const minutes = parseDuration(durToken ?? "") ?? 60;
    const hasDuration = parseDuration(durToken ?? "") !== null;
    const reason = (hasDuration ? reasonParts : [durToken, ...reasonParts].filter(Boolean)).join(" ");
    await this.enforcer.mute(message.chat.id, user.id, minutes, { actorId: message.from.id, reason });
    const icon = emojiHtml("shield", this.store.getSettings(message.chat.id).emoji);
    await this.reply(message, `${icon} ${mention(user)} muted for ${minutes} minute(s).`, { parse_mode: "HTML" });
  }

  async warnCmd(message, args) {
    const resolved = await this.resolveTarget(message, args);
    if (!resolved) return;
    const { user, rest } = resolved;
    if (!(await this.guardTarget(message, user))) return;
    const result = await this.enforcer.warn(message.chat.id, user.id, {
      actorId: message.from.id,
      reason: rest.trim(),
    });
    const tail = result.actioned
      ? ` Limit reached: applied <b>${result.actioned}</b>.`
      : "";
    const icon = emojiHtml("warn", this.store.getSettings(message.chat.id).emoji);
    await this.reply(message, `${icon} ${mention(user)} warned (${result.count}/${result.limit}).${tail}`, { parse_mode: "HTML" });
  }

  async unwarnCmd(message, args) {
    const resolved = await this.resolveTarget(message, args);
    if (!resolved) return;
    const count = await this.enforcer.unwarn(message.chat.id, resolved.user.id, { actorId: message.from.id });
    await this.reply(message, `Removed one warning. ${mention(resolved.user)} now has ${count}.`, { parse_mode: "HTML" });
  }

  async warningsCmd(message, args) {
    const target = message.reply_to_message?.from ?? (args ? (await this.resolveTarget(message, args))?.user : null) ?? message.from;
    const limit = this.store.getSettings(message.chat.id).warnings.limit;
    const count = this.store.getWarnings(message.chat.id, target.id);
    await this.reply(message, `${mention(target)} has ${count}/${limit} warnings.`, { parse_mode: "HTML" });
  }

  async purgeCmd(message) {
    const rights = await this.permissions.botRights(message.chat.id);
    if (!rights?.canDelete) return this.reply(message, "I need the delete messages right to purge.");
    const start = message.reply_to_message?.message_id;
    if (!start) return this.reply(message, "Reply to the oldest message you want to purge.");
    const end = message.message_id;
    if (end - start + 1 > MAX_PURGE) {
      return this.reply(message, `Purge range is limited to ${MAX_PURGE} messages.`);
    }
    const ids = [];
    for (let id = start; id <= end; id++) ids.push(id);
    await this.client.deleteMessages(message.chat.id, ids);
    this.store.log(message.chat.id, "purge", { actorId: message.from.id, detail: `${ids.length} messages` });
    const note = await this.client.sendMessage(message.chat.id, `Purged ${ids.length} message(s).`);
    setTimeout(() => this.client.deleteMessage(message.chat.id, note.message_id), 5000).unref?.();
  }

  async idCmd(message) {
    const lines = [`Chat ID: <code>${message.chat.id}</code>`, `Your ID: <code>${message.from.id}</code>`];
    if (message.reply_to_message?.from) {
      lines.push(`User ID: <code>${message.reply_to_message.from.id}</code>`);
    }
    await this.reply(message, lines.join("\n"), { parse_mode: "HTML" });
  }

  async infoCmd(message, args) {
    const resolved = message.reply_to_message?.from
      ? { user: message.reply_to_message.from }
      : args
        ? await this.resolveTarget(message, args)
        : { user: message.from };
    if (!resolved) return;
    const user = resolved.user;
    const member = await this.client.getChatMember(message.chat.id, user.id).catch(() => null);
    const warnings = this.store.getWarnings(message.chat.id, user.id);
    await this.reply(
      message,
      [
        `Name: ${esc(`${user.first_name ?? ""} ${user.last_name ?? ""}`.trim())}`,
        `ID: <code>${user.id}</code>`,
        `Username: ${user.username ? `@${esc(user.username)}` : "none"}`,
        `Status: ${member?.status ?? "unknown"}`,
        `Warnings: ${warnings}`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  }

  async rulesCmd(message) {
    const group = this.store.getGroup(message.chat.id);
    const body = group?.rules ? esc(group.rules) : "No rules have been set yet. Admins can use /setrules.";
    const icon = emojiHtml("rules", group?.settings?.emoji);
    await this.reply(message, `<b>${icon} Group rules</b>\n${body}`, { parse_mode: "HTML" });
  }

  async setRulesCmd(message, args) {
    const text = args.trim();
    if (!text) return this.reply(message, "Usage: /setrules <text>");
    this.store.setRules(message.chat.id, text.slice(0, 3500));
    this.store.log(message.chat.id, "setting", { actorId: message.from.id, detail: "rules" });
    await this.reply(message, "Group rules updated.");
  }

  async lockCmd(message, lock) {
    const rights = await this.permissions.botRights(message.chat.id);
    if (!rights?.canRestrict) return this.reply(message, "I need the restrict members right to lock the chat.");
    const perms = lock ? NO_PERMISSIONS : FULL_PERMISSIONS;
    await this.client.setChatPermissions(message.chat.id, perms);
    this.store.log(message.chat.id, lock ? "lock" : "unlock", { actorId: message.from.id });
    await this.reply(message, lock ? "Chat locked. Only admins can send messages." : "Chat unlocked.");
  }

  async pinCmd(message, pin) {
    const target = message.reply_to_message;
    if (!target) return this.reply(message, "Reply to the message you want to pin or unpin.");
    if (pin) await this.client.pinChatMessage(message.chat.id, target.message_id);
    else await this.client.unpinChatMessage(message.chat.id, target.message_id);
    this.store.log(message.chat.id, pin ? "pin" : "unpin", { actorId: message.from.id, targetId: target.message_id });
    await this.reply(message, pin ? "Message pinned." : "Message unpinned.");
  }

  async promoteCmd(message, args, promote) {
    const resolved = await this.resolveTarget(message, args);
    if (!resolved) return;
    const user = resolved.user;
    if (user.id === (await this.botId())) return this.reply(message, "I cannot change my own rights.");
    const rights = promote
      ? {
          can_manage_chat: true,
          can_delete_messages: true,
          can_restrict_members: true,
          can_pin_messages: true,
          can_invite_users: true,
        }
      : {
          can_manage_chat: false,
          can_delete_messages: false,
          can_restrict_members: false,
          can_pin_messages: false,
          can_invite_users: false,
          can_promote_members: false,
          can_change_info: false,
          can_manage_video_chats: false,
          can_manage_topics: false,
          can_post_stories: false,
          can_edit_stories: false,
          can_delete_stories: false,
        };
    await this.client.promoteMember(message.chat.id, user.id, rights);
    this.permissions.invalidate(message.chat.id, user.id);
    this.store.log(message.chat.id, promote ? "promote" : "demote", { actorId: message.from.id, targetId: user.id });
    await this.reply(message, `${mention(user)} ${promote ? "promoted" : "demoted"}.`, { parse_mode: "HTML" });
  }
}

const HELP_TEXT = [
  "<b>Admin commands</b>",
  "/ban /unban /kick /mute [dur] /unmute — reply or pass a user ID",
  "/warn [reason] /unwarn /warnings",
  "/purge — reply to the oldest message to purge",
  "/lock /unlock — restrict or allow chat messages",
  "/pin /unpin — reply to a message",
  "/promote /demote — reply or pass a user ID",
  "/setrules &lt;text&gt; /rules",
  "/id /info — inspect a user or chat",
  "/panel — open settings in a private chat with me",
  "/status — check activation, rights and privacy mode (super admins)",
  "/plan — plan status · /claim — claim the free plan (group owner)",
].join("\n");

function friendly(err) {
  if (err instanceof TelegramError) return err.description;
  return err?.message ?? "unknown error";
}
