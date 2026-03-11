import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema';
import path from 'path';

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

  // Import and run migrations in order
  const migrations = [{ name: '001_add_indexes', module: null as any }];

  migrations.forEach(async (migration) => {
    if (applied.has(migration.name)) {
      return; // Already applied
    }

    try {
      // Dynamic import of migration
      const migrationModule = await import(
        `./migrations/${migration.name}.js`
      ).catch(() => {
        // Fallback for TypeScript development
        return import(`./migrations/${migration.name}.ts`);
      });

      if (migrationModule.up) {
        migrationModule.up(db);
        // Record migration as applied
        db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(
          migration.name,
        );
      }
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
