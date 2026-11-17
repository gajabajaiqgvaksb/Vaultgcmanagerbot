// Minimal Telegram Bot API client built on global fetch.
// Handles JSON calls, 429 retry-after, and surfaces errors as TelegramError.

export class TelegramError extends Error {
  constructor(method, code, description) {
    super(`${method} failed (${code}): ${description}`);
    this.name = "TelegramError";
    this.method = method;
    this.code = code;
    this.description = description;
  }

  // Errors that mean "nothing to do" rather than a real failure.
  get benign() {
    const d = this.description.toLowerCase();
    return (
      d.includes("message to delete not found") ||
      d.includes("message can't be deleted") ||
      d.includes("message is not modified") ||
      d.includes("user is an administrator") ||
      d.includes("message to edit not found")
    );
  }
}

export class TelegramClient {
  constructor({ token, apiBase = "https://api.telegram.org", fetchImpl = fetch, sleep = defaultSleep }) {
    this.base = `${apiBase}/bot${token}`;
    this.fetch = fetchImpl;
    this.sleep = sleep;
  }

  async call(method, params = {}, { retries = 2, timeoutMs = 60_000 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await this.fetch(`${this.base}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
          signal: controller.signal,
        });
      } catch (err) {
        if (attempt < retries) {
          await this.sleep(1000 * (attempt + 1));
          continue;
        }
        throw new TelegramError(method, 0, `network error: ${err.message}`);
      } finally {
        clearTimeout(timer);
      }

      let body;
      try {
        body = await res.json();
      } catch {
        throw new TelegramError(method, res.status, "invalid JSON response");
      }

      if (body.ok) return body.result;

      if (res.status === 429 && attempt < retries) {
        const wait = body.parameters?.retry_after ?? 1;
        await this.sleep(wait * 1000);
        continue;
      }
      throw new TelegramError(method, body.error_code ?? res.status, body.description ?? "unknown error");
    }
  }

  // Calls that may fail for benign reasons return null instead of throwing.
  async tryCall(method, params, opts) {
    try {
      return await this.call(method, params, opts);
    } catch (err) {
      if (err instanceof TelegramError && err.benign) return null;
      throw err;
    }
  }

  getUpdates(offset, timeoutSec) {
    return this.call(
      "getUpdates",
      { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query", "chat_member", "my_chat_member"] },
      { retries: 0, timeoutMs: (timeoutSec + 15) * 1000 },
    );
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  }

  deleteMessage(chatId, messageId) {
    return this.tryCall("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  restrictMember(chatId, userId, permissions, untilDate) {
    return this.call("restrictChatMember", {
      chat_id: chatId,
      user_id: userId,
      permissions,
      ...(untilDate ? { until_date: untilDate } : {}),
    });
  }

  banMember(chatId, userId) {
    return this.call("banChatMember", { chat_id: chatId, user_id: userId });
  }

  unbanMember(chatId, userId) {
    // only_if_banned keeps this from kicking a user who is currently present.
    return this.call("unbanChatMember", { chat_id: chatId, user_id: userId, only_if_banned: true });
  }

  getChatMember(chatId, userId) {
    return this.call("getChatMember", { chat_id: chatId, user_id: userId });
  }

  getChatAdministrators(chatId) {
    return this.call("getChatAdministrators", { chat_id: chatId });
  }

  answerCallbackQuery(id, text = "", showAlert = false) {
    return this.tryCall("answerCallbackQuery", { callback_query_id: id, text, show_alert: showAlert });
  }

  editMessageText(chatId, messageId, text, extra = {}) {
    return this.tryCall("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    });
  }

  pinChatMessage(chatId, messageId) {
    return this.call("pinChatMessage", { chat_id: chatId, message_id: messageId, disable_notification: true });
  }

  unpinChatMessage(chatId, messageId) {
    return this.call("unpinChatMessage", { chat_id: chatId, message_id: messageId });
  }

  promoteMember(chatId, userId, rights) {
    return this.call("promoteChatMember", { chat_id: chatId, user_id: userId, ...rights });
  }

  deleteMessages(chatId, messageIds) {
    // deleteMessages accepts at most 100 ids per call.
    const chunks = [];
    for (let i = 0; i < messageIds.length; i += 100) chunks.push(messageIds.slice(i, i + 100));
    return Promise.all(chunks.map((ids) =>
      this.tryCall("deleteMessages", { chat_id: chatId, message_ids: ids }),
    ));
  }

  setChatPermissions(chatId, permissions) {
    return this.call("setChatPermissions", { chat_id: chatId, permissions });
  }

  setWebhook(url, secretToken) {
    return this.call("setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: ["message", "callback_query", "my_chat_member"],
      drop_pending_updates: false,
    });
  }

  deleteWebhook() {
    return this.call("deleteWebhook", { drop_pending_updates: false });
  }

  getMe() {
    return this.call("getMe");
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
