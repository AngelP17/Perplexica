import { sql } from 'drizzle-orm';
import {
  text,
  integer,
  sqliteTable,
  index,
} from 'drizzle-orm/sqlite-core';
import { Block } from '../types';
import { SearchSources } from '../agents/search/types';

export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey(),
    messageId: text('messageId').notNull(),
    chatId: text('chatId').notNull(),
    backendId: text('backendId').notNull(),
    query: text('query').notNull(),
    createdAt: text('createdAt').notNull(),
    responseBlocks: text('responseBlocks', { mode: 'json' })
      .$type<Block[]>()
      .default(sql`'[]'`),
    status: text({ enum: ['answering', 'completed', 'error'] }).default(
      'answering',
    ),
  },
  (table) => ({
    // Composite index for finding messages by chat and messageId
    chatMessageIdx: index('messages_chat_message_idx').on(
      table.chatId,
      table.messageId,
    ),
    // Index for finding recent messages in a chat
    chatCreatedIdx: index('messages_chat_created_idx').on(
      table.chatId,
      table.createdAt,
    ),
  }),
);

interface DBFile {
  name: string;
  fileId: string;
}

export const chats = sqliteTable(
  'chats',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    createdAt: text('createdAt').notNull(),
    sources: text('sources', {
      mode: 'json',
    })
      .$type<SearchSources[]>()
      .default(sql`'[]'`),
    files: text('files', { mode: 'json' })
      .$type<DBFile[]>()
      .default(sql`'[]'`),
  },
  (table) => ({
    // Index for finding chats by creation date (for recent chats listing)
    createdIdx: index('chats_created_idx').on(table.createdAt),
  }),
);
