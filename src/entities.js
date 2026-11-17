// Converts a Telegram message (text + entities) into Telegram HTML so that
// formatting and premium (custom) emojis survive when the text is stored and
// sent again. Offsets are UTF-16 code units, the same as JavaScript strings.

import { esc } from "./util.js";

const WRAP = {
  bold: ["<b>", "</b>"],
  italic: ["<i>", "</i>"],
  underline: ["<u>", "</u>"],
  strikethrough: ["<s>", "</s>"],
  spoiler: ["<tg-spoiler>", "</tg-spoiler>"],
  code: ["<code>", "</code>"],
  pre: ["<pre>", "</pre>"],
};

export function entitiesToHtml(text = "", entities = []) {
  if (!entities?.length) return esc(text);

  // Opening tags at a position come before closing tags there.
  const opens = new Map();
  const closes = new Map();
  const add = (map, pos, tag) => {
    if (!map.has(pos)) map.set(pos, []);
    map.get(pos).push(tag);
  };

  for (const e of entities) {
    const start = e.offset;
    const end = e.offset + e.length;
    if (e.type === "custom_emoji") {
      // Rendered by the tag itself; the placeholder character is the fallback.
      add(opens, start, `<tg-emoji emoji-id="${esc(e.custom_emoji_id)}">`);
      add(closes, end, `</tg-emoji>`);
    } else if (e.type === "text_link" && e.url) {
      add(opens, start, `<a href="${esc(e.url)}">`);
      add(closes, end, `</a>`);
    } else if (WRAP[e.type]) {
      add(opens, start, WRAP[e.type][0]);
      add(closes, end, WRAP[e.type][1]);
    }
  }

  // Build output left to right, emitting closes before opens at each index.
  const positions = [...new Set([...opens.keys(), ...closes.keys(), 0, text.length])].sort((a, b) => a - b);
  let out = "";
  let cursor = 0;
  for (const pos of positions) {
    if (pos > cursor) out += esc(text.slice(cursor, pos));
    cursor = Math.max(cursor, pos);
    for (const tag of closesAt(closes, pos)) out += tag;
    for (const tag of opens.get(pos) ?? []) out += tag;
  }
  if (cursor < text.length) out += esc(text.slice(cursor));
  return out;
}

// Closing tags must be emitted innermost-first; reversing keeps nesting valid
// for the common case of entities added in order.
function closesAt(closes, pos) {
  return (closes.get(pos) ?? []).slice().reverse();
}

// Returns the custom emoji id of the first premium emoji in a message, or null.
export function firstCustomEmojiId(entities = []) {
  const e = entities.find((x) => x.type === "custom_emoji" && x.custom_emoji_id);
  return e ? e.custom_emoji_id : null;
}
