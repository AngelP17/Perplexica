import configManager from '@/lib/config';
import ModelRegistry from './registry';
import BaseLLM from './base/llm';
import { ModelWithProvider } from './types';

export type RoutedModelSelection = {
  llm: BaseLLM<any>;
  providerId: string;
  modelKey: string;
  routed: boolean;
};

type RoutingConfig = {
  speedChatModelKey?: string;
  balancedChatModelKey?: string;
  qualityChatModelKey?: string;
  computerCoderModelKey?: string;
  computerVisionModelKey?: string;
};

const getRoutingConfig = (): RoutingConfig =>
  configManager.getConfig('preferences.modelRouting', {});

const getModeSpecificModelKey = (
  mode: 'speed' | 'balanced' | 'quality',
): string | undefined => {
  const routing = getRoutingConfig();

  if (mode === 'speed') {
    return routing.speedChatModelKey?.trim();
  }

  if (mode === 'balanced') {
    return routing.balancedChatModelKey?.trim();
  }

  return routing.qualityChatModelKey?.trim();
};

export const getPreferredCoderModelKey = () => {
  const routing = getRoutingConfig();
  return routing.computerCoderModelKey?.trim() || undefined;
};

export const getPreferredVisionModelKey = () => {
  const routing = getRoutingConfig();
  return routing.computerVisionModelKey?.trim() || undefined;
};

export const loadRoutedChatModel = async (
  registry: ModelRegistry,
  requestedModel: ModelWithProvider,
  mode: 'speed' | 'balanced' | 'quality',
): Promise<RoutedModelSelection> => {
  const routedModelKey = getModeSpecificModelKey(mode);

  if (!routedModelKey || routedModelKey === requestedModel.key) {
    return {
      llm: await registry.loadChatModel(
        requestedModel.providerId,
        requestedModel.key,
      ),
      providerId: requestedModel.providerId,
      modelKey: requestedModel.key,
      routed: false,
    };
  }

  try {
    return {
      llm: await registry.loadChatModel(requestedModel.providerId, routedModelKey),
      providerId: requestedModel.providerId,
      modelKey: routedModelKey,
      routed: true,
    };
  } catch (error) {
    console.warn(
      `[ModelRouting] Failed to load routed ${mode} model "${routedModelKey}". Falling back to "${requestedModel.key}".`,
      error,
    );

    return {
      llm: await registry.loadChatModel(
        requestedModel.providerId,
        requestedModel.key,
      ),
      providerId: requestedModel.providerId,
      modelKey: requestedModel.key,
      routed: false,
    };
  }
};
