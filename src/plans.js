// Subscription plans.
//
// Free plan: the person who added the bot claims one group by joining the
// configured channel (FREE_PLAN_CHANNEL) and pressing I JOINED or sending /claim.
// Each user can claim one group. The free plan locks premium emojis, templates
// and the advanced admin thresholds. Super admins are never locked.
//
// Paid plan: not sold yet ("coming soon"). It will lift the locks once a
// payment gateway is connected.

export const FEATURES = Object.freeze({
  EMOJI: "emoji", // premium emoji slots
  TEMPLATES: "templates", // /settemplate and /applytemplate
  ADVANCED: "advanced", // warning limits, flood and duplicate windows, reveal threshold
});

// Setting keys (panel cycle codes) that count as advanced.
export const ADVANCED_CYCLE_CODES = Object.freeze(new Set(["wl", "wa", "wm", "dw", "fm", "fp", "wr"]));

// Features locked for a group, given its settings.
export function lockedFeatures(settings) {
  if (settings?.subscription?.plan === "free") {
    return new Set([FEATURES.EMOJI, FEATURES.TEMPLATES, FEATURES.ADVANCED]);
  }
  return new Set();
}

export const PAID_PLAN_TEXT = "Paid plan: coming soon. It will unlock premium emojis, templates and advanced settings.";

export class FreePlan {
  constructor({ store, forceSub, channel }) {
    this.store = store;
    this.forceSub = forceSub;
    this.channel = channel || "";
  }

  get enabled() {
    return this.channel !== "";
  }

  channelLink() {
    return `https://t.me/${this.channel.replace(/^@/, "")}`;
  }

  // Returns { ok, text }. Only the group's owner can claim, and only after
  // they have joined the channel.
  async claim(chatId, userId) {
    if (!this.enabled) {
      return { ok: false, text: "The free plan is not available right now." };
    }
    if (this.store.ownerIdOf(chatId) !== userId) {
      return { ok: false, text: "Only the person who added this bot can claim the free plan." };
    }
    const settings = this.store.getSettings(chatId);
    if (settings.subscription.plan === "free" && this.store.isActive(chatId)) {
      return { ok: true, text: "This group is already on the free plan." };
    }

    const previous = this.store.claimOf(userId);
    if (previous !== null && previous !== chatId) {
      const title = this.store.getGroup(previous)?.title || String(previous);
      return {
        ok: false,
        text: `The free plan allows one group per person. Your free group is "${title}".`,
      };
    }

    const { joined, error } = await this.forceSub.isMember(this.channel, userId, chatId);
    if (error) {
      return { ok: false, text: "Could not verify your channel membership right now. Try again in a minute." };
    }
    if (!joined) {
      return { ok: false, text: `Join ${this.channel} first, then tap I JOINED again.` };
    }

    this.store.setActive(chatId, true);
    const s = this.store.getSettings(chatId);
    s.subscription.plan = "free";
    this.store.saveSettings(chatId, s);
    this.store.setClaim(userId, chatId);
    this.store.log(chatId, "plan_claim_free", { actorId: userId });
    return { ok: true, text: "Activated on the free plan. Send /panel to configure the group." };
  }
}
