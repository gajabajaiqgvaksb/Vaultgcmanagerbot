// Emoji slots used by the bot's text. Each slot has a default emoji. A group
// admin can replace a slot with a premium (custom) emoji from the panel; the
// mapping lives in that group's settings under `emoji`.
//
// Inline button labels cannot contain custom emojis (Telegram limitation), so
// buttons keep the default emoji. Message and panel text uses the mapping.

export const EMOJI_SLOTS = Object.freeze({
  ok: { label: "Enabled (✅)", fallback: "✅" },
  off: { label: "Disabled (❌)", fallback: "❌" },
  warn: { label: "Warning (⚠)", fallback: "⚠" },
  shield: { label: "Anti-spam (🛡)", fallback: "🛡" },
  link: { label: "Links (🔗)", fallback: "🔗" },
  ban: { label: "Banned (🚫)", fallback: "🚫" },
  welcome: { label: "Welcome (👋)", fallback: "👋" },
  rules: { label: "Rules (📜)", fallback: "📜" },
  logs: { label: "Logs (🗒)", fallback: "🗒" },
  stats: { label: "Statistics (📊)", fallback: "📊" },
  channel: { label: "Channel (📢)", fallback: "📢" },
  gear: { label: "Settings (⚙)", fallback: "⚙" },
  flood: { label: "Flood (🌊)", fallback: "🌊" },
  reset: { label: "Reset (♻)", fallback: "♻" },
});

export const EMOJI_SLOT_KEYS = Object.freeze(Object.keys(EMOJI_SLOTS));

export function isEmojiSlot(key) {
  return Object.prototype.hasOwnProperty.call(EMOJI_SLOTS, key);
}

// HTML for a slot: a premium emoji tag if the admin set one, else the default.
export function emojiHtml(slot, mapping = {}) {
  const def = EMOJI_SLOTS[slot]?.fallback ?? "";
  const id = mapping?.[slot];
  return id ? `<tg-emoji emoji-id="${id}">${def}</tg-emoji>` : def;
}

// Plain-text version, for places that cannot carry HTML (buttons).
export function emojiPlain(slot) {
  return EMOJI_SLOTS[slot]?.fallback ?? "";
}
