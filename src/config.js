// Runtime configuration, read from environment variables.

export function loadConfig(env = process.env) {
  const token = env.BOT_TOKEN?.trim();
  if (!token) {
    throw new Error("BOT_TOKEN is required. Set it in the environment or a .env file.");
  }

  const ownerIds = (env.OWNER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isSafeInteger);

  return {
    token,
    ownerIds,
    dbPath: env.DB_PATH?.trim() || "data/bot.sqlite",
    pollTimeoutSec: Number(env.POLL_TIMEOUT_SEC) || 30,
    apiBase: env.TELEGRAM_API_BASE?.trim() || "https://api.telegram.org",
  };
}
