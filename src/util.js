// Small shared helpers.

export const SUBSCRIPTION_SOON =
  "Subscription coming soon for normal users. Right now only super admins can set up and manage this group.";

// Escape text for Telegram's HTML parse mode.
export function esc(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Clickable mention that works even without a username.
export function mention(user) {
  const name = esc(user.first_name || user.username || String(user.id));
  return `<a href="tg://user?id=${user.id}">${name}</a>`;
}

// Parses "@channel", "channel", "https://t.me/channel" or "-100123..." into a
// value usable by getChatMember. Returns null if the input is not recognizable.
export function parseChatRef(input = "") {
  const s = input.trim();
  if (/^-?\d{5,}$/.test(s)) return Number(s);
  const link = s.match(/^(?:https?:\/\/)?t\.me\/([A-Za-z][A-Za-z0-9_]{3,})\/?$/i);
  if (link) return `@${link[1]}`;
  const handle = s.match(/^@?([A-Za-z][A-Za-z0-9_]{3,})$/);
  if (handle) return `@${handle[1]}`;
  return null;
}

// Parses a user reference from command args: numeric id or @username.
export function parseUserRef(input = "") {
  const s = input.trim().replace(/^@/, "");
  if (/^\d{4,}$/.test(s)) return { id: Number(s) };
  if (/^[A-Za-z][A-Za-z0-9_]{4,}$/.test(s)) return { username: s };
  return null;
}

export function parseDuration(input = "") {
  const m = input.trim().match(/^(\d+)\s*([mhd]?)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || "m").toLowerCase();
  const minutes = unit === "d" ? n * 1440 : unit === "h" ? n * 60 : n;
  return minutes > 0 ? minutes : null;
}
