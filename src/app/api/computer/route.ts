import { z } from 'zod';
import ModelRegistry from '@/lib/models/registry';
import { ModelWithProvider } from '@/lib/models/types';
import ComputerAgent from '@/lib/agents/computer';
import { isComputerPersonaId } from '@/lib/agents/computer/personas/catalog';
import type { ComputerPersonaId } from '@/lib/agents/computer/personas/types';
import SessionManager from '@/lib/session';
import { ChatTurnMessage } from '@/lib/types';
import db from '@/lib/db';
import { eq } from 'drizzle-orm';
import { chats } from '@/lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const messageSchema = z.object({
  messageId: z.string().min(1, 'Message ID is required'),
  chatId: z.string().min(1, 'Chat ID is required'),
  content: z.string().min(1, 'Message content is required'),
});

const chatModelSchema: z.ZodType<ModelWithProvider> = z.object({
  providerId: z.string({ message: 'Chat model provider id must be provided' }),
  key: z.string({ message: 'Chat model key must be provided' }),
});

const specialistPersonaSchema = z
  .string()
  .trim()
  .optional()
  .nullable()
  .transform((value) => {
    if (!value) {
      return undefined;
    }

    return value;
  })
  .refine((value) => !value || isComputerPersonaId(value), {
    message: 'Unknown specialist persona',
  });

const bodySchema = z.object({
  message: messageSchema,
  optimizationMode: z.enum(['speed', 'balanced', 'quality'], {
    message: 'Optimization mode must be one of: speed, balanced, quality',
  }),
  swarmEnabled: z.boolean().optional().default(false),
  history: z
    .array(z.tuple([z.string(), z.string()]))
    .optional()
    .default([]),
  chatModel: chatModelSchema,
  systemInstructions: z.string().nullable().optional().default(''),
  specialistPersonaId: specialistPersonaSchema,
});

type Body = z.infer<typeof bodySchema>;

const safeValidateBody = (data: unknown) => {
  const result = bodySchema.safeParse(data);

  if (!result.success) {
    return {
      success: false as const,
      error: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  return {
    success: true as const,
    data: result.data,
  };
};

const ensureChatExists = async (input: { id: string; query: string }) => {
  try {
    const exists = await db.query.chats
      .findFirst({
        where: eq(chats.id, input.id),
      })
      .execute();

    if (!exists) {
      await db.insert(chats).values({
        id: input.id,
        createdAt: new Date().toISOString(),
        sources: [],
        title: input.query,
        files: [],
      });
    }
  } catch (error) {
    console.error('Failed to check/save computer chat:', error);
  }
};

export const POST = async (req: Request) => {
  try {
    const reqBody = (await req.json()) as Body;
    const parseBody = safeValidateBody(reqBody);

    if (!parseBody.success) {
      return Response.json(
        { message: 'Invalid request body', error: parseBody.error },
        { status: 400 },
      );
    }

    const body = parseBody.data;
    const { message } = body;

    const registry = new ModelRegistry();
    const llm = await registry.loadChatModel(
      body.chatModel.providerId,
      body.chatModel.key,
    );

    const history: ChatTurnMessage[] = body.history.map((entry) =>
      entry[0] === 'human'
        ? {
            role: 'user',
            content: entry[1],
          }
        : {
            role: 'assistant',
            content: entry[1],
          },
    );

    const agent = new ComputerAgent();
    const session = SessionManager.createSession();

    const responseStream = new TransformStream();
    const writer = responseStream.writable.getWriter();
    const encoder = new TextEncoder();

    const disconnect = session.subscribe((event: string, data: any) => {
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
        session.removeAllListeners();
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
        session.removeAllListeners();
      }
    });

    agent.executeAsync(session, {
      chatHistory: history,
      task: message.content,
      chatId: message.chatId,
      messageId: message.messageId,
      config: {
        llm,
        mode: body.optimizationMode,
        swarmEnabled: body.swarmEnabled,
        systemInstructions: body.systemInstructions || '',
        specialistPersonaId:
          body.specialistPersonaId as ComputerPersonaId | undefined,
        resolveChatModel: async (modelKey: string) =>
          registry.loadChatModel(body.chatModel.providerId, modelKey),
      },
    });

    ensureChatExists({
      id: message.chatId,
      query: message.content,
    });

    req.signal.addEventListener('abort', () => {
      disconnect();
      writer.close().catch(() => undefined);
    });

    return new Response(responseStream.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache, no-transform',
      },
    });
  } catch (error) {
    console.error('An error occurred while processing a computer task:', error);

    return Response.json(
      { message: 'An error occurred while processing the computer task' },
      { status: 500 },
    );
  }
};
