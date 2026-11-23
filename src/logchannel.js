// Posts bot-wide events (new groups, plan claims) to an owner-configured
// Telegram channel, so the owner does not have to poll the owner panel for
// them. Configured via the owner panel's "Set logs channel" prompt.

export async function notifyLogChannel(client, store, text) {
  const channel = store.getLogChannel();
  if (!channel) return;
  const chatId = /^-?\d+$/.test(channel) ? Number(channel) : channel;
  try {
    await client.sendMessage(chatId, text);
  } catch (err) {
    console.error(`log channel notify failed (${channel}):`, err.message);
  }
}
