# VaultGC Manager Bot

A Telegram group management and moderation bot. One bot instance serves many
groups, each with independent settings, banned words, rules and warnings.

Runs on Node.js 22.13+. Storage uses the built-in `node:sqlite` module, and
the Telegram Bot API is called directly with `fetch`. The only dependency is
`pg`, used to snapshot state to Postgres (Supabase) when `DATABASE_URL` is set,
so settings survive restarts and Render redeploys.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Copy the env template and fill it in:
   ```bash
   cp .env.example .env
   ```
3. Start the bot:
   ```bash
   npm start
   ```
4. Add the bot to a group and promote it to administrator with these rights:
   delete messages, restrict members, pin messages, invite users, and
   (optionally) add admins. Without delete rights the bot stays silent in that
   group and reports that it needs them. Admin rights are also required for
   join events: Telegram only sends member-join updates to an admin bot, so
   welcome messages depend on it.
5. Send `/panel` in the group to open the admin panel.

Run the tests with `npm test`.

## Features

### Moderation (applied to non-admin messages, in this order)
| Rule | Behaviour |
|---|---|
| Forwarded spam | Blocks messages forwarded from users or channels (opt-in) |
| Suspicious accounts | Blocks accounts without a @username (opt-in) |
| Links | Blocks Telegram links, external URLs, shorteners and promo phrases. Each is toggleable. |
| Banned words | Built-in default list plus per-group custom words. Whole-word, case and unicode-width insensitive. |
| Excessive messages | Max length and max emoji count (opt-in) |
| Duplicates | An identical message from the same user inside a window is deleted. The first is always allowed. |
| Flood | More than N messages in M seconds triggers. Thresholds are configurable. |
| Force subscribe | Non-members of a configured channel have their message deleted and see JOIN / I SUBSCRIBED buttons |

Each violation deletes the message and counts as a warning. At the warning
limit the bot applies the configured action (mute, kick or ban).

### Admin commands
`/ban /unban /kick /mute [dur] /unmute /warn /unwarn /warnings /purge /id /info
/rules /setrules /lock /unlock /pin /unpin /promote /demote /panel`

Target a user by replying to their message, or by passing a numeric user ID.
Usernames cannot be resolved through the Bot API, so reply or use the ID.
Admin commands refuse to act on other admins and on the bot itself.

### Admin panel (`/panel`)
Inline buttons for: General, Anti-spam, Link protection, Banned words, Welcome,
Force subscribe, Warnings, Duplicates, Flood, Group rules, Moderation logs,
Statistics and Reset. Text-based settings (adding a banned word, welcome text,
channel, rules) are entered by sending your next message in the group, which
expires after five minutes. Send `/cancel` to abort.

### Welcome messages
Customisable text with `{first_name}`, `{username}`, `{id}` and `{group}`
placeholders. Values are HTML-escaped. Supports up to six link buttons and an
automatic "Group rules" button when rules exist. Welcome is off by default and
is switched on in the panel.

Joins are detected from two Telegram updates: the `new_chat_members` service
message and `chat_member` updates. Telegram often omits the service message in
larger or open groups, so `chat_member` is the reliable path. Both feed the same
handler, and a short 60-second dedupe makes sure a member is welcomed only once.
Bots are never welcomed.

### Owner access
Users listed in `OWNER_IDS` are treated as admins in every group. Send
`/owner` to the bot in a private chat to list the groups it serves.

## Architecture

```
src/
  index.js        entry point, .env loader
  config.js       environment parsing
  bot.js          wiring + update routing (messages, callbacks, joins)
  telegram.js     Bot API client: retries on 429, typed errors
  db.js           SQLite store (groups, admins, words, warnings, logs, meta)
  settings.js     per-group settings schema, defaults and merging
  moderation.js   pure rule checks + duplicate/flood trackers
  pipeline.js     runs the rules in order, deletes, warns, escalates
  enforce.js      mute / kick / ban / warn primitives
  permissions.js  admin checks (cached) and bot rights
  forcesub.js     channel membership gate
  welcome.js      welcome rendering and buttons
  panel.js        inline admin panel and text-input prompts
  commands.js     slash commands
test/             unit tests and end-to-end tests against a fake Telegram API
```

Design notes:
- Every admin action re-verifies the caller's status with Telegram, cached for
  60 seconds. Failures fail closed.
- Force-subscribe checks membership on every message. Only positive results
  are cached (2 minutes), so an unsubscribed user is always re-checked.
- Settings are stored as one JSON document per group and merged over defaults
  on read, so new settings can ship without a migration.
- One bad update is logged and skipped. It cannot stop the polling loop.
- The polling offset is persisted, so restarts do not replay old updates.

## Limitations
- Usernames cannot be resolved to IDs unless the user has been seen by the bot
  in a reply or by ID. This is a Bot API limitation.
- Moderation requires the bot to be a group admin with delete rights.
- Welcome messages for joins require the bot to be a group admin, because
  Telegram does not deliver `chat_member` updates for other users otherwise.
- Local state lives in SQLite on the instance's disk. Without `DATABASE_URL`
  that disk is wiped on redeploy. With it, state is snapshotted to Postgres
  every few seconds and restored on startup.
- Webhook mode (`MODE=webhook`, used on Render) registers `allowed_updates`
  on each start, so a new update type only reaches the bot after a restart.
