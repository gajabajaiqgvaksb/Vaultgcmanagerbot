// SQLite persistence via Node's built-in node:sqlite (Node >= 22.13).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_SETTINGS, mergeSettings } from "./settings.js";

const TEMPLATE_CHAT_ID = 0;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  chat_id    INTEGER PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  settings   TEXT NOT NULL DEFAULT '{}',
  rules      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS group_admins (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS banned_words (
  chat_id INTEGER NOT NULL,
  word    TEXT NOT NULL,
  PRIMARY KEY (chat_id, word)
);
CREATE TABLE IF NOT EXISTS warnings (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  action     TEXT NOT NULL,
  actor_id   INTEGER,
  target_id  INTEGER,
  detail     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS logs_chat_idx ON logs (chat_id, id);
CREATE TABLE IF NOT EXISTS claims (
  user_id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDatabase(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return new Store(db);
}

export class Store {
  constructor(db) {
    this.db = db;
    this.stmts = {
      getGroup: db.prepare("SELECT * FROM groups WHERE chat_id = ?"),
      insertGroup: db.prepare(
        "INSERT OR IGNORE INTO groups (chat_id, title, settings) VALUES (?, ?, '{}')",
      ),
      updateTitle: db.prepare("UPDATE groups SET title = ? WHERE chat_id = ?"),
      updateSettings: db.prepare("UPDATE groups SET settings = ? WHERE chat_id = ?"),
      updateRules: db.prepare("UPDATE groups SET rules = ? WHERE chat_id = ?"),
      addAdmin: db.prepare(
        "INSERT OR IGNORE INTO group_admins (chat_id, user_id) VALUES (?, ?)",
      ),
      removeAdmin: db.prepare("DELETE FROM group_admins WHERE chat_id = ? AND user_id = ?"),
      isAdmin: db.prepare("SELECT 1 FROM group_admins WHERE chat_id = ? AND user_id = ?"),
      listAdmins: db.prepare("SELECT user_id FROM group_admins WHERE chat_id = ?"),
      addWord: db.prepare("INSERT OR IGNORE INTO banned_words (chat_id, word) VALUES (?, ?)"),
      removeWord: db.prepare("DELETE FROM banned_words WHERE chat_id = ? AND word = ?"),
      listWords: db.prepare("SELECT word FROM banned_words WHERE chat_id = ? ORDER BY word"),
      getWarnings: db.prepare("SELECT count FROM warnings WHERE chat_id = ? AND user_id = ?"),
      setWarnings: db.prepare(
        "INSERT INTO warnings (chat_id, user_id, count) VALUES (?, ?, ?) " +
          "ON CONFLICT (chat_id, user_id) DO UPDATE SET count = excluded.count",
      ),
      insertLog: db.prepare(
        "INSERT INTO logs (chat_id, action, actor_id, target_id, detail) VALUES (?, ?, ?, ?, ?)",
      ),
      recentLogs: db.prepare(
        "SELECT * FROM logs WHERE chat_id = ? ORDER BY id DESC LIMIT ?",
      ),
      allGroups: db.prepare(
        "SELECT chat_id, title, created_at FROM groups ORDER BY created_at DESC LIMIT 50",
      ),
      countGroups: db.prepare("SELECT COUNT(*) AS n FROM groups"),
      countLogs: db.prepare(
        "SELECT action, COUNT(*) AS n FROM logs WHERE chat_id = ? GROUP BY action ORDER BY n DESC",
      ),
    };
  }

  // ---- groups & settings ----

  ensureGroup(chatId, title = "") {
    this.stmts.insertGroup.run(chatId, title);
    if (title) this.stmts.updateTitle.run(title, chatId);
  }

  getGroup(chatId) {
    const row = this.stmts.getGroup.get(chatId);
    if (!row) return null;
    return {
      chatId: row.chat_id,
      title: row.title,
      rules: row.rules,
      settings: mergeSettings(JSON.parse(row.settings || "{}")),
    };
  }

  getSettings(chatId) {
    return this.getGroup(chatId)?.settings ?? structuredClone(DEFAULT_SETTINGS);
  }

  // ---- premium template: one settings set applied to new/other groups ----
  // Stored as a pseudo-group row with chat_id 0 (Telegram chat ids are never 0).

  getTemplate() {
    const row = this.stmts.getGroup.get(TEMPLATE_CHAT_ID);
    if (!row) return null;
    return mergeSettings(JSON.parse(row.settings || "{}"));
  }

  saveTemplate(settings) {
    this.stmts.insertGroup.run(TEMPLATE_CHAT_ID, "template");
    const tpl = structuredClone(settings);
    tpl.forceSubscribe.channel = ""; // channels are per group
    this.stmts.updateSettings.run(JSON.stringify(tpl), TEMPLATE_CHAT_ID);
  }

  // Copies the template into a group, keeping that group's own channel and
  // subscription state. Returns false when no template is saved.
  applyTemplate(chatId) {
    const tpl = this.getTemplate();
    if (!tpl) return false;
    const current = this.getSettings(chatId);
    const merged = structuredClone(tpl);
    merged.subscription = current.subscription;
    merged.forceSubscribe = {
      enabled: current.forceSubscribe.enabled,
      channel: current.forceSubscribe.channel,
    };
    this.saveSettings(chatId, merged);
    return true;
  }

  // ---- ownership and plans ----

  ownerIdOf(chatId) {
    return this.getSettings(chatId).subscription.ownerId;
  }

  setOwner(chatId, userId) {
    const s = this.getSettings(chatId);
    s.subscription.ownerId = userId;
    this.saveSettings(chatId, s);
  }

  // The one group a user has claimed on the free plan, or null.
  claimOf(userId) {
    const row = this.db.prepare("SELECT chat_id FROM claims WHERE user_id = ?").get(userId);
    return row ? row.chat_id : null;
  }

  setClaim(userId, chatId) {
    this.db
      .prepare("INSERT INTO claims (user_id, chat_id) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET chat_id = excluded.chat_id")
      .run(userId, chatId);
  }

  isActive(chatId) {
    return this.getSettings(chatId).subscription.active === true;
  }

  setActive(chatId, active) {
    const s = this.getSettings(chatId);
    s.subscription.active = Boolean(active);
    this.saveSettings(chatId, s);
  }

  saveSettings(chatId, settings) {
    this.stmts.updateSettings.run(JSON.stringify(settings), chatId);
  }

  setRules(chatId, text) {
    this.stmts.updateRules.run(text, chatId);
  }

  // ---- admins ----

  addAdmin(chatId, userId) {
    this.stmts.addAdmin.run(chatId, userId);
  }

  removeAdmin(chatId, userId) {
    this.stmts.removeAdmin.run(chatId, userId);
  }

  isBotAdmin(chatId, userId) {
    return Boolean(this.stmts.isAdmin.get(chatId, userId));
  }

  listAdmins(chatId) {
    return this.stmts.listAdmins.all(chatId).map((r) => r.user_id);
  }

  // ---- banned words ----

  addWord(chatId, word) {
    this.stmts.addWord.run(chatId, word.toLowerCase());
  }

  removeWord(chatId, word) {
    return this.stmts.removeWord.run(chatId, word.toLowerCase()).changes > 0;
  }

  listWords(chatId) {
    return this.stmts.listWords.all(chatId).map((r) => r.word);
  }

  // ---- warnings ----

  getWarnings(chatId, userId) {
    return this.stmts.getWarnings.get(chatId, userId)?.count ?? 0;
  }

  setWarnings(chatId, userId, count) {
    this.stmts.setWarnings.run(chatId, userId, count);
  }

  // ---- logs ----

  log(chatId, action, { actorId = null, targetId = null, detail = "" } = {}) {
    if (!this.logsEnabled(chatId)) return;
    this.stmts.insertLog.run(chatId, action, actorId, targetId, detail);
  }

  logsEnabled(chatId) {
    const row = this.stmts.getGroup.get(chatId);
    if (!row) return true;
    const raw = JSON.parse(row.settings || "{}");
    return raw.logs?.enabled !== false;
  }

  recentLogs(chatId, limit = 15) {
    return this.stmts.recentLogs.all(chatId, limit);
  }

  logCounts(chatId) {
    return this.stmts.countLogs.all(chatId);
  }

  getMeta(key) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? Number(row.value) : null;
  }

  setMeta(key, value) {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, String(value));
  }

  listGroups() {
    return this.stmts.allGroups.all().map((r) => ({ chatId: r.chat_id, title: r.title, createdAt: r.created_at }));
  }

  countGroups() {
    return this.stmts.countGroups.get().n;
  }
}
