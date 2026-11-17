// HTTP server: status page, health check for uptime pings, and the Telegram
// webhook receiver. Render web services need this to bind to PORT.

import { createServer } from "node:http";

const MAX_BODY_BYTES = 1024 * 1024;

export function createHttpServer({ bot, config, now = () => Date.now() }) {
  const startedAt = now();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
        return sendText(res, 200, statusPage(bot, config, startedAt, now()));
      }
      if (req.method === "GET" && url.pathname === "/health") {
        return sendText(res, 200, "ok");
      }
      if (req.method === "POST" && url.pathname === "/telegram") {
        return await handleWebhook(req, res, bot, config);
      }
      return sendText(res, 404, "not found");
    } catch (err) {
      console.error("http error:", err.message);
      if (!res.headersSent) sendText(res, 500, "internal error");
    }
  });

  return server;
}

async function handleWebhook(req, res, bot, config) {
  // Telegram sends the secret we registered in the X-Telegram-Bot-Api-Secret-Token header.
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (!config.webhookSecret || secret !== config.webhookSecret) {
    return sendText(res, 403, "forbidden");
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendText(res, 400, "bad request");
  }

  // Acknowledge first so Telegram does not retry slow updates.
  sendText(res, 200, "ok");
  bot.handleUpdate(body).catch((err) => console.error("update failed:", err.message));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

export function statusPage(bot, config, startedAt, nowMs) {
  const stats = bot.stats();
  const uptimeSec = Math.floor((nowMs - startedAt) / 1000);
  const lines = [
    "VaultGC Manager Bot",
    "",
    "Status:           running",
    `Mode:             ${config.mode}`,
    `Bot:              ${stats.botUsername ? `@${stats.botUsername}` : "connecting..."}`,
    `Uptime:           ${formatDuration(uptimeSec)}`,
    `Updates handled:  ${stats.updates}`,
    `Last update:      ${stats.lastUpdateAt ? new Date(stats.lastUpdateAt).toISOString() : "none yet"}`,
    `Database:         ${stats.database}`,
    "",
    "Health check:     /health",
  ];
  return lines.join("\n");
}

function formatDuration(totalSec) {
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(" ");
}
