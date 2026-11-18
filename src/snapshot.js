// Persists the SQLite state to Postgres (Supabase) so settings survive restarts
// and redeploys. The bot keeps working on its local SQLite store; this module
// loads the last snapshot at startup and saves changes every few seconds.
//
// Needs the `pg` package, which is installed by `npm install` on Render.

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS bot_snapshot (
  id         INTEGER PRIMARY KEY,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

export class PostgresSnapshot {
  constructor({ store, url, intervalMs = 5000, log = console }) {
    this.store = store;
    this.url = url;
    this.intervalMs = intervalMs;
    this.log = log;
    this.pg = null;
    this.client = null;
    this.timer = null;
    this.lastSaved = null;
  }

  // Opens a connection and makes sure the table exists. If the connection
  // later drops, the error handler clears it so the next save reconnects,
  // instead of the process crashing on an unhandled 'error' event.
  async connect() {
    this.pg ??= (await import("pg")).default;
    const client = new this.pg.Client({ connectionString: this.url, ssl: { rejectUnauthorized: false } });
    client.on("error", (err) => {
      this.log.error("Postgres connection lost:", err.message);
      if (this.client === client) this.client = null;
    });
    await client.connect();
    await client.query(TABLE_SQL);
    this.client = client;
    return client;
  }

  // Connects, restores the last snapshot into the store, and starts the save loop.
  async start() {
    await this.connect();

    const res = await this.client.query("SELECT data FROM bot_snapshot WHERE id = 1");
    if (res.rows.length) {
      this.store.importAll(res.rows[0].data);
      this.log.log("Restored settings from Postgres snapshot.");
    } else {
      this.log.log("No Postgres snapshot yet; starting fresh.");
    }
    this.lastSaved = JSON.stringify(this.store.exportAll());

    this.timer = setInterval(() => {
      this.flush().catch((err) => this.log.error("snapshot save failed:", err.message));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  // Saves only when something changed since the last save.
  async flush() {
    if (!this.client) await this.connect();
    const json = JSON.stringify(this.store.exportAll());
    if (json === this.lastSaved) return;
    await this.client.query(
      `INSERT INTO bot_snapshot (id, data, updated_at) VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = now()`,
      [json],
    );
    this.lastSaved = json;
  }

  // Final save and disconnect, called on shutdown.
  async stop() {
    if (this.timer) clearInterval(this.timer);
    try {
      await this.flush();
    } finally {
      await this.client?.end().catch(() => {});
      this.client = null;
    }
  }
}
