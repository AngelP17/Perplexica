'use client';

import { Message } from '@/components/ChatWindow';
import { Block } from '@/lib/types';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import crypto from 'crypto';
import { useParams, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { getSuggestions } from '../actions';
import { MinimalProvider } from '../models/types';
import { getAutoMediaSearch } from '../config/clientRegistry';
import { applyPatch } from 'rfc6902';
import { Widget } from '@/components/ChatWindow';
import {
  COMPUTER_PERSONA_STORAGE_KEY,
  isComputerPersonaId,
} from '@/lib/agents/computer/personas/catalog';
import type { ComputerPersonaId } from '@/lib/agents/computer/personas/types';

export type Section = {
  message: Message;
  widgets: Widget[];
  parsedTextBlocks: string[];
  speechMessage: string;
  thinkingEnded: boolean;
  suggestions?: string[];
};

type ChatContext = {
  messages: Message[];
  sections: Section[];
  chatHistory: [string, string][];
  files: File[];
  fileIds: string[];
  sources: string[];
  chatId: string | undefined;
  optimizationMode: string;
  interactionMode: 'search' | 'computer';
  swarmEnabled: boolean;
  selectedPersonaId: ComputerPersonaId | null;
  isMessagesLoaded: boolean;
  loading: boolean;
  notFound: boolean;
  messageAppeared: boolean;
  isReady: boolean;
  hasError: boolean;
  chatModelProvider: ChatModelProvider;
  embeddingModelProvider: EmbeddingModelProvider;
  researchEnded: boolean;
  setResearchEnded: (ended: boolean) => void;
  setOptimizationMode: (mode: string) => void;
  setInteractionMode: (mode: 'search' | 'computer') => void;
  setSwarmEnabled: (enabled: boolean) => void;
  setSelectedPersonaId: (personaId: ComputerPersonaId | null) => void;
  setSources: (sources: string[]) => void;
  setFiles: (files: File[]) => void;
  setFileIds: (fileIds: string[]) => void;
  sendMessage: (
    message: string,
    messageId?: string,
    rewrite?: boolean,
  ) => Promise<void>;
  rewrite: (messageId: string) => void;
  setChatModelProvider: (provider: ChatModelProvider) => void;
  setEmbeddingModelProvider: (provider: EmbeddingModelProvider) => void;
};

export interface File {
  fileName: string;
  fileExtension: string;
  fileId: string;
}

interface ChatModelProvider {
  key: string;
  providerId: string;
}

interface EmbeddingModelProvider {
  key: string;
  providerId: string;
}

const checkConfig = async (
  setChatModelProvider: (provider: ChatModelProvider) => void,
  setEmbeddingModelProvider: (provider: EmbeddingModelProvider) => void,
  setIsConfigReady: (ready: boolean) => void,
  setHasError: (hasError: boolean) => void,
) => {
  try {
    let chatModelKey = localStorage.getItem('chatModelKey');
    let chatModelProviderId = localStorage.getItem('chatModelProviderId');
    let embeddingModelKey = localStorage.getItem('embeddingModelKey');
    let embeddingModelProviderId = localStorage.getItem(
      'embeddingModelProviderId',
    );

    const res = await fetch(`/api/providers`, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(
        `Provider fetching failed with status code ${res.status}`,
      );
    }

    const data = await res.json();
    const providers: MinimalProvider[] = data.providers;

    if (providers.length === 0) {
      throw new Error(
        'No chat model providers found, please configure them in the settings page.',
      );
    }

    const chatModelProvider =
      providers.find((p) => p.id === chatModelProviderId) ??
      providers.find((p) => p.chatModels.length > 0);

    if (!chatModelProvider) {
      throw new Error(
        'No chat models found, pleae configure them in the settings page.',
      );
    }

    chatModelProviderId = chatModelProvider.id;

    const chatModel =
      chatModelProvider.chatModels.find((m) => m.key === chatModelKey) ??
      chatModelProvider.chatModels[0];
    chatModelKey = chatModel.key;

    const embeddingModelProvider =
      providers.find((p) => p.id === embeddingModelProviderId) ??
      providers.find((p) => p.embeddingModels.length > 0);

    if (!embeddingModelProvider) {
      throw new Error(
        'No embedding models found, pleae configure them in the settings page.',
      );
    }

    embeddingModelProviderId = embeddingModelProvider.id;

    const embeddingModel =
      embeddingModelProvider.embeddingModels.find(
        (m) => m.key === embeddingModelKey,
      ) ?? embeddingModelProvider.embeddingModels[0];
    embeddingModelKey = embeddingModel.key;

    localStorage.setItem('chatModelKey', chatModelKey);
    localStorage.setItem('chatModelProviderId', chatModelProviderId);
    localStorage.setItem('embeddingModelKey', embeddingModelKey);
    localStorage.setItem('embeddingModelProviderId', embeddingModelProviderId);

    setChatModelProvider({
      key: chatModelKey,
      providerId: chatModelProviderId,
    });

    setEmbeddingModelProvider({
      key: embeddingModelKey,
      providerId: embeddingModelProviderId,
    });

    setIsConfigReady(true);
  } catch (err: any) {
    console.error('An error occurred while checking the configuration:', err);
    toast.error(err.message);
    setIsConfigReady(false);
    setHasError(true);
  }
};

const loadMessages = async (
  chatId: string,
  setMessages: (messages: Message[]) => void,
  setIsMessagesLoaded: (loaded: boolean) => void,
  chatHistory: React.MutableRefObject<[string, string][]>,
  setSources: (sources: string[]) => void,
  setNotFound: (notFound: boolean) => void,
  setFiles: (files: File[]) => void,
  setFileIds: (fileIds: string[]) => void,
) => {
  const res = await fetch(`/api/chats/${chatId}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (res.status === 404) {
    setNotFound(true);
    setIsMessagesLoaded(true);
    return;
  }

  const data = await res.json();

  const messages = data.messages as Message[];

  setMessages(messages);

  const history: [string, string][] = [];
  messages.forEach((msg) => {
    history.push(['human', msg.query]);

    const textBlocks = msg.responseBlocks
      .filter(
        (block): block is Block & { type: 'text' } => block.type === 'text',
      )
      .map((block) => block.data)
      .join('\n');

    if (textBlocks) {
      history.push(['assistant', textBlocks]);
    }
  });

  console.debug(new Date(), 'app:messages_loaded');

  if (messages.length > 0) {
    document.title = messages[0].query;
  }

  const files = data.chat.files.map((file: any) => {
    return {
      fileName: file.name,
      fileExtension: file.name.split('.').pop(),
      fileId: file.fileId,
    };
  });

  setFiles(files);
  setFileIds(files.map((file: File) => file.fileId));

  chatHistory.current = history;
  setSources(data.chat.sources);
  setIsMessagesLoaded(true);
};

const parseNdjsonStream = async (
  stream: ReadableStream<Uint8Array>,
  onMessage: (data: any) => void | Promise<void>,
) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffered = '';

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffered += decoder.decode(value, { stream: true });

    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed) {
        continue;
      }

      await onMessage(JSON.parse(trimmed));
    }
  }

  const trailing = buffered.trim();

  if (trailing) {
    await onMessage(JSON.parse(trailing));
  }
};

export const chatContext = createContext<ChatContext>({
  chatHistory: [],
  chatId: '',
  fileIds: [],
  files: [],
  sources: [],
  hasError: false,
  interactionMode: 'search',
  isMessagesLoaded: false,
  isReady: false,
  loading: false,
  messageAppeared: false,
  messages: [],
  sections: [],
  notFound: false,
  optimizationMode: '',
  swarmEnabled: false,
  selectedPersonaId: null,
  chatModelProvider: { key: '', providerId: '' },
  embeddingModelProvider: { key: '', providerId: '' },
  researchEnded: false,
  rewrite: () => {},
  sendMessage: async () => {},
  setFileIds: () => {},
  setFiles: () => {},
  setSources: () => {},
  setOptimizationMode: () => {},
  setInteractionMode: () => {},
  setSwarmEnabled: () => {},
  setSelectedPersonaId: () => {},
  setChatModelProvider: () => {},
  setEmbeddingModelProvider: () => {},
  setResearchEnded: () => {},
});

export const ChatProvider = ({ children }: { children: React.ReactNode }) => {
  const params: { chatId: string } = useParams();

  const searchParams = useSearchParams();
  const initialMessage = searchParams.get('q');

  const [chatId, setChatId] = useState<string | undefined>(params.chatId);
  const [newChatCreated, setNewChatCreated] = useState(false);

  const [loading, setLoading] = useState(false);
  const [messageAppeared, setMessageAppeared] = useState(false);

  const [researchEnded, setResearchEnded] = useState(false);

  const chatHistory = useRef<[string, string][]>([]);
  const [messages, setMessages] = useState<Message[]>([]);

  const [files, setFiles] = useState<File[]>([]);
  const [fileIds, setFileIds] = useState<string[]>([]);

  const [sources, setSources] = useState<string[]>(['web']);
  const [optimizationMode, setOptimizationMode] = useState('speed');
  const [interactionMode, setInteractionMode] = useState<'search' | 'computer'>(
    'search',
  );
  const [swarmEnabled, setSwarmEnabled] = useState(false);
  const [selectedPersonaId, setSelectedPersonaId] =
    useState<ComputerPersonaId | null>(null);
  const interactionModeRef = useRef<'search' | 'computer'>('search');
  const swarmEnabledRef = useRef(false);
  const selectedPersonaIdRef = useRef<ComputerPersonaId | null>(null);

  const [isMessagesLoaded, setIsMessagesLoaded] = useState(false);

  const [notFound, setNotFound] = useState(false);

  const [chatModelProvider, setChatModelProvider] = useState<ChatModelProvider>(
    {
      key: '',
      providerId: '',
    },
  );

  const [embeddingModelProvider, setEmbeddingModelProvider] =
    useState<EmbeddingModelProvider>({
      key: '',
      providerId: '',
    });

  const [isConfigReady, setIsConfigReady] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isReady, setIsReady] = useState(false);

  const messagesRef = useRef<Message[]>([]);

  const sections = useMemo<Section[]>(() => {
    return messages.map((msg) => {
      const textBlocks: string[] = [];
      let speechMessage = '';
      let thinkingEnded = false;
      let suggestions: string[] = [];

      const sourceBlocks = msg.responseBlocks.filter(
        (block): block is Block & { type: 'source' } => block.type === 'source',
      );
      const sources = sourceBlocks.flatMap((block) => block.data);

      const widgetBlocks = msg.responseBlocks
        .filter((b) => b.type === 'widget')
        .map((b) => b.data) as Widget[];

      msg.responseBlocks.forEach((block) => {
        if (block.type === 'text') {
          let processedText = block.data;
          const citationRegex = /\[([^\]]+)\]/g;
          const speechCitationRegex = /\[(\d+[~?!]?)(?:\s*,\s*\d+[~?!]?)*\]/g;

          if (processedText.includes('<think>')) {
            const openThinkTag = processedText.match(/<think>/g)?.length || 0;
            const closeThinkTag =
              processedText.match(/<\/think>/g)?.length || 0;

            if (openThinkTag && !closeThinkTag) {
              processedText += '</think> <a> </a>';
            }
          }

          if (block.data.includes('</think>')) {
            thinkingEnded = true;
          }

          if (sources.length > 0) {
            processedText = processedText.replace(
              citationRegex,
              (_, capturedContent: string) => {
                const numbers = capturedContent
                  .split(',')
                  .map((numStr) => numStr.trim());

                const linksHtml = numbers
                  .map((numStr) => {
                    const number = parseInt(numStr);

                    if (isNaN(number) || number <= 0) {
                      return `[${numStr}]`;
                    }

                    const source = sources[number - 1];
                    const url = source?.metadata?.url;

                    if (url) {
                      return `<citation href="${url}">${numStr}</citation>`;
                    } else {
                      return ``;
                    }
                  })
                  .join('');

                return linksHtml;
              },
            );
            speechMessage += block.data.replace(speechCitationRegex, '');
          } else {
            processedText = processedText.replace(speechCitationRegex, '');
            speechMessage += block.data.replace(speechCitationRegex, '');
          }

          textBlocks.push(processedText);
        } else if (block.type === 'suggestion') {
          suggestions = block.data;
        }
      });

      return {
        message: msg,
        parsedTextBlocks: textBlocks,
        speechMessage,
        thinkingEnded,
        suggestions,
        widgets: widgetBlocks,
      };
    });
  }, [messages]);

  const isReconnectingRef = useRef(false);
  const handledMessageEndRef = useRef<Set<string>>(new Set());

  const checkReconnect = useCallback(async () => {
    if (isReconnectingRef.current) return;

    setIsReady(true);
    console.debug(new Date(), 'app:ready');

    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];

      if (lastMsg.status === 'answering') {
        setLoading(true);
        setResearchEnded(false);
        setMessageAppeared(false);

        isReconnectingRef.current = true;

        const res = await fetch(`/api/reconnect/${lastMsg.backendId}`, {
          method: 'POST',
        });

        const contentType = res.headers.get('content-type') || '';

        if (contentType.includes('application/json')) {
          let errorMessage =
            'The previous response could not be resumed. Please retry it.';
          let expired = false;

          try {
            const data = await res.json();
            if (typeof data.message === 'string' && data.message.trim()) {
              errorMessage = data.message;
            }
            expired = Boolean(data.expired);
          } catch {}

          if (!expired) {
            toast.error(errorMessage);
          }

          setLoading(false);
          setResearchEnded(true);
          setMessages((prev) =>
            prev.map((msg) =>
              msg.messageId === lastMsg.messageId
                ? { ...msg, status: 'error' as const }
                : msg,
            ),
          );
          isReconnectingRef.current = false;
          return;
        }

        if (!res.ok) {
          let errorMessage =
            'The previous response could not be resumed. Please retry it.';

          try {
            const data = await res.json();
            if (typeof data.message === 'string' && data.message.trim()) {
              errorMessage = data.message;
            }
          } catch {}

          toast.error(errorMessage);
          setLoading(false);
          setResearchEnded(true);
          setMessages((prev) =>
            prev.map((msg) =>
              msg.messageId === lastMsg.messageId
                ? { ...msg, status: 'error' as const }
                : msg,
            ),
          );
          isReconnectingRef.current = false;
          return;
        }

        if (!res.body) throw new Error('No response body');

        const messageHandler = getMessageHandler(lastMsg);

        try {
          await parseNdjsonStream(res.body, messageHandler);
        } finally {
          isReconnectingRef.current = false;
        }
      }
    }
  }, [messages]);

  useEffect(() => {
    checkConfig(
      setChatModelProvider,
      setEmbeddingModelProvider,
      setIsConfigReady,
      setHasError,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const savedMode = localStorage.getItem('interactionMode');
    const savedSwarm = localStorage.getItem('swarmEnabled');
    const savedPersonaId = localStorage.getItem(COMPUTER_PERSONA_STORAGE_KEY);

    if (savedMode === 'search' || savedMode === 'computer') {
      interactionModeRef.current = savedMode;
      setInteractionMode(savedMode);
    }

    if (savedSwarm === 'true' || savedSwarm === 'false') {
      const isEnabled = savedSwarm === 'true';
      swarmEnabledRef.current = isEnabled;
      setSwarmEnabled(isEnabled);
    }

    if (savedPersonaId && isComputerPersonaId(savedPersonaId)) {
      selectedPersonaIdRef.current = savedPersonaId;
      setSelectedPersonaId(savedPersonaId);
    } else if (savedPersonaId) {
      localStorage.removeItem(COMPUTER_PERSONA_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (params.chatId && params.chatId !== chatId) {
      setChatId(params.chatId);
      setMessages([]);
      chatHistory.current = [];
      setFiles([]);
      setFileIds([]);
      setIsMessagesLoaded(false);
      setNotFound(false);
      setNewChatCreated(false);
    }
  }, [params.chatId, chatId]);

  useEffect(() => {
    if (
      chatId &&
      !newChatCreated &&
      !isMessagesLoaded &&
      messages.length === 0
    ) {
      loadMessages(
        chatId,
        setMessages,
        setIsMessagesLoaded,
        chatHistory,
        setSources,
        setNotFound,
        setFiles,
        setFileIds,
      );
    } else if (!chatId) {
      setNewChatCreated(true);
      setIsMessagesLoaded(true);
      setChatId(crypto.randomBytes(20).toString('hex'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, isMessagesLoaded, newChatCreated, messages.length]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (isMessagesLoaded && isConfigReady && newChatCreated) {
      setIsReady(true);
      console.debug(new Date(), 'app:ready');
    } else if (isMessagesLoaded && isConfigReady && !newChatCreated) {
      checkReconnect();
    } else {
      setIsReady(false);
    }
  }, [checkReconnect, isConfigReady, isMessagesLoaded, newChatCreated]);

  const rewrite = (messageId: string) => {
    const index = messages.findIndex((msg) => msg.messageId === messageId);

    if (index === -1) return;

    setMessages((prev) => prev.slice(0, index));

    chatHistory.current = chatHistory.current.slice(0, index * 2);

    const messageToRewrite = messages[index];
    sendMessage(messageToRewrite.query, messageToRewrite.messageId, true);
  };

  const handleSetInteractionMode: ChatContext['setInteractionMode'] = (
    mode,
  ) => {
    interactionModeRef.current = mode;
    setInteractionMode(mode);
    localStorage.setItem('interactionMode', mode);
  };

  const handleSetSwarmEnabled: ChatContext['setSwarmEnabled'] = (enabled) => {
    swarmEnabledRef.current = enabled;
    setSwarmEnabled(enabled);
    localStorage.setItem('swarmEnabled', String(enabled));
  };

  const handleSetSelectedPersonaId: ChatContext['setSelectedPersonaId'] = (
    personaId,
  ) => {
    selectedPersonaIdRef.current = personaId;
    setSelectedPersonaId(personaId);

    if (personaId) {
      localStorage.setItem(COMPUTER_PERSONA_STORAGE_KEY, personaId);
      return;
    }

    localStorage.removeItem(COMPUTER_PERSONA_STORAGE_KEY);
  };

  useEffect(() => {
    if (isReady && initialMessage && isConfigReady) {
      if (!isConfigReady) {
        toast.error('Cannot send message before the configuration is ready');
        return;
      }
      sendMessage(initialMessage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfigReady, isReady, initialMessage]);

  const getMessageHandler = (message: Message) => {
    const messageId = message.messageId;

    return async (data: any) => {
      if (data.type === 'error') {
        toast.error(data.data);
        setLoading(false);
        setResearchEnded(true);
        setMessages((prev) =>
          prev.map((msg) =>
            msg.messageId === messageId
              ? { ...msg, status: 'error' as const }
              : msg,
          ),
        );
        return;
      }

      if (data.type === 'researchComplete') {
        setResearchEnded(true);
        if (
          message.responseBlocks.find(
            (b) => b.type === 'source' && b.data.length > 0,
          )
        ) {
          setMessageAppeared(true);
        }
      }

      if (data.type === 'block') {
        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.messageId === messageId) {
              const exists = msg.responseBlocks.findIndex(
                (b) => b.id === data.block.id,
              );

              if (exists !== -1) {
                const existingBlocks = [...msg.responseBlocks];
                existingBlocks[exists] = data.block;

                return {
                  ...msg,
                  responseBlocks: existingBlocks,
                };
              }

              return {
                ...msg,
                responseBlocks: [...msg.responseBlocks, data.block],
              };
            }
            return msg;
          }),
        );

        if (data.block.type !== 'suggestion') {
          setMessageAppeared(true);
        }
      }

      if (data.type === 'updateBlock') {
        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.messageId === messageId) {
              const updatedBlocks = msg.responseBlocks.map((block) => {
                if (block.id === data.blockId) {
                  const updatedBlock = { ...block };
                  applyPatch(updatedBlock, data.patch);
                  return updatedBlock;
                }
                return block;
              });
              return { ...msg, responseBlocks: updatedBlocks };
            }
            return msg;
          }),
        );
        setMessageAppeared(true);
      }

      if (data.type === 'messageEnd') {
        if (handledMessageEndRef.current.has(messageId)) {
          return;
        }

        handledMessageEndRef.current.add(messageId);
        setResearchEnded(true);

        const currentMsg = messagesRef.current.find(
          (msg) => msg.messageId === messageId,
        );

        const newHistory: [string, string][] = [
          ...chatHistory.current,
          ['human', message.query],
          [
            'assistant',
            currentMsg?.responseBlocks.find((b) => b.type === 'text')?.data ||
              '',
          ],
        ];

        chatHistory.current = newHistory;

        setMessages((prev) =>
          prev.map((msg) =>
            msg.messageId === messageId
              ? { ...msg, status: 'completed' as const }
              : msg,
          ),
        );

        setLoading(false);

        const lastMsg = messagesRef.current[messagesRef.current.length - 1];

        const autoMediaSearch = getAutoMediaSearch();

        if (autoMediaSearch) {
          setTimeout(() => {
            document
              .getElementById(`search-images-${lastMsg.messageId}`)
              ?.click();

            document
              .getElementById(`search-videos-${lastMsg.messageId}`)
              ?.click();
          }, 200);
        }

        // Check if there are sources and no suggestions

        const hasSourceBlocks = currentMsg?.responseBlocks.some(
          (block) => block.type === 'source' && block.data.length > 0,
        );
        const hasSuggestions = currentMsg?.responseBlocks.some(
          (block) => block.type === 'suggestion',
        );

        if (hasSourceBlocks && !hasSuggestions) {
          const suggestions = await getSuggestions(newHistory);
          const suggestionBlock: Block = {
            id: crypto.randomBytes(7).toString('hex'),
            type: 'suggestion',
            data: suggestions,
          };

          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.messageId === messageId) {
                return {
                  ...msg,
                  responseBlocks: [...msg.responseBlocks, suggestionBlock],
                };
              }
              return msg;
            }),
          );
        }
      }
    };
  };

  const sendMessage: ChatContext['sendMessage'] = async (
    message,
    messageId,
    rewrite = false,
  ) => {
    const trimmedMessage = message.trim();

    if (loading || !trimmedMessage) return;

    setLoading(true);
    setResearchEnded(false);
    setMessageAppeared(false);

    if (messages.length <= 1) {
      window.history.replaceState(null, '', `/c/${chatId}`);
    }

    messageId = messageId ?? crypto.randomBytes(7).toString('hex');
    handledMessageEndRef.current.delete(messageId);
    const backendId = crypto.randomBytes(20).toString('hex');
    const currentInteractionMode = interactionModeRef.current;
    const currentSwarmEnabled = swarmEnabledRef.current;
    const currentSelectedPersonaId = selectedPersonaIdRef.current;

    const newMessage: Message = {
      messageId,
      chatId: chatId!,
      backendId,
      query: trimmedMessage,
      responseBlocks: [],
      status: 'answering',
      createdAt: new Date(),
    };

    setMessages((prevMessages) => [...prevMessages, newMessage]);

    const messageIndex = messages.findIndex((m) => m.messageId === messageId);
    const endpoint =
      currentInteractionMode === 'computer' ? '/api/computer' : '/api/chat';

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: trimmedMessage,
          message: {
            messageId: messageId,
            chatId: chatId!,
            content: trimmedMessage,
          },
          chatId: chatId!,
          optimizationMode: optimizationMode,
          history: rewrite
            ? chatHistory.current.slice(
                0,
                messageIndex === -1 ? undefined : messageIndex * 2,
              )
            : chatHistory.current,
          chatModel: {
            key: chatModelProvider.key,
            providerId: chatModelProvider.providerId,
          },
          systemInstructions: localStorage.getItem('systemInstructions'),
          ...(currentInteractionMode === 'search'
            ? {
                files: fileIds,
                sources: sources,
                embeddingModel: {
                  key: embeddingModelProvider.key,
                  providerId: embeddingModelProvider.providerId,
                },
              }
            : {
                swarmEnabled: currentSwarmEnabled,
                specialistPersonaId: currentSelectedPersonaId,
              }),
        }),
      });

      if (!res.ok) {
        const errorPayload = await res
          .json()
          .catch(() => ({ message: 'Request failed' }));
        throw new Error(errorPayload.message || 'Request failed');
      }

      if (!res.body) {
        throw new Error('No response body');
      }

      const messageHandler = getMessageHandler(newMessage);
      await parseNdjsonStream(res.body, messageHandler);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to send message';

      toast.error(errorMessage);
      setLoading(false);
      setResearchEnded(true);
      setMessages((prev) =>
        prev.map((msg) =>
          msg.messageId === messageId
            ? { ...msg, status: 'error' as const }
            : msg,
        ),
      );
    }
  };

  return (
    <chatContext.Provider
      value={{
        messages,
        sections,
        chatHistory: chatHistory.current,
        files,
        fileIds,
        sources,
        chatId,
        hasError,
        interactionMode,
        isMessagesLoaded,
        isReady,
        loading,
        messageAppeared,
        notFound,
        optimizationMode,
        swarmEnabled,
        selectedPersonaId,
        setFileIds,
        setFiles,
        setSources,
        setOptimizationMode,
        setInteractionMode: handleSetInteractionMode,
        setSwarmEnabled: handleSetSwarmEnabled,
        setSelectedPersonaId: handleSetSelectedPersonaId,
        rewrite,
        sendMessage,
        setChatModelProvider,
        chatModelProvider,
        embeddingModelProvider,
        setEmbeddingModelProvider,
        researchEnded,
        setResearchEnded,
      }}
    >
      {children}
    </chatContext.Provider>
  );
};

export const useChat = () => {
  const ctx = useContext(chatContext);
  return ctx;
};
