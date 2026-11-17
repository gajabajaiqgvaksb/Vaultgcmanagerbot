// Inline-button admin panel.
// Callback format: pn:<chatId>:<screen>:<op>:<code>
//   op "g" = go to screen, "t" = toggle boolean, "c" = cycle value,
//   "i" = ask for text input, "x" = execute (confirm), code = field key.

import { DEFAULT_SETTINGS, getPath, setPath, toggle } from "./settings.js";
import { esc, parseChatRef, SUBSCRIPTION_SOON } from "./util.js";
import { MAX_WELCOME_LENGTH, parseButtons } from "./welcome.js";

const INPUT_TTL_MS = 5 * 60_000;

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
  "warnings", "duplicates", "flood", "rules", "logs", "stats", "reset"];

export class PendingInputs {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.map = new Map();
  }
  set(chatId, userId, code) {
    this.map.set(`${chatId}:${userId}`, { code, exp: this.now() + INPUT_TTL_MS });
  }
  take(chatId, userId) {
    const key = `${chatId}:${userId}`;
    const entry = this.map.get(key);
    this.map.delete(key);
    if (!entry || entry.exp < this.now()) return null;
    return entry.code;
  }
  clear(chatId, userId) {
    this.map.delete(`${chatId}:${userId}`);
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
  render(chatId, screen = "home") {
    const group = this.store.getGroup(chatId);
    const s = group?.settings ?? structuredClone(DEFAULT_SETTINGS);
    const title = esc(group?.title || String(chatId));
    const build = SCREENS_RENDER[screen] ?? SCREENS_RENDER.home;
    const { text, rows } = build({ s, chatId, store: this.store, group });
    const nav = screen === "home"
      ? []
      : [[{ text: "⬅ Back", callback_data: cb(chatId, "home", "g") }]];
    return {
      text: `<b>⚙ Admin panel</b> — ${title}\n${text}`,
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
      if (!INPUT[code]) return { alert: "Unknown input." };
      this.inputs.set(chatId, actor.id, code);
      return { prompt: INPUT[code] };
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

  // Applies a text message the admin sent in reply to a pending prompt.
  // Returns a confirmation string, or null if the message is not for a prompt.
  async handleInput(message) {
    const chatId = message.chat.id;
    const userId = message.from.id;
    const text = (message.text ?? "").trim();
    const code = this.inputs.take(chatId, userId);
    if (!code) return null;

    if (text.toLowerCase() === "/cancel") return "Cancelled.";
    if (!text) {
      return "Empty input ignored. Open the panel and try again.";
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
        if (text.length > MAX_WELCOME_LENGTH) return `Welcome text must be ${MAX_WELCOME_LENGTH} characters or fewer.`;
        const s = this.store.getSettings(chatId);
        s.welcome.text = text;
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
      [navBtn(chatId, "reset", "♲ Reset settings")],
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
    text: `Welcome: ${onOff(s.welcome.enabled)}\n\n<i>Preview:</i>\n${esc(s.welcome.text)}`,
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

  reset: ({ chatId }) => ({
    text: "Reset every setting in this group to defaults? Rules and banned words are kept.",
    rows: [[{ text: "⚠ Confirm reset", callback_data: cb(chatId, "home", "x", "rsy") }]],
  }),
};
