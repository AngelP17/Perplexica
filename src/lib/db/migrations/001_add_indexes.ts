/**
 * Migration: Add database indexes for improved query performance
 *
 * Creates composite indexes on frequently queried columns:
 * - messages(chatId, messageId) for fast message lookups
 * - messages(chatId, createdAt) for recent messages in chat
 * - chats(createdAt) for recent chats listing
 *
 * Expected impact: 10-100x faster queries (200ms → 10ms)
 */

import Database from 'better-sqlite3';

export const up = (db: Database.Database) => {
  console.log('[Migration 001] Adding database indexes...');

  // Check if indexes already exist before creating
  const indexes = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name IN ('messages_chat_message_idx', 'messages_chat_created_idx', 'chats_created_idx')`,
    )
    .all() as { name: string }[];

  const existingIndexes = new Set(indexes.map((i) => i.name));

  // Create messages(chatId, messageId) composite index
  if (!existingIndexes.has('messages_chat_message_idx')) {
    db.prepare(
      `CREATE INDEX IF NOT EXISTS messages_chat_message_idx ON messages(chatId, messageId)`,
    ).run();
    console.log('  ✓ Created messages_chat_message_idx');
  } else {
    console.log('  • messages_chat_message_idx already exists (skipped)');
  }

  // Create messages(chatId, createdAt) index
  if (!existingIndexes.has('messages_chat_created_idx')) {
    db.prepare(
      `CREATE INDEX IF NOT EXISTS messages_chat_created_idx ON messages(chatId, createdAt)`,
    ).run();
    console.log('  ✓ Created messages_chat_created_idx');
  } else {
    console.log('  • messages_chat_created_idx already exists (skipped)');
  }

  // Create chats(createdAt) index
  if (!existingIndexes.has('chats_created_idx')) {
    db.prepare(
      `CREATE INDEX IF NOT EXISTS chats_created_idx ON chats(createdAt)`,
    ).run();
    console.log('  ✓ Created chats_created_idx');
  } else {
    console.log('  • chats_created_idx already exists (skipped)');
  }

  console.log('[Migration 001] Database indexes added successfully! 🚀');
};

export const down = (db: Database.Database) => {
  console.log('[Migration 001] Removing database indexes...');

  db.prepare(`DROP INDEX IF EXISTS messages_chat_message_idx`).run();
  db.prepare(`DROP INDEX IF EXISTS messages_chat_created_idx`).run();
  db.prepare(`DROP INDEX IF EXISTS chats_created_idx`).run();

  console.log('[Migration 001] Indexes removed');
};
