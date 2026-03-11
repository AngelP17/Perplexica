import { performance } from 'node:perf_hooks';
import {
  readJson,
  toMarkdownTable,
  writeJsonResult,
  writeMarkdownResult,
} from './utils.ts';

type ContextAssemblyStrategy = 'baseline' | 'dedup' | 'mmr' | 'optimized';

type RetrievalChunk = {
  content: string;
  metadata: Record<string, unknown> & {
    title?: string;
    lexicalScore?: number;
    vectorScore?: number;
    hybridScore?: number;
    lateInteractionScore?: number;
    crossEncoderScore?: number;
    finalRankingScore?: number;
    authorityScore?: number;
    recencyScore?: number;
    priorClickScore?: number;
    priorSuccessScore?: number;
  };
  label: number;
};

type RetrievalFixture = {
  queries: Array<{
    id: string;
    query: string;
    goldAspects: string[];
    chunks: RetrievalChunk[];
  }>;
};

type Stage = 'hybrid' | 'late_interaction' | 'late_plus_cross_encoder';

const strategies: ContextAssemblyStrategy[] = [
  'baseline',
  'dedup',
  'mmr',
  'optimized',
];

type ChunkFeatureVector = {
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

type ContextCandidate = {
  chunk: RetrievalChunk;
  index: number;
  excerpt: string;
  tokenCount: number;
  score: number;
  features: ChunkFeatureVector;
};

type ContextAssemblyResult = {
  selected: ContextCandidate[];
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

const MODE_TOKEN_BUDGET = {
  speed: 500,
  balanced: 1400,
  quality: 2800,
} as const;

const tokenize = (input: string) =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => Boolean(token) && !STOPWORDS.has(token));

const unique = <T>(values: T[]) => Array.from(new Set(values));

const getTokenCount = (text: string) => Math.ceil(text.length / 4);

const truncateToTokenBudget = (text: string, maxTokens: number) => {
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

const tokenSimilarity = (left: string, right: string) => {
  if (left === right) {
    return 1;
  }

  if (left.startsWith(right) || right.startsWith(left)) {
    return 0.85;
  }

  const leftBigrams = new Set<string>();
  const rightBigrams = new Set<string>();

  for (let index = 0; index < left.length - 1; index++) {
    leftBigrams.add(left.slice(index, index + 2));
  }

  for (let index = 0; index < right.length - 1; index++) {
    rightBigrams.add(right.slice(index, index + 2));
  }

  if (leftBigrams.size === 0 || rightBigrams.size === 0) {
    return 0;
  }

  let intersection = 0;
  leftBigrams.forEach((token) => {
    if (rightBigrams.has(token)) {
      intersection += 1;
    }
  });

  const union = new Set([...leftBigrams, ...rightBigrams]).size;
  return union === 0 ? 0 : intersection / union;
};

const overlapRatio = (left: string[], right: string[]) => {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const rightSet = new Set(right);
  const hits = left.filter((token) => rightSet.has(token)).length;
  return hits / Math.max(left.length, 1);
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

const sentenceSplit = (text: string) =>
  text
    .split(/(?<=[.!?\n])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

const lateInteractionScore = (query: string, chunk: RetrievalChunk) => {
  const queryTokens = Array.from(new Set(tokenize(query))).slice(0, 12);
  const docTokens = Array.from(
    new Set(tokenize(`${chunk.metadata.title || ''} ${chunk.content}`)),
  ).slice(0, 160);

  if (queryTokens.length === 0 || docTokens.length === 0) {
    return 0;
  }

  return (
    queryTokens.reduce((sum, queryToken) => {
      let best = 0;

      for (const docToken of docTokens) {
        best = Math.max(best, tokenSimilarity(queryToken, docToken));
        if (best === 1) {
          break;
        }
      }

      return sum + best;
    }, 0) / queryTokens.length
  );
};

const crossEncoderScore = (query: string, chunk: RetrievalChunk) => {
  const queryTokens = Array.from(new Set(tokenize(query)));
  const docTokens = Array.from(
    new Set(tokenize(`${chunk.metadata.title || ''} ${chunk.content}`)),
  );

  if (queryTokens.length === 0 || docTokens.length === 0) {
    return 0;
  }

  const overlap =
    queryTokens.filter((token) => docTokens.includes(token)).length /
    queryTokens.length;

  return Math.min(1, overlap * 0.6 + lateInteractionScore(query, chunk) * 0.4);
};

const rerankByStage = (
  stage: Stage,
  query: string,
  chunks: RetrievalChunk[],
) => {
  const hybridRanked = [...chunks]
    .map((chunk) => {
      const lexical = Number(chunk.metadata.lexicalScore || 0);
      const vector = Number(chunk.metadata.vectorScore || 0);
      const hybridScore = lexical * 0.45 + vector * 0.55;

      return {
        ...chunk,
        metadata: {
          ...chunk.metadata,
          hybridScore,
          lateInteractionScore: hybridScore,
          crossEncoderScore: 0,
        },
      };
    })
    .sort(
      (left, right) =>
        Number(right.metadata.hybridScore || 0) -
        Number(left.metadata.hybridScore || 0),
    );

  if (stage === 'hybrid') {
    return hybridRanked;
  }

  const lateInteractionCandidateCount = Math.min(24, hybridRanked.length);
  const lateInteractionRanked = hybridRanked
    .map((chunk, index) => {
      if (index >= lateInteractionCandidateCount) {
        return chunk;
      }

      const lateScore = lateInteractionScore(query, chunk);
      const finalRankingScore =
        Number(chunk.metadata.hybridScore || 0) * 0.55 + lateScore * 0.45;

      return {
        ...chunk,
        metadata: {
          ...chunk.metadata,
          lateInteractionScore: lateScore,
          hybridScore: Number(chunk.metadata.hybridScore || 0),
          finalRankingScore,
        },
      };
    })
    .sort(
      (left, right) =>
        Number(
          right.metadata.finalRankingScore || right.metadata.hybridScore || 0,
        ) -
        Number(
          left.metadata.finalRankingScore || left.metadata.hybridScore || 0,
        ),
    );

  if (stage === 'late_interaction') {
    return lateInteractionRanked;
  }

  const crossEncoderSlice = Math.min(6, lateInteractionRanked.length);
  return lateInteractionRanked
    .map((chunk, index) => {
      if (index >= crossEncoderSlice) {
        return chunk;
      }

      const crossScore = crossEncoderScore(query, chunk);
      const finalRankingScore =
        Number(
          chunk.metadata.finalRankingScore || chunk.metadata.hybridScore || 0,
        ) *
          0.7 +
        crossScore * 0.3;

      return {
        ...chunk,
        metadata: {
          ...chunk.metadata,
          crossEncoderScore: crossScore,
          finalRankingScore,
        },
      };
    })
    .sort(
      (left, right) =>
        Number(
          right.metadata.finalRankingScore || right.metadata.hybridScore || 0,
        ) -
        Number(
          left.metadata.finalRankingScore || left.metadata.hybridScore || 0,
        ),
    );
};

const estimateStageTokenCost = (
  stage: Stage,
  query: string,
  ranked: RetrievalChunk[],
) => {
  if (stage === 'hybrid') {
    return 0;
  }

  const lateCandidates = ranked.slice(0, Math.min(24, ranked.length));
  let tokenCost = lateCandidates.reduce(
    (sum, chunk) =>
      sum +
      getTokenCount(query) +
      getTokenCount(`${chunk.metadata.title || ''} ${chunk.content}`),
    0,
  );

  if (stage === 'late_plus_cross_encoder') {
    tokenCost += ranked
      .slice(0, Math.min(6, ranked.length))
      .reduce(
        (sum, chunk) =>
          sum +
          getTokenCount(query) +
          getTokenCount(`${chunk.metadata.title || ''} ${chunk.content}`),
        0,
      );
  }

  return tokenCost;
};

const scoreCoverage = (aspects: string[], text: string) => {
  const normalized = text.toLowerCase();
  const hits = aspects.filter((aspect) =>
    normalized.includes(aspect.toLowerCase()),
  ).length;
  return hits / Math.max(aspects.length, 1);
};

const getCitationOverlap = (
  candidate: RetrievalChunk,
  allChunks: RetrievalChunk[],
) => {
  const left = unique(
    tokenize(`${candidate.metadata.title || ''} ${candidate.content}`),
  );

  return allChunks.reduce((maxOverlap, other) => {
    if (other === candidate) {
      return maxOverlap;
    }

    const right = unique(
      tokenize(`${other.metadata.title || ''} ${other.content}`),
    );
    return Math.max(maxOverlap, overlapRatio(left, right));
  }, 0);
};

const getChunkLengthDensity = (chunk: RetrievalChunk) => {
  const tokens = tokenize(chunk.content || '');
  const uniqueTerms = unique(tokens).length;
  const lengthScore = Math.min(tokens.length / 180, 1);
  const densityScore = tokens.length === 0 ? 0 : uniqueTerms / tokens.length;

  return Math.min(1, lengthScore * 0.5 + densityScore * 0.5);
};

const getQueryAspects = (query: string) => unique(tokenize(query)).slice(0, 8);

const selectTopSentences = (
  query: string,
  chunk: RetrievalChunk,
  limit = 2,
) => {
  const queryTerms = unique(tokenize(query));
  const sentences = sentenceSplit(chunk.content || '');

  if (sentences.length === 0) {
    return truncateToTokenBudget(chunk.content || '', 180);
  }

  return sentences
    .map((sentence) => ({
      sentence,
      score:
        overlapRatio(queryTerms, tokenize(sentence)) * 0.7 +
        Math.min(1, getTokenCount(sentence) / 60) * 0.3,
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) => item.sentence)
    .join(' ');
};

const dedupeCandidates = (candidates: ContextCandidate[]) => {
  const deduped: ContextCandidate[] = [];

  for (const candidate of candidates) {
    const duplicate = deduped.some(
      (existing) =>
        overlapRatio(
          unique(tokenize(existing.excerpt)),
          unique(tokenize(candidate.excerpt)),
        ) > 0.82,
    );

    if (!duplicate) {
      deduped.push(candidate);
    }
  }

  return deduped;
};

const mmrSelect = (
  candidates: ContextCandidate[],
  tokenBudget: number,
  lambda = 0.72,
) => {
  const selected: ContextCandidate[] = [];
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
            unique(tokenize(chosen.excerpt)),
            unique(tokenize(candidate.excerpt)),
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

const assembleContext = (input: {
  query: string;
  chunks: RetrievalChunk[];
  mode: keyof typeof MODE_TOKEN_BUDGET;
  strategy?: ContextAssemblyStrategy;
}): ContextAssemblyResult => {
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
          0,
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
        unique(tokenize(`${chunk.metadata.title || ''} ${excerpt}`)),
      ),
    };

    return {
      chunk,
      index,
      excerpt,
      tokenCount: getTokenCount(excerpt),
      features,
      score: logistic(dot(features, DEFAULT_WEIGHTS)),
    };
  });

  const sorted = [...candidates].sort(
    (left, right) => right.score - left.score,
  );

  if (strategy === 'baseline') {
    const selected: ContextCandidate[] = [];
    let used = 0;

    for (const candidate of sorted) {
      if (used + candidate.tokenCount > tokenBudget) {
        break;
      }

      selected.push(candidate);
      used += candidate.tokenCount;
    }

    return { selected, totalTokens: used, strategy };
  }

  const deduped = dedupeCandidates(sorted);

  if (strategy === 'dedup') {
    const selected: ContextCandidate[] = [];
    let used = 0;

    for (const candidate of deduped) {
      if (used + candidate.tokenCount > tokenBudget) {
        break;
      }

      selected.push(candidate);
      used += candidate.tokenCount;
    }

    return { selected, totalTokens: used, strategy };
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
    };
  }

  const selected = mmrSelect(deduped, tokenBudget);
  const coveredAspects = new Set<string>();

  const coverageBoosted = selected
    .map((candidate) => {
      const candidateTerms = unique(
        tokenize(
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
  };
};

const run = async () => {
  const fixture = await readJson<RetrievalFixture>('fixtures/retrieval.json');
  const stageRows = [] as Array<{
    stage: Stage;
    relevance: number;
    latencyMs: number;
    tokenCost: number;
  }>;

  for (const stage of [
    'hybrid',
    'late_interaction',
    'late_plus_cross_encoder',
  ] as Stage[]) {
    let relevance = 0;
    let latencyMs = 0;
    let tokenCost = 0;

    for (const queryCase of fixture.queries) {
      const startedAt = performance.now();
      const reranked = rerankByStage(stage, queryCase.query, queryCase.chunks);
      const ranked = reranked.slice(0, 3);
      const endedAt = performance.now();

      relevance +=
        ranked.reduce((sum, chunk) => sum + chunk.label, 0) /
        Math.max(ranked.length, 1);
      latencyMs += endedAt - startedAt;
      tokenCost += estimateStageTokenCost(stage, queryCase.query, reranked);
    }

    stageRows.push({
      stage,
      relevance: relevance / fixture.queries.length,
      latencyMs: latencyMs / fixture.queries.length,
      tokenCost: tokenCost / fixture.queries.length,
    });
  }

  const strategyRows = [] as Array<{
    strategy: ContextAssemblyStrategy;
    answerQuality: number;
    groundingRate: number;
    finalTokenCount: number;
    citationDensity: number;
    latencyMs: number;
  }>;

  for (const strategy of strategies) {
    let answerQuality = 0;
    let groundingRate = 0;
    let finalTokenCount = 0;
    let citationDensity = 0;
    let latencyMs = 0;

    for (const queryCase of fixture.queries) {
      const rankedChunks = rerankByStage(
        'late_plus_cross_encoder',
        queryCase.query,
        queryCase.chunks,
      );

      const startedAt = performance.now();
      const assembled = assembleContext({
        query: queryCase.query,
        chunks: rankedChunks,
        mode: 'balanced',
        strategy,
      });
      const endedAt = performance.now();

      const selectedText = assembled.selected
        .map((candidate) => candidate.excerpt)
        .join(' ');
      const selectedRelevant = assembled.selected.filter(
        (candidate) => candidate.chunk.label > 0,
      ).length;

      const precision =
        selectedRelevant / Math.max(assembled.selected.length, 1);
      const coverage = scoreCoverage(queryCase.goldAspects, selectedText);

      answerQuality += precision * 0.55 + coverage * 0.45;
      groundingRate += precision;
      finalTokenCount += assembled.totalTokens;
      citationDensity +=
        assembled.totalTokens === 0
          ? 0
          : assembled.selected.length / assembled.totalTokens;
      latencyMs += endedAt - startedAt;
    }

    strategyRows.push({
      strategy,
      answerQuality: answerQuality / fixture.queries.length,
      groundingRate: groundingRate / fixture.queries.length,
      finalTokenCount: finalTokenCount / fixture.queries.length,
      citationDensity: citationDensity / fixture.queries.length,
      latencyMs: latencyMs / fixture.queries.length,
    });
  }

  const markdown = `# Retrieval Benchmark Report

## Retrieval stages

${toMarkdownTable(
  ['Stage', 'Relevance', 'Latency ms', 'Token Cost'],
  stageRows.map((row) => [
    row.stage,
    row.relevance.toFixed(3),
    row.latencyMs.toFixed(3),
    row.tokenCost.toFixed(1),
  ]),
)}

## Context assembly

${toMarkdownTable(
  [
    'Strategy',
    'Answer Quality',
    'Grounding Rate',
    'Final Tokens',
    'Citation Density',
    'Latency ms',
  ],
  strategyRows.map((row) => [
    row.strategy,
    row.answerQuality.toFixed(3),
    row.groundingRate.toFixed(3),
    row.finalTokenCount.toFixed(1),
    row.citationDensity.toFixed(4),
    row.latencyMs.toFixed(3),
  ]),
)}

## Framing

- \`hybrid\`: BM25 or hybrid broad recall only
- \`late_interaction\`: broad recall plus ColBERT-style token max-sim rescoring
- \`late_plus_cross_encoder\`: late interaction plus a cross-encoder-style score on a tiny head slice
- \`optimized\`: late-interaction candidates plus dedup, MMR, sentence extraction, and token-aware packing
`;

  const jsonPath = await writeJsonResult('retrieval-benchmark', {
    generatedAt: new Date().toISOString(),
    stageRows,
    strategyRows,
  });
  const markdownPath = await writeMarkdownResult(
    'retrieval-benchmark',
    markdown,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        jsonPath,
        markdownPath,
        bestStage: [...stageRows].sort(
          (left, right) => right.relevance - left.relevance,
        )[0],
        bestStrategy: [...strategyRows].sort(
          (left, right) => right.answerQuality - left.answerQuality,
        )[0],
      },
      null,
      2,
    ),
  );
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
