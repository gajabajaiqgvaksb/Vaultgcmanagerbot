// Runs every moderation rule over an incoming group message, in priority order.
// The first violation wins: the message is deleted, logged, and the user warned.

import {
  DEFAULT_BANNED_WORDS,
  DuplicateTracker,
  FloodTracker,
  checkBannedWords,
  checkExcessive,
  checkForwarded,
  checkLinks,
  checkSuspiciousAccount,
} from "./moderation.js";
import { mention } from "./util.js";

const RIGHTS_CACHE_MS = 60_000;

export class ModerationPipeline {
  constructor({ client, store, permissions, enforcer, forceSub, now = () => Date.now() }) {
    this.client = client;
    this.store = store;
    this.permissions = permissions;
    this.enforcer = enforcer;
    this.forceSub = forceSub;
    this.duplicates = new DuplicateTracker(now);
    this.floods = new FloodTracker(now);
    this.now = now;
    this.rightsCache = new Map();
  }

  async rightsFor(chatId) {
    const hit = this.rightsCache.get(chatId);
    if (hit && hit.exp > this.now()) return hit.value;
    const value = await this.permissions.botRights(chatId);
    this.rightsCache.set(chatId, { value, exp: this.now() + RIGHTS_CACHE_MS });
    return value;
  }

  async handle(message) {
    const chatId = message.chat.id;
    const user = message.from;
    if (!user || user.is_bot) return { action: "ignored" };

    this.store.ensureGroup(chatId, message.chat.title ?? "");
    const settings = this.store.getSettings(chatId);

    // Group admins and bot owners are never moderated.
    if (await this.permissions.isGroupAdmin(chatId, user.id)) return { action: "allowed" };

    const rights = await this.rightsFor(chatId);
    if (!rights?.canDelete) return { action: "skipped", reason: "bot lacks delete rights" };

    // 1. Mandatory channel subscription
    if (settings.forceSubscribe.enabled && settings.forceSubscribe.channel) {
      const { joined } = await this.forceSub.isMember(settings.forceSubscribe.channel, user.id, chatId);
      if (!joined) {
        await this.client.deleteMessage(chatId, message.message_id);
        const gate = this.forceSub.gateMessage(user, settings.forceSubscribe.channel);
        await this.client.sendMessage(chatId, gate.text, { reply_markup: gate.reply_markup });
        this.store.log(chatId, "forcesub_block", { targetId: user.id });
        return { action: "deleted", rule: "forceSubscribe" };
      }
    }

    const text = message.text ?? message.caption ?? "";

    const violation =
      checkForwarded(message, settings.forwardSpam) ??
      checkSuspiciousAccount(user, settings.suspiciousAccounts) ??
      checkLinks(text, settings.links) ??
      (settings.bannedWords.enabled ? this.checkWords(chatId, text, settings) : null) ??
      checkExcessive(text, settings.excessive) ??
      (settings.duplicates.enabled
        ? this.duplicates.check(chatId, user.id, text, settings.duplicates.windowSec)
        : null) ??
      (settings.flood.enabled
        ? this.floods.check(chatId, user.id, settings.flood)
        : null);

    if (!violation) return { action: "allowed" };
    return this.punish(chatId, message, violation, settings);
  }

  checkWords(chatId, text, settings) {
    const custom = this.store.listWords(chatId);
    const words = settings.bannedWords.useDefaultList ? [...DEFAULT_BANNED_WORDS, ...custom] : custom;
    return checkBannedWords(text, words);
  }

  async punish(chatId, message, violation, settings) {
    const user = message.from;
    await this.client.deleteMessage(chatId, message.message_id);
    this.store.log(chatId, `delete:${violation.rule}`, { targetId: user.id, detail: violation.reason });

    if (!settings.warnings.enabled) {
      await this.client.sendMessage(chatId, `${mention(user)}: ${violation.reason}.`);
      return { action: "deleted", rule: violation.rule };
    }

    const result = await this.enforcer.warn(chatId, user.id, { reason: violation.reason });
    const tail = result.actioned
      ? `Limit reached. Action applied: <b>${result.actioned}</b>.`
      : `Warning ${result.count}/${result.limit}.`;
    await this.client.sendMessage(chatId, `${mention(user)}: ${violation.reason}. ${tail}`);
    return { action: "warned", rule: violation.rule, count: result.count };
  }
}
