import { Chunk } from '../../types';
import { getTokenCount, truncateToTokenBudget } from '../../utils/tokenCount';

type ContextMode = 'speed' | 'balanced' | 'quality';
export type ContextAssemblyStrategy =
  | 'baseline'
  | 'dedup'
  | 'mmr'
  | 'optimized';

export type ChunkFeatureVector = {
  bm25Score: number;
  vectorSimilarity: number;
  crossEncoderScore: number;
  sourceAuthorityScore: number;
  freshnessScore: number;
  chunkLengthDensity: number;
  citationOverlap: number;
  priorSuccessScore: number;
  queryCoverage: number;
};

type Candidate = {
  chunk: Chunk;
  index: number;
  excerpt: string;
  tokenCount: number;
  score: number;
  features: ChunkFeatureVector;
};

export type ContextAssemblyResult = {
  selected: Candidate[];
  totalTokens: number;
  strategy: ContextAssemblyStrategy;
};

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'by',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'to',
  'what',
  'when',
  'where',
  'who',
  'why',
  'with',
]);

const DEFAULT_WEIGHTS: ChunkFeatureVector = {
  bm25Score: 1.2,
  vectorSimilarity: 1.1,
  crossEncoderScore: 1.4,
  sourceAuthorityScore: 0.6,
  freshnessScore: 0.4,
  chunkLengthDensity: 0.7,
  citationOverlap: -0.8,
  priorSuccessScore: 0.25,
  queryCoverage: 0.95,
};

const MODE_TOKEN_BUDGET: Record<ContextMode, number> = {
  speed: 500,
  balanced: 1400,
  quality: 2800,
};

const normalize = (input: string) =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));

const unique = <T>(values: T[]) => Array.from(new Set(values));

const overlapRatio = (left: string[], right: string[]) => {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const rightSet = new Set(right);
  const hits = left.filter((token) => rightSet.has(token)).length;
  return hits / Math.max(left.length, 1);
};

const sentenceSplit = (text: string) =>
  text
    .split(/(?<=[.!?\n])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

const getCitationOverlap = (candidate: Chunk, allChunks: Chunk[]) => {
  const left = unique(
    normalize(`${candidate.metadata.title || ''} ${candidate.content}`),
  );

  return allChunks.reduce((maxOverlap, other) => {
    if (other === candidate) {
      return maxOverlap;
    }

    const right = unique(
      normalize(`${other.metadata.title || ''} ${other.content}`),
    );
    return Math.max(maxOverlap, overlapRatio(left, right));
  }, 0);
};

const getChunkLengthDensity = (chunk: Chunk) => {
  const tokens = normalize(chunk.content || '');
  const uniqueTerms = unique(tokens).length;
  const lengthScore = Math.min(tokens.length / 180, 1);
  const densityScore = tokens.length === 0 ? 0 : uniqueTerms / tokens.length;

  return Math.min(1, lengthScore * 0.5 + densityScore * 0.5);
};

const getCrossEncoderProxyScore = (query: string, chunk: Chunk) => {
  const queryTerms = unique(normalize(query));
  const titleTerms = unique(normalize(String(chunk.metadata.title || '')));
  const contentTerms = unique(normalize(chunk.content || ''));
  const titleMatch = overlapRatio(queryTerms, titleTerms);
  const contentMatch = overlapRatio(queryTerms, contentTerms);

  return Math.min(1, titleMatch * 0.45 + contentMatch * 0.55);
};

const getQueryAspects = (query: string) => {
  return unique(normalize(query)).slice(0, 8);
};

const logistic = (value: number) => 1 / (1 + Math.exp(-value));

const dot = (features: ChunkFeatureVector, weights: ChunkFeatureVector) =>
  features.bm25Score * weights.bm25Score +
  features.vectorSimilarity * weights.vectorSimilarity +
  features.crossEncoderScore * weights.crossEncoderScore +
  features.sourceAuthorityScore * weights.sourceAuthorityScore +
  features.freshnessScore * weights.freshnessScore +
  features.chunkLengthDensity * weights.chunkLengthDensity +
  features.citationOverlap * weights.citationOverlap +
  features.priorSuccessScore * weights.priorSuccessScore +
  features.queryCoverage * weights.queryCoverage;

const selectTopSentences = (query: string, chunk: Chunk, limit = 2) => {
  const queryTerms = unique(normalize(query));
  const sentences = sentenceSplit(chunk.content || '');

  if (sentences.length === 0) {
    return truncateToTokenBudget(chunk.content || '', 180);
  }

  return sentences
    .map((sentence) => ({
      sentence,
      score:
        overlapRatio(queryTerms, normalize(sentence)) * 0.7 +
        Math.min(1, getTokenCount(sentence) / 60) * 0.3,
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) => item.sentence)
    .join(' ');
};

const dedupeCandidates = (candidates: Candidate[]) => {
  const deduped: Candidate[] = [];

  for (const candidate of candidates) {
    const duplicate = deduped.some(
      (existing) =>
        overlapRatio(
          unique(normalize(existing.excerpt)),
          unique(normalize(candidate.excerpt)),
        ) > 0.82,
    );

    if (!duplicate) {
      deduped.push(candidate);
    }
  }

  return deduped;
};

const mmrSelect = (
  candidates: Candidate[],
  tokenBudget: number,
  lambda = 0.72,
) => {
  const selected: Candidate[] = [];
  const remaining = [...candidates];
  let tokensUsed = 0;

  while (remaining.length > 0) {
    let bestIndex = -1;
    let bestScore = -Infinity;

    remaining.forEach((candidate, index) => {
      const noveltyPenalty = selected.reduce((maxPenalty, chosen) => {
        return Math.max(
          maxPenalty,
          overlapRatio(
            unique(normalize(chosen.excerpt)),
            unique(normalize(candidate.excerpt)),
          ),
        );
      }, 0);

      const score = lambda * candidate.score - (1 - lambda) * noveltyPenalty;

      if (
        tokensUsed + candidate.tokenCount <= tokenBudget &&
        score > bestScore
      ) {
        bestScore = score;
        bestIndex = index;
      }
    });

    if (bestIndex === -1) {
      break;
    }

    const [next] = remaining.splice(bestIndex, 1);
    selected.push(next);
    tokensUsed += next.tokenCount;
  }

  return selected;
};

export const assembleContext = (input: {
  query: string;
  chunks: Chunk[];
  mode: ContextMode;
  strategy?: ContextAssemblyStrategy;
}) => {
  const strategy = input.strategy || 'optimized';
  const tokenBudget = MODE_TOKEN_BUDGET[input.mode];
  const queryAspects = getQueryAspects(input.query);

  const candidates = input.chunks.map((chunk, index) => {
    const excerpt =
      strategy === 'baseline'
        ? chunk.content
        : selectTopSentences(input.query, chunk, 2);
    const features: ChunkFeatureVector = {
      bm25Score: Number(chunk.metadata.lexicalScore || 0),
      vectorSimilarity: Number(chunk.metadata.vectorScore || 0),
      crossEncoderScore: Number(
        chunk.metadata.crossEncoderScore ||
          chunk.metadata.lateInteractionScore ||
          getCrossEncoderProxyScore(input.query, chunk),
      ),
      sourceAuthorityScore: Number(chunk.metadata.authorityScore || 0),
      freshnessScore: Number(chunk.metadata.recencyScore || 0),
      chunkLengthDensity: getChunkLengthDensity(chunk),
      citationOverlap: getCitationOverlap(chunk, input.chunks),
      priorSuccessScore: Number(
        chunk.metadata.priorSuccessScore || chunk.metadata.priorClickScore || 0,
      ),
      queryCoverage: overlapRatio(
        queryAspects,
        unique(normalize(`${chunk.metadata.title || ''} ${excerpt}`)),
      ),
    };

    return {
      chunk,
      index,
      excerpt,
      tokenCount: getTokenCount(excerpt),
      features,
      score: logistic(dot(features, DEFAULT_WEIGHTS)),
    } satisfies Candidate;
  });

  const sorted = [...candidates].sort(
    (left, right) => right.score - left.score,
  );

  if (strategy === 'baseline') {
    const selected: Candidate[] = [];
    let used = 0;

    for (const candidate of sorted) {
      if (used + candidate.tokenCount > tokenBudget) {
        break;
      }

      selected.push(candidate);
      used += candidate.tokenCount;
    }

    return {
      selected,
      totalTokens: used,
      strategy,
    } satisfies ContextAssemblyResult;
  }

  const deduped = dedupeCandidates(sorted);

  if (strategy === 'dedup') {
    const selected: Candidate[] = [];
    let used = 0;

    for (const candidate of deduped) {
      if (used + candidate.tokenCount > tokenBudget) {
        break;
      }

      selected.push(candidate);
      used += candidate.tokenCount;
    }

    return {
      selected,
      totalTokens: used,
      strategy,
    } satisfies ContextAssemblyResult;
  }

  if (strategy === 'mmr') {
    const selected = mmrSelect(deduped, tokenBudget);
    return {
      selected,
      totalTokens: selected.reduce(
        (sum, candidate) => sum + candidate.tokenCount,
        0,
      ),
      strategy,
    } satisfies ContextAssemblyResult;
  }

  const selected = mmrSelect(deduped, tokenBudget);
  const coveredAspects = new Set<string>();

  const coverageBoosted = selected
    .map((candidate) => {
      const candidateTerms = unique(
        normalize(
          `${candidate.chunk.metadata.title || ''} ${candidate.excerpt}`,
        ),
      );
      const newCoverage = queryAspects.filter(
        (aspect) =>
          !coveredAspects.has(aspect) && candidateTerms.includes(aspect),
      );

      newCoverage.forEach((aspect) => coveredAspects.add(aspect));

      return {
        ...candidate,
        score: candidate.score + newCoverage.length * 0.05,
      };
    })
    .sort((left, right) => right.score - left.score);

  return {
    selected: coverageBoosted,
    totalTokens: coverageBoosted.reduce(
      (sum, candidate) => sum + candidate.tokenCount,
      0,
    ),
    strategy,
  } satisfies ContextAssemblyResult;
};
