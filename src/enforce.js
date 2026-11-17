// Enforcement primitives shared by moderation and admin commands.

export const NO_PERMISSIONS = Object.freeze({
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
});

export const FULL_PERMISSIONS = Object.freeze({
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
});

export class Enforcer {
  constructor({ client, store }) {
    this.client = client;
    this.store = store;
  }

  async mute(chatId, userId, minutes, { actorId = null, reason = "" } = {}) {
    const until = minutes > 0 ? Math.floor(Date.now() / 1000) + minutes * 60 : 0;
    await this.client.restrictMember(chatId, userId, NO_PERMISSIONS, until || undefined);
    this.store.log(chatId, "mute", { actorId, targetId: userId, detail: `${minutes}m ${reason}`.trim() });
  }

  async unmute(chatId, userId, { actorId = null } = {}) {
    await this.client.restrictMember(chatId, userId, FULL_PERMISSIONS);
    this.store.log(chatId, "unmute", { actorId, targetId: userId });
  }

  async kick(chatId, userId, { actorId = null, reason = "" } = {}) {
    await this.client.banMember(chatId, userId);
    await this.client.unbanMember(chatId, userId); // kick = ban then unban
    this.store.log(chatId, "kick", { actorId, targetId: userId, detail: reason });
  }

  async ban(chatId, userId, { actorId = null, reason = "" } = {}) {
    await this.client.banMember(chatId, userId);
    this.store.log(chatId, "ban", { actorId, targetId: userId, detail: reason });
  }

  async unban(chatId, userId, { actorId = null } = {}) {
    await this.client.unbanMember(chatId, userId);
    this.store.log(chatId, "unban", { actorId, targetId: userId });
  }

  // Adds one warning. Returns { count, limit, actioned } where actioned is the
  // escalation action applied (or null) once the limit is reached.
  async warn(chatId, userId, { actorId = null, reason = "" } = {}) {
    const settings = this.store.getSettings(chatId);
    const limit = settings.warnings.limit;
    const count = this.store.getWarnings(chatId, userId) + 1;
    this.store.log(chatId, "warn", { actorId, targetId: userId, detail: `${count}/${limit} ${reason}`.trim() });

    if (count < limit) {
      this.store.setWarnings(chatId, userId, count);
      return { count, limit, actioned: null };
    }

    this.store.setWarnings(chatId, userId, 0); // reset after escalation
    const action = settings.warnings.action;
    if (action === "kick") await this.kick(chatId, userId, { actorId: null, reason: "warning limit" });
    else if (action === "ban") await this.ban(chatId, userId, { actorId: null, reason: "warning limit" });
    else await this.mute(chatId, userId, settings.warnings.muteMinutes, { actorId: null, reason: "warning limit" });
    return { count, limit, actioned: action };
  }

  async unwarn(chatId, userId, { actorId = null } = {}) {
    const count = Math.max(0, this.store.getWarnings(chatId, userId) - 1);
    this.store.setWarnings(chatId, userId, count);
    this.store.log(chatId, "unwarn", { actorId, targetId: userId });
    return count;
  }
}
