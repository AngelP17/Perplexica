import { z } from 'zod';
import { eq } from 'drizzle-orm';
import SearchAgent from '@/lib/agents/search';
import { SearchSources } from '@/lib/agents/search/types';
import db from '@/lib/db';
import { chats } from '@/lib/db/schema';
import { enforceRateLimit } from '@/lib/middleware/rateLimiter';
import ModelRegistry from '@/lib/models/registry';
import { loadRoutedChatModel } from '@/lib/models/routing';
import { ModelWithProvider } from '@/lib/models/types';
import SessionManager from '@/lib/session';
import { ChatTurnMessage } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const messageSchema = z
  .object({
    messageId: z.string().trim().min(1),
    chatId: z.string().trim().min(1),
    content: z.string().trim().min(1),
  })
  .optional();

const modelSchema: z.ZodType<ModelWithProvider> = z.object({
  providerId: z.string().trim().min(1),
  key: z.string().trim().min(1),
});

const sourceSchema = z.enum(['web', 'discussions', 'academic']);

const bodySchema = z.object({
  message: messageSchema,
  chatId: z.string().trim().optional(),
  query: z.string().trim().optional(),
  content: z.string().trim().optional(),
  optimizationMode: z
    .enum(['speed', 'balanced', 'quality'])
    .optional()
    .default('speed'),
  sources: z.array(sourceSchema).min(1).default(['web']),
  files: z.array(z.string()).optional().default([]),
  history: z
    .array(z.tuple([z.string(), z.string()]))
    .optional()
    .default([]),
  chatModel: modelSchema,
  embeddingModel: modelSchema.optional(),
  systemInstructions: z.string().nullable().optional().default(''),
});

const resolveMessagePayload = (body: z.infer<typeof bodySchema>) => {
  const content = body.message?.content || body.content || body.query || '';
  const chatId = body.message?.chatId || body.chatId || crypto.randomUUID();
  const messageId = body.message?.messageId || crypto.randomUUID();

  return {
    chatId,
    messageId,
    content: content.trim(),
  };
};

const ensureChatExists = async (input: {
  chatId: string;
  query: string;
  sources: SearchSources[];
  files: string[];
}) => {
  const existing = await db.query.chats.findFirst({
    where: eq(chats.id, input.chatId),
  });

  if (!existing) {
    await db.insert(chats).values({
      id: input.chatId,
      title: input.query,
      createdAt: new Date().toISOString(),
      sources: input.sources,
      files: input.files.map((fileId) => ({
        fileId,
        name: fileId,
      })),
    });
    return;
  }

  await db
    .update(chats)
    .set({
      sources: input.sources,
      files: input.files.map((fileId) => ({
        fileId,
        name: fileId,
      })),
    })
    .where(eq(chats.id, input.chatId))
    .execute();
};

export const POST = async (req: Request) => {
  try {
    const rateLimit = enforceRateLimit(req, 'chat');
    if (!rateLimit.allowed) {
      return rateLimit.response;
    }

    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json(
        {
          message: 'Invalid request body',
          error: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
        { status: 400, headers: rateLimit.headers },
      );
    }

    const body = parsed.data;
    const payload = resolveMessagePayload(body);

    if (!payload.content) {
      return Response.json(
        { message: 'Message content is required' },
        { status: 400, headers: rateLimit.headers },
      );
    }

    const registry = new ModelRegistry();
    const shouldLoadEmbedding =
      body.files.length > 0 || body.sources.length > 0;

    if (shouldLoadEmbedding && !body.embeddingModel) {
      return Response.json(
        { message: 'Embedding model is required for search requests.' },
        { status: 400, headers: rateLimit.headers },
      );
    }

    const [chatSelection, embedding] = await Promise.all([
      loadRoutedChatModel(registry, body.chatModel, body.optimizationMode),
      shouldLoadEmbedding
        ? registry.loadEmbeddingModel(
            body.embeddingModel!.providerId,
            body.embeddingModel!.key,
          )
        : Promise.resolve(undefined),
    ]);

    const history: ChatTurnMessage[] = body.history.map((entry) =>
      entry[0] === 'human'
        ? { role: 'user', content: entry[1] }
        : { role: 'assistant', content: entry[1] },
    );

    await ensureChatExists({
      chatId: payload.chatId,
      query: payload.content,
      sources: body.sources,
      files: body.files,
    });

    const agent = new SearchAgent();
    const session = SessionManager.createSession();
    const responseStream = new TransformStream();
    const writer = responseStream.writable.getWriter();
    const encoder = new TextEncoder();

    const disconnect = session.subscribe((event, data) => {
      if (event === 'data') {
        if (data.type === 'block') {
          writer.write(
            encoder.encode(
              JSON.stringify({
                type: 'block',
                block: data.block,
              }) + '\n',
            ),
          );
        } else if (data.type === 'updateBlock') {
          writer.write(
            encoder.encode(
              JSON.stringify({
                type: 'updateBlock',
                blockId: data.blockId,
                patch: data.patch,
              }) + '\n',
            ),
          );
        } else if (data.type === 'researchComplete') {
          writer.write(
            encoder.encode(
              JSON.stringify({
                type: 'researchComplete',
              }) + '\n',
            ),
          );
        }
      } else if (event === 'end') {
        writer.write(
          encoder.encode(
            JSON.stringify({
              type: 'messageEnd',
            }) + '\n',
          ),
        );
        writer.close();
        disconnect();
      } else if (event === 'error') {
        writer.write(
          encoder.encode(
            JSON.stringify({
              type: 'error',
              data: data.data,
            }) + '\n',
          ),
        );
        writer.close();
        disconnect();
      }
    });

    agent.searchAsync(session, {
      chatHistory: history,
      config: {
        embedding,
        llm: chatSelection.llm,
        sources: body.sources,
        mode: body.optimizationMode,
        fileIds: body.files,
        systemInstructions: body.systemInstructions || '',
      },
      followUp: payload.content,
      chatId: payload.chatId,
      messageId: payload.messageId,
    });

    req.signal.addEventListener('abort', () => {
      disconnect();
      writer.close().catch(() => undefined);
    });

    return new Response(responseStream.readable, {
      headers: {
        ...rateLimit.headers,
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache, no-transform',
      },
    });
  } catch (error) {
    console.error('Error while processing a chat request:', error);
    return Response.json(
      { message: 'An error has occurred.' },
      { status: 500 },
    );
  }
};
