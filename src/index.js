#!/usr/bin/env node
// Entry point: loads configuration and starts the long-polling loop.

import { readFileSync, existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { createBot } from "./bot.js";

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
  await bot.start();
} catch (err) {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
}
