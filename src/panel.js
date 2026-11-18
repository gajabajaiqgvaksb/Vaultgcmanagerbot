// Inline-button admin panel.
// Callback format: pn:<chatId>:<screen>:<op>:<code>
//   op "g" = go to screen, "t" = toggle boolean, "c" = cycle value,
//   "i" = ask for text input, "x" = execute (confirm), code = field key.

import { DEFAULT_SETTINGS, getPath, setPath, toggle } from "./settings.js";
import { esc, parseChatRef, SUBSCRIPTION_SOON } from "./util.js";
import { entitiesToHtml, firstCustomEmojiId } from "./entities.js";
import { EMOJI_SLOTS, EMOJI_SLOT_KEYS, isEmojiSlot, emojiHtml } from "./emoji.js";
import { FEATURES, ADVANCED_CYCLE_CODES, lockedFeatures } from "./plans.js";

const LOCK_TEXT = "Available on the paid plan (coming soon).";
import { MAX_WELCOME_LENGTH, parseButtons } from "./welcome.js";

const INPUT_TTL_MS = 10 * 60_000;

// Boolean fields toggled directly from buttons.
const BOOL = {
  lg: "logs.enabled",
  ln: "links.enabled",
  lt: "links.allowTelegram",
  le: "links.allowExternal",
  lp: "links.allowPromotional",
  bw: "bannedWords.enabled",
  bd: "bannedWords.useDefaultList",
  du: "duplicates.enabled",
  fl: "flood.enabled",
  ex: "excessive.enabled",
  fw: "forwardSpam.enabled",
  sa: "suspiciousAccounts.enabled",
  sr: "suspiciousAccounts.requireUsername",
  wn: "warnings.enabled",
  wc: "welcome.enabled",
  fs: "forceSubscribe.enabled",
};

// Numeric/enum fields cycled through fixed values.
const CYCLE = {
  wl: { path: "warnings.limit", values: [2, 3, 4, 5, 7, 10] },
  wa: { path: "warnings.action", values: ["mute", "kick", "ban"] },
  wm: { path: "warnings.muteMinutes", values: [15, 60, 360, 1440] },
  dw: { path: "duplicates.windowSec", values: [60, 300, 900, 3600] },
  fm: { path: "flood.maxMessages", values: [3, 5, 6, 8, 10] },
  fp: { path: "flood.perSeconds", values: [5, 10, 20, 30] },
  wr: { path: "warnings.revealWordsUpTo", values: [0, 1, 2, 3, 4, 6] },
};

// Text inputs the admin types as their next message in the group.
const INPUT = {
  ai: "Send the banned word or phrase to add.",
  ri: "Send the banned word or phrase to remove.",
  wt: `Send the new welcome text (max ${MAX_WELCOME_LENGTH} chars). Placeholders: {first_name}, {username}, {id}, {group}.`,
  wb: "Send welcome buttons, one per line, in the format: Button text | https://link",
  fc: "Send the channel to require, e.g. @mychannel or https://t.me/mychannel.",
  ru: "Send the full group rules text.",
};

const SCREENS = ["home", "general", "antispam", "links", "words", "welcome", "forcesub",
  "warnings", "duplicates", "flood", "rules", "logs", "stats", "emoji", "reset"];

// First emoji character in a text, or null.
function firstEmojiChar(text = "") {
  const m = text.match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/u);
  return m ? m[0] : null;
}

// Prompt for a premium emoji slot, e.g. code "e_ok".
function emojiPromptFor(code) {
  if (!code.startsWith("e_")) return null;
  const slot = code.slice(2);
  if (!isEmojiSlot(slot)) return null;
  return `Send an emoji for ${EMOJI_SLOTS[slot].label}: a premium emoji (needs Telegram Premium) or a normal one. Send /cancel to abort.`;
}

// Text prompts are answered in the admin's private chat with the bot, so the
// pending entry is keyed by user and remembers which group it edits.
export class PendingInputs {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.map = new Map();
  }
  set(userId, code, groupId) {
    this.map.set(userId, { code, groupId, exp: this.now() + INPUT_TTL_MS });
  }
  peek(userId) {
    const entry = this.map.get(userId);
    if (!entry || entry.exp < this.now()) {
      this.map.delete(userId);
      return null;
    }
    return entry;
  }
  clear(userId) {
    this.map.delete(userId);
  }
}

export class Panel {
  constructor({ client, store, permissions, inputs }) {
    this.client = client;
    this.store = store;
    this.permissions = permissions;
    this.inputs = inputs;
  }

  // Renders a screen. Returns { text, reply_markup }.
  render(chatId, screen = "home", viewerIsSuper = false) {
    const group = this.store.getGroup(chatId);
    const s = group?.settings ?? structuredClone(DEFAULT_SETTINGS);
    const title = esc(group?.title || String(chatId));
    const build = SCREENS_RENDER[screen] ?? SCREENS_RENDER.home;
    const locked = !viewerIsSuper && lockedFeatures(s).has(FEATURES.EMOJI);
    const { text, rows } = build({ s, chatId, store: this.store, group, locked });
    const nav = screen === "home"
      ? []
      : [[{ text: "⬅ Back", callback_data: cb(chatId, "home", "g") }]];
    return {
      text: `<b>${emojiHtml("gear", s.emoji)} Admin panel</b> — ${title}\n${text}`,
      reply_markup: { inline_keyboard: [...rows, ...nav] },
    };
  }

  // Handles a callback query. Returns { alert?, rerender? }.
  async handleCallback(query) {
    const [, chatStr, screen, op, code] = query.data.split(":");
    const chatId = Number(chatStr);
    const actor = query.from;

    if (!this.permissions.canManageGroup(chatId, actor.id)) {
      return { alert: SUBSCRIPTION_SOON };
    }

    // Free-plan locks. Super admins are never locked.
    if (!this.permissions.isOwner(actor.id)) {
      const locks = lockedFeatures(this.store.getSettings(chatId));
      const advanced = op === "c" && ADVANCED_CYCLE_CODES.has(code) && locks.has(FEATURES.ADVANCED);
      const emoji = (op === "i" && code?.startsWith("e_")) || (op === "x" && code?.startsWith("ce_"));
      if ((advanced || (emoji && locks.has(FEATURES.EMOJI)))) return { alert: LOCK_TEXT };
    }

    if (op === "g") return { screen };

    if (op === "t") {
      const path = BOOL[code];
      if (!path) return { alert: "Unknown setting." };
      const s = this.store.getSettings(chatId);
      toggle(s, path);
      this.store.saveSettings(chatId, s);
      this.store.log(chatId, "setting", { actorId: actor.id, detail: `${path}=${getPath(s, path)}` });
      return { screen };
    }

    if (op === "c") {
      const spec = CYCLE[code];
      if (!spec) return { alert: "Unknown setting." };
      const s = this.store.getSettings(chatId);
      const cur = getPath(s, spec.path);
      const next = spec.values[(spec.values.indexOf(cur) + 1) % spec.values.length];
      setPath(s, spec.path, next);
      this.store.saveSettings(chatId, s);
      this.store.log(chatId, "setting", { actorId: actor.id, detail: `${spec.path}=${next}` });
      return { screen };
    }

    if (op === "i") {
      const prompt = INPUT[code] ?? emojiPromptFor(code);
      if (!prompt) return { alert: "Unknown input." };
      this.inputs.set(actor.id, code, chatId);
      return { prompt };
    }

    if (op === "x" && code?.startsWith("ce_")) {
      const slot = code.slice(3);
      if (!isEmojiSlot(slot)) return { alert: "Unknown emoji slot." };
      const s = this.store.getSettings(chatId);
      delete s.emoji[slot];
      this.store.saveSettings(chatId, s);
      this.store.log(chatId, "setting", { actorId: actor.id, detail: `emoji.${slot} removed` });
      return { screen: "emoji", alert: `${EMOJI_SLOTS[slot].label} reset to default.` };
    }

    if (op === "x") {
      if (code === "rsy") {
        this.store.saveSettings(chatId, structuredClone(DEFAULT_SETTINGS));
        this.store.log(chatId, "settings_reset", { actorId: actor.id });
        return { screen: "home", alert: "Settings reset to defaults." };
      }
      if (code === "clr") {
        for (const w of this.store.listWords(chatId)) this.store.removeWord(chatId, w);
        this.store.log(chatId, "words_cleared", { actorId: actor.id });
        return { screen: "words", alert: "Custom banned words cleared." };
      }
    }

    return { alert: "Unsupported action." };
  }

  // Applies a text message the admin sent in their private chat with the bot
  // to the group of the pending prompt. Returns a confirmation string, or null
  // if the message is not for a prompt (other slash commands pass through).
  async handleInput(message) {
    const userId = message.from.id;
    const text = (message.text ?? "").trim();
    const pending = this.inputs.peek(userId);
    if (!pending) return null;
    if (text.startsWith("/") && text.toLowerCase() !== "/cancel") return null;

    this.inputs.clear(userId);
    if (text.toLowerCase() === "/cancel") return "Cancelled.";

    const chatId = pending.groupId;
    const code = pending.code;
    if (!this.permissions.canManageGroup(chatId, userId)) {
      return "You no longer manage this group, so the change was not saved.";
    }
    if (!text) {
      return "Empty input ignored. Open the panel and try again.";
    }

    if (code.startsWith("e_")) {
      const slot = code.slice(2);
      // Premium emoji wins; a normal emoji is saved as-is (no premium tag).
      const id = firstCustomEmojiId(message.entities);
      const plain = firstEmojiChar(text);
      if (!id && !plain) {
        return "Send an emoji (premium or normal), or /cancel. Premium emojis need a Telegram Premium account to send.";
      }
      const s = this.store.getSettings(chatId);
      s.emoji[slot] = id ?? plain;
      this.store.saveSettings(chatId, s);
      this.store.log(chatId, "setting", { actorId: userId, detail: `emoji.${slot}` });
      return id
        ? `${EMOJI_SLOTS[slot].label} now uses your premium emoji.`
        : `${EMOJI_SLOTS[slot].label} now uses ${esc(plain)}.`;
    }

    switch (code) {
      case "ai": {
        const word = text.toLowerCase();
        if (word.length > 100) return "Words must be 100 characters or fewer.";
        this.store.addWord(chatId, word);
        this.store.log(chatId, "word_add", { actorId: userId, detail: word });
        return `Added banned word: <code>${esc(word)}</code>`;
      }
      case "ri": {
        const removed = this.store.removeWord(chatId, text);
        if (removed) this.store.log(chatId, "word_remove", { actorId: userId, detail: text.toLowerCase() });
        return removed ? `Removed: <code>${esc(text)}</code>` : "That word is not in the custom list.";
      }
      case "wt": {
        // Keep formatting and premium emojis: store the message as Telegram HTML.
        const raw = message.text ?? "";
        if (raw.length > MAX_WELCOME_LENGTH) return `Welcome text must be ${MAX_WELCOME_LENGTH} characters or fewer.`;
        const s = this.store.getSettings(chatId);
        s.welcome.text = entitiesToHtml(raw, message.entities).trim();
        this.store.saveSettings(chatId, s);
        this.store.log(chatId, "setting", { actorId: userId, detail: "welcome.text" });
        return "Welcome text updated.";
      }
      case "wb": {
        const s = this.store.getSettings(chatId);
        s.welcome.buttons = parseButtons(text).slice(0, 6);
        this.store.saveSettings(chatId, s);
        this.store.log(chatId, "setting", { actorId: userId, detail: "welcome.buttons" });
        return `Saved ${s.welcome.buttons.length} welcome button(s).`;
      }
      case "fc": {
        const ref = parseChatRef(text);
        if (ref === null) return "That does not look like a channel. Use @name or a t.me link.";
        const s = this.store.getSettings(chatId);
        s.forceSubscribe.channel = typeof ref === "string" ? ref : String(ref);
        this.store.saveSettings(chatId, s);
        this.store.log(chatId, "setting", { actorId: userId, detail: "forceSubscribe.channel" });
        return `Mandatory channel set to ${esc(s.forceSubscribe.channel)}. Enable it to apply.`;
      }
      case "ru": {
        this.store.setRules(chatId, text.slice(0, 3500));
        this.store.log(chatId, "setting", { actorId: userId, detail: "rules" });
        return "Group rules updated.";
      }
    }
    return null;
  }
}

// ---- helpers ----

function cb(chatId, screen, op, code = "") {
  return `pn:${chatId}:${screen}:${op}:${code}`.replace(/:$/, "");
}

const onOff = (v) => (v ? "✅" : "❌");

function boolBtn(chatId, screen, label, code, value) {
  return { text: `${onOff(value)} ${label}`, callback_data: cb(chatId, screen, "t", code) };
}

function navBtn(chatId, screen, label) {
  return { text: label, callback_data: cb(chatId, screen, "g") };
}

function inputBtn(chatId, screen, label, code) {
  return { text: label, callback_data: cb(chatId, screen, "i", code) };
}

function cycleBtn(chatId, screen, label, code, value) {
  return { text: `${label}: ${value}`, callback_data: cb(chatId, screen, "c", code) };
}

const SCREENS_RENDER = {
  home: ({ s, chatId }) => ({
    text: "Choose a section:",
    rows: [
      [navBtn(chatId, "general", "⚙ General"), navBtn(chatId, "antispam", "🛡 Anti-spam")],
      [navBtn(chatId, "links", "🔗 Link protection"), navBtn(chatId, "words", "🚫 Banned words")],
      [navBtn(chatId, "welcome", "👋 Welcome"), navBtn(chatId, "forcesub", "📢 Force subscribe")],
      [navBtn(chatId, "warnings", "⚠ Warnings"), navBtn(chatId, "duplicates", "♻ Duplicates")],
      [navBtn(chatId, "flood", "🌊 Flood"), navBtn(chatId, "rules", "📜 Group rules")],
      [navBtn(chatId, "logs", "🗒 Moderation logs"), navBtn(chatId, "stats", "📊 Statistics")],
      [navBtn(chatId, "emoji", "💎 Premium emoji"), navBtn(chatId, "reset", "♲ Reset settings")],
    ],
  }),

  general: ({ s, chatId, group }) => ({
    text: `Logs: ${onOff(s.logs.enabled)}\nWarnings: ${onOff(s.warnings.enabled)}\nGroup: ${esc(group?.title ?? "")}`,
    rows: [[boolBtn(chatId, "general", "Moderation logs", "lg", s.logs.enabled)]],
  }),

  antispam: ({ s, chatId }) => ({
    text: "Automatic moderation rules.",
    rows: [
      [boolBtn(chatId, "antispam", "Flood protection", "fl", s.flood.enabled)],
      [boolBtn(chatId, "antispam", "Excessive messages", "ex", s.excessive.enabled)],
      [boolBtn(chatId, "antispam", "Forwarded spam", "fw", s.forwardSpam.enabled)],
      [boolBtn(chatId, "antispam", "Suspicious accounts", "sa", s.suspiciousAccounts.enabled)],
      [boolBtn(chatId, "antispam", "Require @username", "sr", s.suspiciousAccounts.requireUsername)],
    ],
  }),

  links: ({ s, chatId }) => ({
    text: "Link rules. Blocked links are deleted and the sender is warned.",
    rows: [
      [boolBtn(chatId, "links", "Link protection", "ln", s.links.enabled)],
      [boolBtn(chatId, "links", "Allow Telegram links", "lt", s.links.allowTelegram)],
      [boolBtn(chatId, "links", "Allow external URLs", "le", s.links.allowExternal)],
      [boolBtn(chatId, "links", "Allow promotional links", "lp", s.links.allowPromotional)],
    ],
  }),

  words: ({ s, chatId, store }) => {
    const custom = store.listWords(chatId);
    return {
      text: `Custom words: ${custom.length}\nDefault list: ${s.bannedWords.useDefaultList ? "on" : "off"}`
        + (custom.length ? `\n\n${custom.map((w) => `• ${esc(w)}`).slice(0, 30).join("\n")}` : ""),
      rows: [
        [boolBtn(chatId, "words", "Banned words", "bw", s.bannedWords.enabled)],
        [boolBtn(chatId, "words", "Use default list", "bd", s.bannedWords.useDefaultList)],
        [inputBtn(chatId, "words", "➕ Add word", "ai"), inputBtn(chatId, "words", "➖ Remove word", "ri")],
        [{ text: "🗑 Clear custom list", callback_data: cb(chatId, "words", "x", "clr") }],
      ],
    };
  },

  welcome: ({ s, chatId }) => ({
    text: `Welcome: ${onOff(s.welcome.enabled)}\n\n<i>Preview:</i>\n${s.welcome.text}`,
    rows: [
      [boolBtn(chatId, "welcome", "Welcome messages", "wc", s.welcome.enabled)],
      [inputBtn(chatId, "welcome", "✏ Edit text", "wt"), inputBtn(chatId, "welcome", "🔘 Edit buttons", "wb")],
    ],
  }),

  forcesub: ({ s, chatId }) => ({
    text: `Force subscribe: ${onOff(s.forceSubscribe.enabled)}\nChannel: ${esc(s.forceSubscribe.channel || "not set")}`,
    rows: [
      [boolBtn(chatId, "forcesub", "Enabled", "fs", s.forceSubscribe.enabled)],
      [inputBtn(chatId, "forcesub", "📢 Set channel", "fc")],
    ],
  }),

  warnings: ({ s, chatId }) => ({
    text: `Warnings: ${onOff(s.warnings.enabled)}\nLimit ${s.warnings.limit}, then ${s.warnings.action}`
      + (s.warnings.action === "mute" ? ` for ${s.warnings.muteMinutes} min` : ""),
    rows: [
      [boolBtn(chatId, "warnings", "Warnings enabled", "wn", s.warnings.enabled)],
      [cycleBtn(chatId, "warnings", "Limit", "wl", s.warnings.limit), cycleBtn(chatId, "warnings", "Action", "wa", s.warnings.action)],
      [cycleBtn(chatId, "warnings", "Mute minutes", "wm", s.warnings.muteMinutes)],
      [cycleBtn(chatId, "warnings", "Name words up to", "wr", s.warnings.revealWordsUpTo)],
    ],
  }),

  duplicates: ({ s, chatId }) => ({
    text: `Duplicate protection: ${onOff(s.duplicates.enabled)}\nWindow: ${s.duplicates.windowSec}s`,
    rows: [
      [boolBtn(chatId, "duplicates", "Duplicate protection", "du", s.duplicates.enabled)],
      [cycleBtn(chatId, "duplicates", "Window (s)", "dw", s.duplicates.windowSec)],
    ],
  }),

  flood: ({ s, chatId }) => ({
    text: `Flood protection: ${onOff(s.flood.enabled)}\nMax ${s.flood.maxMessages} messages per ${s.flood.perSeconds}s`,
    rows: [
      [boolBtn(chatId, "flood", "Flood protection", "fl", s.flood.enabled)],
      [cycleBtn(chatId, "flood", "Max msgs", "fm", s.flood.maxMessages), cycleBtn(chatId, "flood", "Per (s)", "fp", s.flood.perSeconds)],
    ],
  }),

  rules: ({ chatId, group }) => ({
    text: group?.rules ? esc(group.rules).slice(0, 3000) : "No rules set. Use /setrules or the button below.",
    rows: [[inputBtn(chatId, "rules", "✏ Set rules", "ru")]],
  }),

  logs: ({ chatId, store }) => {
    const rows = store.recentLogs(chatId, 15);
    const lines = rows.map((r) => {
      const when = new Date(r.created_at * 1000).toISOString().slice(5, 16).replace("T", " ");
      return `<code>${when}</code> ${esc(r.action)} ${r.target_id ?? ""} ${esc(r.detail).slice(0, 60)}`;
    });
    return { text: lines.length ? lines.join("\n") : "No moderation logs yet.", rows: [] };
  },

  stats: ({ chatId, store }) => {
    const counts = store.logCounts(chatId);
    const lines = counts.length
      ? counts.map((c) => `• ${esc(c.action)}: ${c.n}`).join("\n")
      : "No activity recorded yet.";
    return {
      text: `Admins known: ${store.listAdmins(chatId).length}\nCustom words: ${store.listWords(chatId).length}\n\n${lines}`,
      rows: [],
    };
  },

  emoji: ({ s, chatId, locked }) => {
    if (locked) {
      return { text: `Premium emoji is part of the paid plan. ${LOCK_TEXT}`, rows: [] };
    }
    const lines = EMOJI_SLOT_KEYS.map((k) =>
      `${emojiHtml(k, s.emoji)} ${esc(EMOJI_SLOTS[k].label)} — ${s.emoji[k] ? "premium" : "default"}`,
    );
    const rows = EMOJI_SLOT_KEYS.map((k) => {
      const set = { text: `Set ${EMOJI_SLOTS[k].label}`, callback_data: cb(chatId, "emoji", "i", `e_${k}`) };
      return s.emoji[k]
        ? [set, { text: "Reset", callback_data: cb(chatId, "emoji", "x", `ce_${k}`) }]
        : [set];
    });
    return {
      text:
        "Send a premium emoji for a slot and the bot uses it in its messages and this panel. " +
        "Buttons keep the default emoji because Telegram does not allow custom emojis in button labels.\n\n" +
        lines.join("\n"),
      rows,
    };
  },

  reset: ({ chatId }) => ({
    text: "Reset every setting in this group to defaults? Rules and banned words are kept.",
    rows: [[{ text: "⚠ Confirm reset", callback_data: cb(chatId, "home", "x", "rsy") }]],
  }),
};
