// Per-group settings: defaults, validation and merging.
// Stored as JSON in the groups table; any missing key falls back to the default.

export const DEFAULT_SETTINGS = Object.freeze({
  // Set by a super admin. Groups stay inactive (no moderation, no setup)
  // until activated. Subscriptions will later decide this instead.
  subscription: {
    active: false,
  },
  links: {
    enabled: true,
    allowTelegram: false, // t.me / telegram.me links
    allowExternal: false, // any other URL
    allowPromotional: false, // URL shorteners and "join now" style bait
  },
  bannedWords: {
    enabled: true,
    useDefaultList: true,
  },
  duplicates: {
    enabled: true,
    windowSec: 300, // identical text by same user within this window is a duplicate
  },
  flood: {
    enabled: true,
    maxMessages: 6, // messages allowed...
    perSeconds: 10, // ...within this many seconds
  },
  excessive: {
    enabled: false,
    maxChars: 1500,
    maxEmojis: 20,
  },
  forwardSpam: {
    enabled: false,
  },
  suspiciousAccounts: {
    enabled: false,
    requireUsername: true, // accounts without a @username are flagged
  },
  warnings: {
    enabled: true,
    limit: 3, // warnings before automatic mute
    action: "mute", // "mute" | "kick" | "ban"
    muteMinutes: 60,
    // Name the banned word(s) in the warning when a message has this many or fewer.
    // Messages with more banned words get a generic warning. 0 = never name them.
    revealWordsUpTo: 4,
  },
  welcome: {
    enabled: false,
    text: "Welcome, {first_name}! Please read the rules: /rules",
    buttons: [], // [{ text, url }]
  },
  forceSubscribe: {
    enabled: false,
    channel: "", // "@channelusername" or numeric id as string
  },
  logs: {
    enabled: true,
  },
  // Premium emoji per bot slot (see emoji.js): { slotKey: customEmojiId }.
  emoji: {},
});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Deep-merge `partial` over the defaults, keeping only known keys.
export function mergeSettings(partial = {}) {
  const out = structuredClone(DEFAULT_SETTINGS);
  const walk = (target, src) => {
    if (!isObj(src)) return;
    for (const key of Object.keys(target)) {
      if (!(key in src)) continue;
      if (isObj(target[key]) && isObj(src[key])) walk(target[key], src[key]);
      else if (Array.isArray(target[key]) && Array.isArray(src[key])) target[key] = src[key];
      else if (typeof target[key] === typeof src[key]) target[key] = src[key];
    }
  };
  walk(out, partial);

  // The emoji map has dynamic keys: keep only valid premium ids or emoji characters.
  out.emoji = {};
  if (isObj(partial.emoji)) {
    for (const [slot, id] of Object.entries(partial.emoji)) {
      // Either a premium custom emoji id (digits) or a normal emoji character.
      if (typeof id !== "string") continue;
      if (/^\d{5,30}$/.test(id)) out.emoji[slot] = id;
      else if (id.length <= 16 && /\p{Extended_Pictographic}/u.test(id)) out.emoji[slot] = id;
    }
  }
  return out;
}

// Dotted-path helpers used by the panel, e.g. getPath(s, "warnings.limit").
export function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const parent = keys.reduce((o, k) => o[k], obj);
  parent[last] = value;
  return obj;
}

export function toggle(obj, path) {
  const current = getPath(obj, path);
  if (typeof current !== "boolean") throw new Error(`${path} is not a toggle`);
  return setPath(obj, path, !current);
}

// Bounded numeric setter so admins cannot store nonsense values.
export function setBoundedNumber(obj, path, value, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${path} must be between ${min} and ${max}`);
  }
  return setPath(obj, path, n);
}
