import fs from 'node:fs/promises';
import OpenAI from 'openai';
import BaseLLM from '../../base/llm';
import { zodTextFormat, zodResponseFormat } from 'openai/helpers/zod';
import {
  GenerateObjectInput,
  GenerateOptions,
  GenerateTextInput,
  GenerateTextOutput,
  GenerateVisionTextInput,
  StreamTextOutput,
  ToolCall,
} from '../../types';
import { parse } from 'partial-json';
import z from 'zod';
import {
  ChatCompletionAssistantMessageParam,
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionSystemMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
  ChatCompletionUserMessageParam,
} from 'openai/resources/index.mjs';
import { Message } from '@/lib/types';
import { repairJson } from '@toolsycc/json-repair';
import { getImageMimeType, isVisionModelKey } from '../../vision';
import { getTokenCount, truncateToTokenBudget } from '@/lib/utils/tokenCount';
import { Stream } from 'openai/streaming';

type OpenAIConfig = {
  apiKey: string;
  model: string;
  baseURL?: string;
  options?: GenerateOptions;
};

class OpenAILLM extends BaseLLM<OpenAIConfig> {
  openAIClient: OpenAI;

  constructor(protected config: OpenAIConfig) {
    super(config);

    this.openAIClient = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL || 'https://api.openai.com/v1',
    });
  }

  convertToOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: msg.id,
          content: msg.content,
        } as ChatCompletionToolMessageParam;
      } else if (msg.role === 'assistant') {
        return {
          role: 'assistant',
          content: msg.content,
          ...(msg.tool_calls &&
            msg.tool_calls.length > 0 && {
              tool_calls: msg.tool_calls?.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments),
                },
              })),
            }),
        } as ChatCompletionAssistantMessageParam;
      }

      return msg;
    });
  }

  supportsVision() {
    return isVisionModelKey(this.config.model);
  }

  private compactMessageContent(
    message: Message,
    aggressive: boolean,
  ): Message {
    const roleBudget = aggressive
      ? {
          system: 700,
          user: 900,
          assistant: 500,
          tool: 350,
        }
      : {
          system: 1200,
          user: 1800,
          assistant: 900,
          tool: 600,
        };

    const budget = roleBudget[message.role];
    const compactContent = truncateToTokenBudget(message.content, budget);

    return {
      ...message,
      content: compactContent,
    };
  }

  private compactMessages(messages: Message[], aggressive = false): Message[] {
    const compacted = messages.map((message) =>
      this.compactMessageContent(message, aggressive),
    );
    const totalBudget = aggressive ? 3200 : 5200;
    let totalTokens = compacted.reduce(
      (sum, message) => sum + getTokenCount(message.content),
      0,
    );

    if (totalTokens <= totalBudget) {
      return compacted;
    }

    const systemMessages = compacted.filter((message) => message.role === 'system');
    const remaining = compacted.filter((message) => message.role !== 'system');
    const kept: Message[] = [];

    for (let i = remaining.length - 1; i >= 0; i--) {
      const candidate = remaining[i];
      const candidateTokens = getTokenCount(candidate.content);
      const nextTotal =
        systemMessages.reduce(
          (sum, message) => sum + getTokenCount(message.content),
          0,
        ) +
        kept.reduce((sum, message) => sum + getTokenCount(message.content), 0) +
        candidateTokens;

      if (nextTotal > totalBudget && kept.length > 0) {
        continue;
      }

      kept.unshift(candidate);
    }

    return [...systemMessages, ...kept];
  }

  private async createChatCompletion(
    input: GenerateTextInput,
    openaiTools: ChatCompletionTool[],
  ): Promise<ChatCompletion> {
    const buildRequest = (messages: Message[]) => ({
      model: this.config.model,
      messages: this.convertToOpenAIMessages(messages),
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_completion_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
    });

    try {
      return await this.openAIClient.chat.completions.create(
        buildRequest(this.compactMessages(input.messages, false)),
      );
    } catch (error: any) {
      if (error?.status !== 413) {
        throw error;
      }

      return await this.openAIClient.chat.completions.create(
        buildRequest(this.compactMessages(input.messages, true)),
      );
    }
  }

  private async createChatCompletionStream(
    input: GenerateTextInput,
    openaiTools: ChatCompletionTool[],
  ): Promise<Stream<ChatCompletionChunk>> {
    const buildRequest = (messages: Message[]) => ({
      model: this.config.model,
      messages: this.convertToOpenAIMessages(messages),
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_completion_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
      stream: true as const,
    });

    try {
      return await this.openAIClient.chat.completions.create(
        buildRequest(this.compactMessages(input.messages, false)),
      );
    } catch (error: any) {
      if (error?.status !== 413) {
        throw error;
      }

      return await this.openAIClient.chat.completions.create(
        buildRequest(this.compactMessages(input.messages, true)),
      );
    }
  }

  private async convertVisionMessages(
    messages: GenerateVisionTextInput['messages'],
  ): Promise<ChatCompletionMessageParam[]> {
    return Promise.all(
      messages.map(async (message) => {
        const content = await Promise.all(
          message.content.map(async (part) => {
            if (part.type === 'text') {
              return {
                type: 'text' as const,
                text: part.text,
              };
            }

            const mimeType = part.mimeType || getImageMimeType(part.imagePath);
            const encodedImage = await fs.readFile(part.imagePath, 'base64');

            return {
              type: 'image_url' as const,
              image_url: {
                url: `data:${mimeType};base64,${encodedImage}`,
              },
            };
          }),
        );

        if (message.role === 'system') {
          return {
            role: 'system',
            content: content
              .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
              .map((part) => part.text)
              .join('\n\n'),
          } as ChatCompletionSystemMessageParam;
        }

        if (message.role === 'assistant') {
          return {
            role: 'assistant',
            content: content
              .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
              .map((part) => part.text)
              .join('\n\n'),
          } as ChatCompletionAssistantMessageParam;
        }

        return {
          role: 'user',
          content,
        } as ChatCompletionUserMessageParam;
      }),
    );
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const openaiTools: ChatCompletionTool[] = [];

    input.tools?.forEach((tool) => {
      openaiTools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.schema),
        },
      });
    });

    const response = await this.createChatCompletion(input, openaiTools);

    if (response.choices && response.choices.length > 0) {
      return {
        content: response.choices[0].message.content!,
        toolCalls:
          response.choices[0].message.tool_calls
            ?.map((tc: any) => {
              if (tc.type === 'function') {
                return {
                  name: tc.function.name,
                  id: tc.id,
                  arguments: JSON.parse(tc.function.arguments),
                };
              }
            })
            .filter(
              (
                tc: {
                  name: string;
                  id: string;
                  arguments: Record<string, any>;
                } | undefined,
              ): tc is {
                name: string;
                id: string;
                arguments: Record<string, any>;
              } => tc !== undefined,
            ) || [],
        additionalInfo: {
          finishReason: response.choices[0].finish_reason,
        },
      };
    }

    throw new Error('No response from OpenAI');
  }

  async *streamText(
    input: GenerateTextInput,
  ): AsyncGenerator<StreamTextOutput> {
    const openaiTools: ChatCompletionTool[] = [];

    input.tools?.forEach((tool) => {
      openaiTools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.schema),
        },
      });
    });

    const stream = await this.createChatCompletionStream(input, openaiTools);

    let recievedToolCalls: { name: string; id: string; arguments: string }[] =
      [];

    for await (const chunk of stream) {
      if (chunk.choices && chunk.choices.length > 0) {
        const toolCalls = chunk.choices[0].delta.tool_calls;
        yield {
          contentChunk: chunk.choices[0].delta.content || '',
          toolCallChunk:
            toolCalls?.map((tc: any) => {
              if (!recievedToolCalls[tc.index]) {
                const call = {
                  name: tc.function?.name!,
                  id: tc.id!,
                  arguments: tc.function?.arguments || '',
                };
                recievedToolCalls.push(call);
                return { ...call, arguments: parse(call.arguments || '{}') };
              } else {
                const existingCall = recievedToolCalls[tc.index];
                existingCall.arguments += tc.function?.arguments || '';
                return {
                  ...existingCall,
                  arguments: parse(existingCall.arguments),
                };
              }
            }).filter(
              (
                tc: {
                  name: string;
                  id: string;
                  arguments: Record<string, any>;
                } | undefined,
              ): tc is {
                name: string;
                id: string;
                arguments: Record<string, any>;
              } => tc !== undefined,
            ) || [],
          done: chunk.choices[0].finish_reason !== null,
          additionalInfo: {
            finishReason: chunk.choices[0].finish_reason,
          },
        };
      }
    }
  }

  async generateVisionText(
    input: GenerateVisionTextInput,
  ): Promise<GenerateTextOutput> {
    if (!this.supportsVision()) {
      throw new Error(`Model "${this.config.model}" does not support vision`);
    }

    const response = await this.openAIClient.chat.completions.create({
      model: this.config.model,
      messages: await this.convertVisionMessages(input.messages),
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_completion_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
    });

    if (response.choices && response.choices.length > 0) {
      return {
        content: response.choices[0].message.content || '',
        toolCalls: [],
        additionalInfo: {
          finishReason: response.choices[0].finish_reason,
        },
      };
    }

    throw new Error('No response from OpenAI');
  }

  async generateObject<T>(input: GenerateObjectInput): Promise<T> {
    const response = await this.openAIClient.chat.completions.parse({
      messages: this.convertToOpenAIMessages(input.messages),
      model: this.config.model,
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_completion_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
      response_format: zodResponseFormat(input.schema, 'object'),
    });

    if (response.choices && response.choices.length > 0) {
      try {
        return input.schema.parse(
          JSON.parse(
            repairJson(response.choices[0].message.content!, {
              extractJson: true,
            }) as string,
          ),
        ) as T;
      } catch (err) {
        throw new Error(`Error parsing response from OpenAI: ${err}`);
      }
    }

    throw new Error('No response from OpenAI');
  }

  async *streamObject<T>(input: GenerateObjectInput): AsyncGenerator<T> {
    let recievedObj: string = '';

    const stream = this.openAIClient.responses.stream({
      model: this.config.model,
      input: input.messages,
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_completion_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
      text: {
        format: zodTextFormat(input.schema, 'object'),
      },
    });

    for await (const chunk of stream) {
      if (chunk.type === 'response.output_text.delta' && chunk.delta) {
        recievedObj += chunk.delta;

        try {
          yield parse(recievedObj) as T;
        } catch (err) {
          console.log('Error parsing partial object from OpenAI:', err);
          yield {} as T;
        }
      } else if (chunk.type === 'response.output_text.done' && chunk.text) {
        try {
          yield parse(chunk.text) as T;
        } catch (err) {
          throw new Error(`Error parsing response from OpenAI: ${err}`);
        }
      }
    }
  }
}

export default OpenAILLM;
