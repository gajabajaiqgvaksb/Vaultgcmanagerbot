#!/usr/bin/env node
// Entry point: loads configuration, starts the HTTP server, then the bot.

import { readFileSync, existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { createBot } from "./bot.js";
import { createHttpServer } from "./server.js";

// Minimal .env loader so local runs do not need an extra dependency.
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

try {
  const config = loadConfig();
  const bot = createBot(config);

  // Webhook mode needs an HTTP port. Polling mode only needs one on hosts
  // that require it (Render sets PORT), so start the server whenever PORT is set.
  const port = config.port ?? (config.mode === "webhook" ? 3000 : null);
  let server = null;
  if (port !== null) {
    server = createHttpServer({ bot, config });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", resolve);
    });
    console.log(`HTTP server listening on port ${port}`);
  }

  // Register before bot.start(): in polling mode that call blocks.
  const shutdown = () => {
    console.log("Shutting down.");
    if (server) server.close(() => process.exit(0));
    else process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await bot.start();
} catch (err) {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
}
