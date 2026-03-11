import { z } from 'zod';
import APISearchAgent from '@/lib/agents/search/api';
import { SearchSources } from '@/lib/agents/search/types';
import { enforceRateLimit } from '@/lib/middleware/rateLimiter';
import ModelRegistry from '@/lib/models/registry';
import { loadRoutedChatModel } from '@/lib/models/routing';
import { ModelWithProvider } from '@/lib/models/types';
import SessionManager from '@/lib/session';
import { ChatTurnMessage } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const modelSchema: z.ZodType<ModelWithProvider> = z.object({
  providerId: z.string().trim().min(1),
  key: z.string().trim().min(1),
});

const sourceSchema = z.enum(['web', 'discussions', 'academic']);

const bodySchema = z.object({
  optimizationMode: z
    .enum(['speed', 'balanced', 'quality'])
    .optional()
    .default('speed'),
  sources: z.array(sourceSchema).min(1).default(['web']),
  chatModel: modelSchema,
  embeddingModel: modelSchema.optional(),
  query: z.string().trim().min(1),
  history: z
    .array(z.tuple([z.string(), z.string()]))
    .optional()
    .default([]),
  files: z.array(z.string()).optional().default([]),
  stream: z.boolean().optional().default(false),
  systemInstructions: z.string().nullable().optional().default(''),
});

export const POST = async (req: Request) => {
  try {
    const rateLimit = enforceRateLimit(req, 'search');
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

    const session = SessionManager.createSession();
    const agent = new APISearchAgent();

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
      followUp: body.query,
      chatId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
    });

    if (!body.stream) {
      return new Promise<Response>((resolve) => {
        let message = '';
        let sources: unknown[] = [];

        session.subscribe((event, data) => {
          if (event === 'data') {
            if (data.type === 'response') {
              message += data.data;
            } else if (data.type === 'searchResults') {
              sources = data.data;
            }
          } else if (event === 'end') {
            resolve(
              Response.json(
                { message, sources },
                { status: 200, headers: rateLimit.headers },
              ),
            );
          } else if (event === 'error') {
            resolve(
              Response.json(
                { message: 'Search error', error: data },
                { status: 500, headers: rateLimit.headers },
              ),
            );
          }
        });
      });
    }

    const encoder = new TextEncoder();
    const abortController = new AbortController();
    const { signal } = abortController;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              type: 'init',
              data: 'Stream connected',
            }) + '\n',
          ),
        );

        signal.addEventListener('abort', () => {
          session.removeAllListeners();

          try {
            controller.close();
          } catch {}
        });

        session.subscribe((event, data) => {
          if (event === 'data') {
            if (signal.aborted) {
              return;
            }

            try {
              if (data.type === 'response') {
                controller.enqueue(
                  encoder.encode(
                    JSON.stringify({
                      type: 'response',
                      data: data.data,
                    }) + '\n',
                  ),
                );
              } else if (data.type === 'searchResults') {
                controller.enqueue(
                  encoder.encode(
                    JSON.stringify({
                      type: 'sources',
                      data: data.data,
                    }) + '\n',
                  ),
                );
              }
            } catch (error) {
              controller.error(error);
            }
          } else if (event === 'end') {
            if (signal.aborted) {
              return;
            }

            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  type: 'done',
                }) + '\n',
              ),
            );
            controller.close();
          } else if (event === 'error') {
            if (signal.aborted) {
              return;
            }

            controller.error(data);
          }
        });
      },
      cancel() {
        abortController.abort();
      },
    });

    return new Response(stream, {
      headers: {
        ...rateLimit.headers,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Error in getting search results:', error);
    return Response.json(
      { message: 'An error has occurred.' },
      { status: 500 },
    );
  }
};
