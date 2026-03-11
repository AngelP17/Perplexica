import BaseEmbedding from '@/lib/models/base/embedding';
import { Chunk } from '@/lib/types';
import computeSimilarity from '@/lib/utils/computeSimilarity';

type SearchQueryType = 'web' | 'document' | 'academic';

type RankedChunk = Chunk & {
  metadata: Chunk['metadata'] & {
    title?: string;
    url?: string;
    normalizedUrl?: string;
    publishedAt?: string;
    lexicalScore?: number;
    vectorScore?: number | null;
    hybridScore?: number;
    lateInteractionScore?: number;
    crossEncoderScore?: number;
    finalRankingScore?: number;
    qualityScore?: number;
    relevanceScore?: number;
    authorityScore?: number;
    agreementScore?: number;
    rankScore?: number;
    recencyScore?: number;
    confidence?: number;
    confidenceLabel?: 'high' | 'medium' | 'low' | 'conflict';
    citation?: string;
    hasConflict?: boolean;
    domain?: string;
    sourceType?: string;
  };
};

type PostProcessInput = {
  query: string;
  results: Chunk[];
  embedding?: BaseEmbedding<any>;
  maxResults?: number;
};

const VERIFIED_DOMAINS = new Set([
  'arxiv.org',
  'github.com',
  'nature.com',
  'nih.gov',
  'pubmed.ncbi.nlm.nih.gov',
  'stackoverflow.com',
  'wikipedia.org',
]);

const NAV_KEYWORDS = [
  'home',
  'menu',
  'login',
  'sign up',
  'contact',
  'about',
  'privacy',
  'cookies',
];

const COMMERCIAL_KEYWORDS = [
  'buy',
  'subscribe',
  'sale',
  'discount',
  'offer',
  'pricing',
];

const TIME_SENSITIVE_KEYWORDS = [
  'latest',
  'recent',
  'today',
  'yesterday',
  'current',
  'new',
  'update',
  'this year',
  '2024',
  '2025',
  '2026',
];

const tokenize = (input: string) =>
  input
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1);

const normalizeUrl = (url?: string) => {
  if (!url || url.startsWith('file_id://')) {
    return url || '';
  }

  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(
      /\/$/,
      '',
    );
  } catch {
    return url;
  }
};

const getDomain = (url?: string) => {
  if (!url) {
    return 'unknown';
  }

  if (url.startsWith('file_id://')) {
    return 'local-file';
  }

  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
};

const normalizeScore = (scores: number[]) => {
  if (scores.length === 0) {
    return [];
  }

  const max = Math.max(...scores);
  const min = Math.min(...scores);

  if (max === min) {
    return scores.map(() => (max > 0 ? 1 : 0));
  }

  return scores.map((score) => (score - min) / (max - min));
};

const getTokenBigrams = (value: string) => {
  const normalized = value.toLowerCase();
  const bigrams = new Set<string>();

  for (let index = 0; index < normalized.length - 1; index++) {
    bigrams.add(normalized.slice(index, index + 2));
  }

  return bigrams;
};

const tokenSimilarity = (left: string, right: string) => {
  if (left === right) {
    return 1;
  }

  if (left.startsWith(right) || right.startsWith(left)) {
    return 0.85;
  }

  const leftBigrams = getTokenBigrams(left);
  const rightBigrams = getTokenBigrams(right);

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

const computeLateInteractionScore = (query: string, document: string) => {
  const queryTokens = Array.from(new Set(tokenize(query))).slice(0, 12);
  const docTokens = Array.from(new Set(tokenize(document))).slice(0, 160);

  if (queryTokens.length === 0 || docTokens.length === 0) {
    return 0;
  }

  const score = queryTokens.reduce((sum, queryToken) => {
    let maxSimilarity = 0;

    for (const docToken of docTokens) {
      maxSimilarity = Math.max(
        maxSimilarity,
        tokenSimilarity(queryToken, docToken),
      );
      if (maxSimilarity === 1) {
        break;
      }
    }

    return sum + maxSimilarity;
  }, 0);

  return score / queryTokens.length;
};

const computeCrossEncoderProxyScore = (query: string, document: string) => {
  const queryTokens = Array.from(new Set(tokenize(query)));
  const docTokens = Array.from(new Set(tokenize(document)));

  if (queryTokens.length === 0 || docTokens.length === 0) {
    return 0;
  }

  const lexicalOverlap =
    queryTokens.filter((token) => docTokens.includes(token)).length /
    queryTokens.length;
  const orderedPhraseBonus = document
    .toLowerCase()
    .includes(queryTokens.slice(0, Math.min(queryTokens.length, 3)).join(' '))
    ? 0.15
    : 0;

  return Math.min(
    1,
    lexicalOverlap * 0.6 +
      computeLateInteractionScore(query, document) * 0.4 +
      orderedPhraseBonus,
  );
};

const computeBm25Scores = (query: string, docs: string[]) => {
  if (docs.length === 0) {
    return [];
  }

  const k1 = 1.2;
  const b = 0.75;
  const docTokens = docs.map(tokenize);
  const avgDocLength =
    docTokens.reduce((total, tokens) => total + tokens.length, 0) /
      docs.length || 1;
  const queryTerms = Array.from(new Set(tokenize(query)));

  return docTokens.map((tokens) => {
    if (tokens.length === 0) {
      return 0;
    }

    const termFrequency = new Map<string, number>();
    tokens.forEach((token) => {
      termFrequency.set(token, (termFrequency.get(token) || 0) + 1);
    });

    return queryTerms.reduce((score, term) => {
      const freq = termFrequency.get(term) || 0;
      if (freq === 0) {
        return score;
      }

      const df = docTokens.reduce(
        (count, doc) => count + (doc.includes(term) ? 1 : 0),
        0,
      );
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      const numerator = freq * (k1 + 1);
      const denominator =
        freq + k1 * (1 - b + b * (tokens.length / avgDocLength));

      return score + idf * (numerator / denominator);
    }, 0);
  });
};

const jaccardSimilarity = (left: string, right: string) => {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  });

  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
};

const detectNoise = (chunk: Chunk) => {
  const content = `${chunk.metadata.title || ''} ${chunk.content || ''}`.trim();
  const words = tokenize(content);

  const navigationHits = NAV_KEYWORDS.filter((keyword) =>
    content.toLowerCase().includes(keyword),
  ).length;
  const commercialHits = COMMERCIAL_KEYWORDS.filter((keyword) =>
    content.toLowerCase().includes(keyword),
  ).length;

  const isNavigationHeavy = words.length < 100 && navigationHits >= 4;
  const isLowContent = words.length < 12;
  const promoDensity = words.length === 0 ? 0 : commercialHits / words.length;

  return {
    shouldDiscard: isNavigationHeavy || isLowContent,
    promoPenalty: promoDensity > 0.08 ? 0.2 : 0,
  };
};

const getAuthorityScore = (domain: string) => {
  if (
    domain.endsWith('.edu') ||
    domain.endsWith('.gov') ||
    VERIFIED_DOMAINS.has(domain)
  ) {
    return 1;
  }

  if (domain.endsWith('.org')) {
    return 0.7;
  }

  if (domain === 'local-file') {
    return 0.8;
  }

  if (domain.endsWith('.com') || domain.endsWith('.io')) {
    return 0.5;
  }

  return 0.3;
};

const getQueryType = (chunk: Chunk): SearchQueryType => {
  const sourceType = String(chunk.metadata.sourceType || '');

  if (sourceType === 'academic') {
    return 'academic';
  }

  if (
    sourceType === 'document' ||
    String(chunk.metadata.url || '').startsWith('file_id://')
  ) {
    return 'document';
  }

  return 'web';
};

const getRelevanceThreshold = (queryType: SearchQueryType) => {
  switch (queryType) {
    case 'document':
      return 0.25;
    case 'academic':
      return 0.2;
    case 'web':
    default:
      return 0.18;
  }
};

const getQualityScore = (
  chunk: Chunk,
  domain: string,
  promoPenalty: number,
) => {
  const words = tokenize(chunk.content || '');
  const titleWords = tokenize(String(chunk.metadata.title || ''));
  const totalWords = words.length + titleWords.length;
  const uniqueTerms = new Set([...words, ...titleWords]).size;

  const contentScore = Math.min(totalWords / 220, 1) * 0.2;
  const densityScore =
    totalWords === 0 ? 0 : Math.min(uniqueTerms / totalWords, 1) * 0.3;
  const structureScore =
    (chunk.content.includes('\n') ? 0.1 : 0) +
    (String(chunk.metadata.title || '').trim() ? 0.1 : 0);
  const authorityScore = getAuthorityScore(domain) * 0.3;

  return Math.max(
    0,
    Math.min(
      1,
      contentScore +
        densityScore +
        structureScore +
        authorityScore -
        promoPenalty,
    ),
  );
};

const parsePublishedAt = (value: unknown) => {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return timestamp;
};

const isTimeSensitiveQuery = (query: string) => {
  const normalized = query.toLowerCase();
  return TIME_SENSITIVE_KEYWORDS.some((keyword) =>
    normalized.includes(keyword),
  );
};

const getRecencyScore = (query: string, publishedAt?: unknown) => {
  if (!isTimeSensitiveQuery(query)) {
    return 0;
  }

  const timestamp = parsePublishedAt(publishedAt);
  if (!timestamp) {
    return 0.5;
  }

  const ageInDays = (Date.now() - timestamp) / (24 * 60 * 60 * 1000);
  return Math.max(0, 1 - ageInDays / 365);
};

const extractNumbers = (text: string) => {
  return new Set((text.match(/\b\d+(?:\.\d+)?\b/g) || []).slice(0, 6));
};

const detectConflict = (candidate: Chunk, allResults: Chunk[]) => {
  const candidateSignature = `${candidate.metadata.title || ''} ${candidate.content || ''}`;
  const candidateNumbers = extractNumbers(candidateSignature);

  if (candidateNumbers.size === 0) {
    return false;
  }

  return allResults.some((other) => {
    if (other === candidate) {
      return false;
    }

    const otherSignature = `${other.metadata.title || ''} ${other.content || ''}`;
    const overlap = jaccardSimilarity(candidateSignature, otherSignature);
    if (overlap < 0.42) {
      return false;
    }

    const otherNumbers = extractNumbers(otherSignature);
    if (otherNumbers.size === 0) {
      return false;
    }

    const sameNumbers =
      Array.from(candidateNumbers).filter((value) => otherNumbers.has(value))
        .length > 0;

    return !sameNumbers;
  });
};

export const rerankSearchResults = async ({
  query,
  results,
  embedding,
}: PostProcessInput) => {
  if (results.length === 0) {
    return [] as RankedChunk[];
  }

  const docs = results.map(
    (result) =>
      `${String(result.metadata.title || '')}\n${result.content || ''}`,
  );
  const lexicalScores = computeBm25Scores(query, docs);
  let vectorScores: Array<number | null> = results.map(() => null);

  if (embedding) {
    try {
      const [queryEmbedding] = await embedding.embedText([query]);
      const resultEmbeddings = await embedding.embedChunks(results);
      vectorScores = resultEmbeddings.map((resultEmbedding) =>
        computeSimilarity(queryEmbedding, resultEmbedding),
      );
    } catch (error) {
      console.warn(
        '[Search] Hybrid reranking fell back to lexical only:',
        error,
      );
    }
  }

  const normalizedLexical = normalizeScore(lexicalScores);
  const normalizedVector = normalizeScore(
    vectorScores.map((score) => score ?? 0),
  );

  const hybridRanked = results
    .map((result, index) => {
      const lexicalScore = normalizedLexical[index] || 0;
      const vectorScore = vectorScores[index];
      const hybridScore =
        vectorScore == null
          ? lexicalScore
          : lexicalScore * 0.45 + (normalizedVector[index] || 0) * 0.55;

      return {
        ...result,
        metadata: {
          ...result.metadata,
          lexicalScore,
          vectorScore,
          hybridScore,
        },
      } as RankedChunk;
    })
    .sort(
      (left, right) =>
        (right.metadata.hybridScore || 0) - (left.metadata.hybridScore || 0),
    );

  const lateInteractionCandidateCount = Math.min(24, hybridRanked.length);
  const lateInteractionRanked = hybridRanked.map((result, index) => {
    if (index >= lateInteractionCandidateCount) {
      return {
        ...result,
        metadata: {
          ...result.metadata,
          lateInteractionScore: result.metadata.hybridScore || 0,
          finalRankingScore: result.metadata.hybridScore || 0,
        },
      } as RankedChunk;
    }

    const document = `${String(result.metadata.title || '')}\n${result.content || ''}`;
    const lateInteractionScore = computeLateInteractionScore(query, document);
    const finalRankingScore =
      (result.metadata.hybridScore || 0) * 0.55 + lateInteractionScore * 0.45;

    return {
      ...result,
      metadata: {
        ...result.metadata,
        lateInteractionScore,
        finalRankingScore,
      },
    } as RankedChunk;
  });

  lateInteractionRanked.sort(
    (left, right) =>
      (right.metadata.finalRankingScore || 0) -
      (left.metadata.finalRankingScore || 0),
  );

  const crossEncoderSlice = Math.min(6, lateInteractionRanked.length);
  const reranked = lateInteractionRanked.map((result, index) => {
    if (index >= crossEncoderSlice) {
      return result;
    }

    const document = `${String(result.metadata.title || '')}\n${result.content || ''}`;
    const crossEncoderScore = computeCrossEncoderProxyScore(query, document);
    const finalRankingScore =
      (result.metadata.finalRankingScore || 0) * 0.7 + crossEncoderScore * 0.3;

    return {
      ...result,
      metadata: {
        ...result.metadata,
        crossEncoderScore,
        finalRankingScore,
      },
    } as RankedChunk;
  });

  return reranked.sort(
    (left, right) =>
      (right.metadata.finalRankingScore || 0) -
      (left.metadata.finalRankingScore || 0),
  );
};

export const postProcessSearchResults = async ({
  query,
  results,
  embedding,
  maxResults = 15,
}: PostProcessInput) => {
  const initialCount = results.length;
  const reranked = await rerankSearchResults({
    query,
    results,
    embedding,
    maxResults,
  });

  const mergedByUrl = new Map<string, RankedChunk>();

  reranked.forEach((result) => {
    const normalizedUrl = normalizeUrl(String(result.metadata.url || ''));
    const existing = normalizedUrl ? mergedByUrl.get(normalizedUrl) : undefined;

    if (existing) {
      existing.content = `${existing.content}\n\n${result.content}`.trim();
      existing.metadata.hybridScore = Math.max(
        existing.metadata.hybridScore || 0,
        result.metadata.hybridScore || 0,
      );
      return;
    }

    if (normalizedUrl) {
      mergedByUrl.set(normalizedUrl, {
        ...result,
        metadata: {
          ...result.metadata,
          normalizedUrl,
        },
      });
    } else {
      mergedByUrl.set(crypto.randomUUID(), result);
    }
  });

  const deduped: RankedChunk[] = [];

  Array.from(mergedByUrl.values()).forEach((candidate) => {
    const isDuplicate = deduped.some(
      (existing) =>
        jaccardSimilarity(existing.content, candidate.content) > 0.8,
    );

    if (!isDuplicate) {
      deduped.push(candidate);
    }
  });

  const filtered = deduped
    .map((result) => {
      const domain = getDomain(String(result.metadata.url || ''));
      const noise = detectNoise(result);
      const queryType = getQueryType(result);
      const relevanceScore = result.metadata.hybridScore || 0;
      const qualityScore = getQualityScore(result, domain, noise.promoPenalty);

      return {
        ...result,
        metadata: {
          ...result.metadata,
          domain,
          relevanceScore,
          authorityScore: getAuthorityScore(domain),
          qualityScore,
        },
        __discard: noise.shouldDiscard,
        __queryType: queryType,
      };
    })
    .filter((result) => {
      if (result.__discard) {
        return false;
      }

      return (
        (result.metadata.relevanceScore || 0) >=
          getRelevanceThreshold(result.__queryType) &&
        (result.metadata.qualityScore || 0) >= 0.35
      );
    })
    .sort(
      (left, right) =>
        (right.metadata.hybridScore || 0) - (left.metadata.hybridScore || 0),
    );

  const byDomain = new Map<string, number>();
  const diverse = filtered.filter((result) => {
    const domain = String(result.metadata.domain || 'unknown');
    const count = byDomain.get(domain) || 0;

    if (count >= 3) {
      return false;
    }

    byDomain.set(domain, count + 1);
    return true;
  });

  const agreementScores = diverse.map((candidate) => {
    const matches = diverse.filter(
      (other) =>
        jaccardSimilarity(
          `${candidate.metadata.title || ''} ${candidate.content || ''}`,
          `${other.metadata.title || ''} ${other.content || ''}`,
        ) >= 0.18,
    ).length;

    return matches / Math.max(diverse.length, 1);
  });

  const withConfidence = diverse
    .map((result, index) => {
      const rankScore =
        diverse.length <= 1 ? 1 : 1 - index / Math.max(diverse.length - 1, 1);
      const agreementScore = agreementScores[index] || 0;
      const authorityScore = result.metadata.authorityScore || 0;
      const recencyScore = getRecencyScore(query, result.metadata.publishedAt);
      const hasConflict = detectConflict(result, diverse);
      const confidence = Math.max(
        0,
        Math.min(
          1,
          agreementScore * 0.4 +
            rankScore * 0.3 +
            authorityScore * 0.2 +
            recencyScore * 0.1,
        ),
      );

      let confidenceLabel: RankedChunk['metadata']['confidenceLabel'] = 'low';
      if (hasConflict) {
        confidenceLabel = 'conflict';
      } else if (confidence > 0.8) {
        confidenceLabel = 'high';
      } else if (confidence > 0.5) {
        confidenceLabel = 'medium';
      }

      return {
        ...result,
        metadata: {
          ...result.metadata,
          agreementScore,
          rankScore,
          recencyScore,
          confidence,
          confidenceLabel,
          hasConflict,
        },
      } as RankedChunk;
    })
    .sort(
      (left, right) =>
        (right.metadata.confidence || 0) - (left.metadata.confidence || 0),
    )
    .slice(0, maxResults)
    .map((result, index) => {
      const suffix =
        result.metadata.confidenceLabel === 'conflict'
          ? '!'
          : result.metadata.confidenceLabel === 'medium'
            ? '~'
            : result.metadata.confidenceLabel === 'low'
              ? '?'
              : '';

      return {
        ...result,
        metadata: {
          ...result.metadata,
          citation: `[${index + 1}${suffix}]`,
        },
      } as RankedChunk;
    });

  console.debug('[Search] Post-processed search results', {
    query,
    initialCount,
    rerankedCount: reranked.length,
    dedupedCount: deduped.length,
    filteredCount: filtered.length,
    finalCount: withConfidence.length,
  });

  return withConfidence;
};
