// Moderation rules. Each checker is pure (or takes explicit state) and returns
// either null (message is fine) or { rule, reason } describing the violation.

export const DEFAULT_BANNED_WORDS = Object.freeze([
  "free money",
  "earn daily",
  "double your money",
  "guaranteed profit",
  "crypto giveaway",
  "send me your seed",
  "click here to claim",
  "work from home earn",
]);

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"']+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|info|biz|xyz|top|ru|cn|tk|ml|ga|cf|gq|online|site|store|shop|club|link|live|click)\b[^\s<>"']*)/gi;
const TELEGRAM_RE = /\b(?:t\.me|telegram\.me|telegram\.dog)\/[^\s<>"']+/i;
const SHORTENER_RE = /\b(?:bit\.ly|tinyurl\.com|goo\.gl|is\.gd|cutt\.ly|rb\.gy|shorturl\.at|t\.co)\//i;
const PROMO_PHRASES = /\b(?:join now|limited offer|act now|100% (?:free|guaranteed)|claim (?:your )?(?:reward|bonus|prize)|airdrop)\b/i;

export function extractUrls(text = "") {
  return [...text.matchAll(URL_RE)].map((m) => m[1]);
}

export function checkLinks(text, linkSettings) {
  if (!linkSettings?.enabled || !text) return null;

  if (TELEGRAM_RE.test(text) && !linkSettings.allowTelegram) {
    return { rule: "links", reason: "Telegram links are not allowed here" };
  }

  const urls = extractUrls(text).filter((u) => !TELEGRAM_RE.test(u));
  const hasShortener = SHORTENER_RE.test(text);
  if (urls.length === 0 && !hasShortener) return null;

  // Shorteners hide their destination, so they count as promotional even
  // when the scheme is missing. Promo phrases only matter next to a link.
  const promoBait = hasShortener || (urls.length > 0 && PROMO_PHRASES.test(text));
  if (!linkSettings.allowPromotional && promoBait) {
    return { rule: "links", reason: "Promotional or shortened links are not allowed here" };
  }
  if (urls.length > 0 && !linkSettings.allowExternal) {
    return { rule: "links", reason: "External links are not allowed here" };
  }
  return null;
}

export function checkBannedWords(text, words) {
  if (!text || !words?.length) return null;
  const haystack = normalize(text);
  for (const word of words) {
    const needle = normalize(word);
    if (!needle) continue;
    if (wordBoundaryIncludes(haystack, needle)) {
      return { rule: "bannedWords", reason: "Message contains a prohibited word", matched: word };
    }
  }
  return null;
}

export function checkExcessive(text, cfg) {
  if (!cfg?.enabled || !text) return null;
  if (text.length > cfg.maxChars) {
    return { rule: "excessive", reason: `Message is longer than ${cfg.maxChars} characters` };
  }
  const emojis = (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  if (emojis > cfg.maxEmojis) {
    return { rule: "excessive", reason: `Message contains more than ${cfg.maxEmojis} emojis` };
  }
  return null;
}

// Forwarded messages from channels/users are a common spam vector.
export function checkForwarded(message, cfg) {
  if (!cfg?.enabled) return null;
  if (message.forward_date || message.forward_from || message.forward_from_chat) {
    return { rule: "forwardSpam", reason: "Forwarded messages are not allowed here" };
  }
  return null;
}

export function checkSuspiciousAccount(user, cfg) {
  if (!cfg?.enabled || !user) return null;
  if (cfg.requireUsername && !user.username) {
    return { rule: "suspiciousAccount", reason: "Accounts without a username are restricted here" };
  }
  return null;
}

// ---- stateful trackers ----

// Remembers the last normalized text per (chat,user). Identical text repeated
// inside the window is a duplicate; the first occurrence is always allowed.
export class DuplicateTracker {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.seen = new Map(); // key -> { hash, at }
  }

  check(chatId, userId, text, windowSec) {
    if (!text || text.trim().length < 2) return null;
    const key = `${chatId}:${userId}`;
    const hash = normalize(text);
    const at = this.now();
    const prev = this.seen.get(key);
    if (prev && prev.hash === hash && at - prev.at <= windowSec * 1000) {
      return { rule: "duplicates", reason: "Repeated message" };
    }
    this.seen.set(key, { hash, at });
    if (this.seen.size > 50_000) this.prune(at, windowSec);
    return null;
  }

  prune(at, windowSec) {
    for (const [k, v] of this.seen) {
      if (at - v.at > windowSec * 1000) this.seen.delete(k);
    }
  }
}

// Sliding-window flood detector: more than maxMessages within perSeconds.
export class FloodTracker {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.windows = new Map(); // key -> number[] timestamps
  }

  check(chatId, userId, { maxMessages, perSeconds }) {
    const key = `${chatId}:${userId}`;
    const at = this.now();
    const cutoff = at - perSeconds * 1000;
    const times = (this.windows.get(key) ?? []).filter((t) => t > cutoff);
    times.push(at);
    this.windows.set(key, times);
    if (times.length > maxMessages) {
      this.windows.set(key, []); // reset after triggering so one burst = one action
      return { rule: "flood", reason: `Too many messages (${maxMessages}/${perSeconds}s)` };
    }
    return null;
  }
}

// ---- helpers ----

export function normalize(text) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[​-‏⁠﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function wordBoundaryIncludes(haystack, needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(haystack);
}
