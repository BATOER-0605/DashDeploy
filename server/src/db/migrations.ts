import type Database from "better-sqlite3";

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deployments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_full_name TEXT NOT NULL,
      branch TEXT NOT NULL,
      server_name TEXT NOT NULL,
      status TEXT NOT NULL,
      pre_snapshot_name TEXT,
      tailscale_ip TEXT,
      app_port INTEGER,
      app_url TEXT,
      health TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS deployment_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deployment_id INTEGER NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
      ts TEXT NOT NULL,
      stream TEXT NOT NULL,
      line TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_deployment
      ON deployment_events (deployment_id, id);
  `);
}
