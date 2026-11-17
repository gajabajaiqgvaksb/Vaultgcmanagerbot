// Runtime configuration, read from environment variables.

const SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;

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

  // "webhook" receives updates over HTTP (required on Render web services).
  // "polling" uses getUpdates and is intended for local development only.
  const mode = (env.MODE?.trim() || "polling").toLowerCase();
  if (mode !== "webhook" && mode !== "polling") {
    throw new Error(`MODE must be "webhook" or "polling", got "${mode}".`);
  }

  // Render sets PORT automatically for web services.
  const port = env.PORT ? Number(env.PORT) : null;
  if (port !== null && !(Number.isInteger(port) && port > 0 && port < 65536)) {
    throw new Error(`PORT is invalid: ${env.PORT}`);
  }

  const publicUrl = env.PUBLIC_URL?.trim().replace(/\/+$/, "") || "";
  const webhookSecret = env.WEBHOOK_SECRET?.trim() || "";
  if (mode === "webhook") {
    if (!/^https:\/\//.test(publicUrl)) {
      throw new Error("PUBLIC_URL must be the https URL of this service in webhook mode.");
    }
    if (!SECRET_RE.test(webhookSecret)) {
      throw new Error("WEBHOOK_SECRET is required in webhook mode (letters, digits, _ or -, up to 256 chars).");
    }
  }

  // Channel a group owner must join to claim the free plan, e.g. @mychannel.
  const freePlanChannel = env.FREE_PLAN_CHANNEL?.trim() || "";

  return {
    token,
    ownerIds,
    freePlanChannel,
    // Supabase/Postgres connection string. When set, state is snapshotted there.
    databaseUrl: env.DATABASE_URL?.trim() || "",
    mode,
    port,
    publicUrl,
    webhookSecret,
    dbPath: env.DB_PATH?.trim() || "data/bot.sqlite",
    pollTimeoutSec: Number(env.POLL_TIMEOUT_SEC) || 30,
    apiBase: env.TELEGRAM_API_BASE?.trim() || "https://api.telegram.org",
  };
}
