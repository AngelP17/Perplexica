import { getEncoding } from 'js-tiktoken';

const encoding = getEncoding('cl100k_base');

export const getTokenCount = (text: string): number => {
  try {
    return encoding.encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
};

export const truncateToTokenBudget = (text: string, maxTokens: number) => {
  if (getTokenCount(text) <= maxTokens) {
    return text;
  }

  const segments = text.split(/(?<=[.!?\n])\s+/);
  let result = '';

  for (const segment of segments) {
    const candidate = result ? `${result} ${segment}` : segment;
    if (getTokenCount(candidate) > maxTokens) {
      break;
    }

    result = candidate;
  }

  return result || text.slice(0, maxTokens * 4);
};
