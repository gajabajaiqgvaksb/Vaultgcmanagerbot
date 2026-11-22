// Mandatory channel subscription ("force subscribe").
// Membership is checked against Telegram's API. Only positive results are
// cached, for a short time, so an unsubscribed user is always re-checked.

import { esc, mention } from "./util.js";
import { emojiHtml } from "./emoji.js";

const POSITIVE_CACHE_MS = 120_000;
const JOINED = new Set(["member", "administrator", "creator"]);

export class ForceSubscribe {
  constructor({ client, now = () => Date.now() }) {
    this.client = client;
    this.now = now;
    this.positive = new Map(); // "chat:user:channel" -> expiry
  }

  // Returns { joined: boolean, error?: string }.
  async isMember(channel, userId, chatId) {
    const key = `${chatId}:${userId}:${channel}`;
    const exp = this.positive.get(key);
    if (exp && exp > this.now()) return { joined: true };

    try {
      const member = await this.client.getChatMember(channel, userId);
      const joined =
        JOINED.has(member.status) || (member.status === "restricted" && member.is_member === true);
      if (joined) this.positive.set(key, this.now() + POSITIVE_CACHE_MS);
      return { joined };
    } catch (err) {
      // Usually means the bot is not an admin of the channel, or the channel
      // reference is wrong. Fail closed so nobody bypasses the gate.
      return { joined: false, error: err.message };
    }
  }

  // Builds the gate message sent when an unsubscribed user writes.
  gateMessage(user, channel, emoji = {}) {
    const handle = channel.startsWith("@") ? channel : `@${channel}`;
    return {
      text:
        `${emojiHtml("channel", emoji)} ${mention(user)}, you must join ${esc(handle)} before you can post in this group.\n` +
        `Join the channel, then tap <b>I SUBSCRIBED</b>.`,
      reply_markup: {
        inline_keyboard: [
          [{ text: "JOIN CHANNEL", url: `https://t.me/${handle.slice(1)}` }],
          [{ text: "I SUBSCRIBED", callback_data: `fs:check:${user.id}` }],
        ],
      },
    };
  }

  // Handles the "I SUBSCRIBED" button. Only the targeted user may press it.
  async handleCheck({ chatId, channel, pressedBy, targetId }) {
    if (pressedBy !== targetId) {
      return { alert: "This button is for the user it was sent to.", ok: false };
    }
    const { joined, error } = await this.isMember(channel, targetId, chatId);
    if (error) {
      return { alert: "Could not verify your subscription right now. Try again later.", ok: false };
    }
    if (joined) {
      return { alert: "Subscription confirmed. You can post now.", ok: true };
    }
    return { alert: "You have not joined the channel yet. Join it first, then try again.", ok: false };
  }
}
