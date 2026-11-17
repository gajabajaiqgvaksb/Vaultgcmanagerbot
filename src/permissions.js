// Permission checks. A user may act as a group admin if Telegram says they are
// creator/administrator in the chat, or if they are a bot owner (OWNER_IDS).
// Results are cached briefly to avoid an API call per command.

const CACHE_TTL_MS = 60_000;
const ADMIN_STATUSES = new Set(["creator", "administrator"]);

export class PermissionService {
  constructor({ client, ownerIds = [], store = null, now = () => Date.now() }) {
    this.client = client;
    this.store = store;
    this.owners = new Set(ownerIds);
    this.now = now;
    this.cache = new Map();
  }

  isOwner(userId) {
    return this.owners.has(userId);
  }

  // Super admins manage any group. A group owner manages their own group once
  // it is activated (free plan claim, or a super admin's activation).
  canManageGroup(chatId, userId) {
    if (this.isOwner(userId)) return true;
    if (!this.store || !userId) return false;
    return this.store.isActive(chatId) && this.store.ownerIdOf(chatId) === userId;
  }

  async isGroupAdmin(chatId, userId) {
    if (this.isOwner(userId)) return true;
    const key = `${chatId}:${userId}`;
    const hit = this.cache.get(key);
    if (hit && hit.exp > this.now()) return hit.value;

    let value = false;
    try {
      const member = await this.client.getChatMember(chatId, userId);
      value = ADMIN_STATUSES.has(member.status);
    } catch {
      value = false; // fail closed
    }
    this.cache.set(key, { value, exp: this.now() + CACHE_TTL_MS });
    return value;
  }

  // Returns the bot's own rights in a chat, or null if it is not an admin.
  async botRights(chatId) {
    const me = this.botUser ?? (this.botUser = await this.client.getMe());
    try {
      const member = await this.client.getChatMember(chatId, me.id);
      if (member.status !== "administrator" && member.status !== "creator") return null;
      return {
        canDelete: member.status === "creator" || Boolean(member.can_delete_messages),
        canRestrict: member.status === "creator" || Boolean(member.can_restrict_members),
        canPromote: member.status === "creator" || Boolean(member.can_promote_members),
        canPin: member.status === "creator" || Boolean(member.can_pin_messages),
      };
    } catch {
      return null;
    }
  }

  invalidate(chatId, userId) {
    this.cache.delete(`${chatId}:${userId}`);
  }
}
