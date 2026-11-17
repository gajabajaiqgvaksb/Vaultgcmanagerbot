// Welcome message rendering. Placeholders: {first_name}, {username}, {id}, {group}.
// Values are HTML-escaped before substitution so names cannot inject markup.

import { esc, mention } from "./util.js";

export const MAX_WELCOME_LENGTH = 800;

export function renderWelcome(template, { user, groupTitle }) {
  const values = {
    first_name: esc(user.first_name || "there"),
    username: user.username ? `@${esc(user.username)}` : esc(user.first_name || "there"),
    id: String(user.id),
    group: esc(groupTitle || ""),
  };
  const body = String(template).replace(/\{(first_name|username|id|group)\}/g, (_, k) => values[k]);
  // Ensure the new member is actually mentioned, even if the template omits it.
  return body.includes(`tg://user?id=${user.id}`) ? body : `${mention(user)}\n${body}`;
}

// Inline keyboard for the welcome message: admin-defined buttons plus a rules button.
export function welcomeKeyboard(settings, hasRules) {
  const rows = [];
  for (const b of settings.welcome.buttons ?? []) {
    if (b?.text && b?.url && /^https?:\/\//.test(b.url)) rows.push([{ text: b.text, url: b.url }]);
  }
  if (hasRules) rows.push([{ text: "📜 Group rules", callback_data: "rules:show" }]);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

// Parses "Text | https://url" lines into button definitions.
export function parseButtons(input = "") {
  return input
    .split("\n")
    .map((line) => line.split("|").map((s) => s.trim()))
    .filter(([text, url]) => text && url && /^https?:\/\//.test(url))
    .map(([text, url]) => ({ text: text.slice(0, 40), url }));
}
