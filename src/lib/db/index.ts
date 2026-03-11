import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema';
import path from 'path';
import { up as addIndexesMigration } from './migrations/001_add_indexes';

const DATA_DIR = process.env.DATA_DIR || process.cwd();
const sqlite = new Database(path.join(DATA_DIR, './data/db.sqlite'));

// Run database migrations
const runMigrations = (db: Database.Database) => {
  // Create migrations tracking table if it doesn't exist
  db.prepare(
    `CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  ).run();

  const appliedMigrations = db
    .prepare(`SELECT name FROM _migrations`)
    .all() as { name: string }[];
  const applied = new Set(appliedMigrations.map((m) => m.name));

  const migrations = [
    {
      name: '001_add_indexes',
      up: addIndexesMigration,
    },
  ];

  migrations.forEach((migration) => {
    if (applied.has(migration.name)) {
      return;
    }

    try {
      migration.up(db);
      db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(
        migration.name,
      );
    } catch (error) {
      console.error(`Failed to run migration ${migration.name}:`, error);
    }
  });
};

// Run migrations on startup
runMigrations(sqlite);

const db = drizzle(sqlite, {
  schema: schema,
});

export default db;
