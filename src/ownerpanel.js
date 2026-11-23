// The super admin's own panel, reached with /owner in a private chat with
// the bot. Separate from the per-group Panel in panel.js: there is nothing
// to pick here, it is always bot-wide settings and bot-wide stats.

import { esc } from "./util.js";
import { entitiesToHtml } from "./entities.js";
import { PendingInputs } from "./panel.js";
import { parseChatRef } from "./util.js";
import { DEFAULT_START_TEXT } from "./commands.js";

export const MAX_START_TEXT_LENGTH = 1000;

const INPUT_PROMPTS = {
  st: `Send the new /start message (max ${MAX_START_TEXT_LENGTH} chars). Formatting and premium emoji are kept. Placeholders: {first_name}, {username}.`,
  lc: "Send the channel for activity logs: @name, a t.me link, or a numeric id. I must be an admin there. Send /clear to turn it off.",
};

export class OwnerPanel {
  constructor({ store }) {
    this.store = store;
    this.inputs = new PendingInputs();
  }

  // Renders the single "home" screen: stats plus the two editable settings.
  render() {
    const counts = this.store.planCounts();
    const dmUsers = this.store.countDmUsers();
    const logChannel = this.store.getLogChannel();
    const startText = this.store.getStartText() || DEFAULT_START_TEXT;

    const text =
      `<b>👑 Owner panel</b>\n` +
      `Groups: ${counts.total} (activated: ${counts.active}, free plan: ${counts.free})\n` +
      `People who opened a DM with the bot: ${dmUsers}\n` +
      `Activity log channel: ${logChannel ? esc(logChannel) : "not set"}\n\n` +
      `<b>Current /start message</b>\n${startText}`;

    const rows = [
      [{ text: "✏ Edit /start message", callback_data: "ow:i:st" }],
      [{ text: "📢 Set activity log channel", callback_data: "ow:i:lc" }],
      [{ text: "🕒 Recent activity", callback_data: "ow:g:logs" }],
      [{ text: "📋 Groups", callback_data: "ow:g:groups" }],
    ];
    return { text, reply_markup: { inline_keyboard: rows } };
  }

  renderLogs() {
    const rows = this.store.recentGlobalLogs(12);
    const lines = rows.length
      ? rows.map((r) => `• ${esc(r.group_title || String(r.chat_id))}: ${esc(r.action)}${r.detail ? ` — ${esc(r.detail)}` : ""}`)
      : ["No activity logged yet."];
    return {
      text: `<b>🕒 Recent activity</b>\n${lines.join("\n")}`,
      reply_markup: { inline_keyboard: [[{ text: "⬅ Back", callback_data: "ow:g:home" }]] },
    };
  }

  renderGroups() {
    const groups = this.store.listGroups();
    const lines = groups.length
      ? groups
          .slice(0, 25)
          .map((g) => `• ${esc(g.title || "(untitled)")} — <code>${g.chatId}</code>${this.store.isActive(g.chatId) ? "" : " (inactive)"}`)
      : ["No groups yet."];
    return {
      text: `<b>📋 Groups (${groups.length})</b>\n${lines.join("\n")}`,
      reply_markup: { inline_keyboard: [[{ text: "⬅ Back", callback_data: "ow:g:home" }]] },
    };
  }

  // callback_data format: ow:<op>:<code>  — op "g" = go to screen, "i" = text prompt.
  async handleCallback(query) {
    const [, op, code] = query.data.split(":");

    if (op === "g") {
      if (code === "logs") return { view: this.renderLogs() };
      if (code === "groups") return { view: this.renderGroups() };
      return { view: this.render() };
    }

    if (op === "i") {
      const prompt = INPUT_PROMPTS[code];
      if (!prompt) return { alert: "Unknown input." };
      this.inputs.set(query.from.id, code, 0);
      return { prompt };
    }

    return { alert: "Unsupported action." };
  }

  // Applies a text message the owner sent in reply to a pending prompt.
  // Returns a confirmation string, or null if there is no prompt pending.
  async handleInput(message) {
    const userId = message.from.id;
    const pending = this.inputs.peek(userId);
    if (!pending) return null;
    const text = (message.text ?? "").trim();
    const lower = text.toLowerCase();
    if (text.startsWith("/") && lower !== "/cancel" && lower !== "/clear") return null;

    this.inputs.clear(userId);
    if (lower === "/cancel") return "Cancelled.";

    if (pending.code === "st") {
      const raw = message.text ?? "";
      if (!raw) return "Empty input ignored. Open the owner panel and try again.";
      if (raw.length > MAX_START_TEXT_LENGTH) return `The start message must be ${MAX_START_TEXT_LENGTH} characters or fewer.`;
      this.store.setStartText(entitiesToHtml(raw, message.entities).trim());
      return "Start message updated.";
    }

    if (pending.code === "lc") {
      if (lower === "/clear") {
        this.store.setLogChannel(null);
        return "Activity log channel cleared.";
      }
      const ref = parseChatRef(text);
      if (ref === null) return "That does not look like a channel. Use @name, a t.me link, or a numeric id.";
      const channel = typeof ref === "string" ? ref : String(ref);
      this.store.setLogChannel(channel);
      return `Activity log channel set to ${esc(channel)}. Make sure I am an admin there, or I cannot post to it.`;
    }

    return null;
  }
}
