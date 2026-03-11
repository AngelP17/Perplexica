# Algorithm Specifications: Quality Filtering & Confidence Scoring

This document defines precise criteria and implementation specifications for Algorithms 4 and 10.

---

## Algorithm 10: Quality Filtering - Detailed Criteria

### 1. Relevance Threshold

**Metric**: Cosine similarity score (post-reranking)

**Thresholds by Context**:
- **Web search results**: Minimum 0.3 similarity score
- **Document search results**: Minimum 0.4 similarity score
- **Academic search results**: Minimum 0.35 similarity score (slightly lower to capture diverse sources)

**Implementation**:
```typescript
function passesRelevanceThreshold(result: SearchResult, queryType: 'web' | 'document' | 'academic'): boolean {
  const thresholds = {
    web: 0.3,
    document: 0.4,
    academic: 0.35,
  };
  return result.similarityScore >= thresholds[queryType];
}
```

**Rationale**: After reranking with cross-encoder, scores below these thresholds indicate weak relevance. Including them pollutes context and degrades answer quality.

---

### 2. Source Quality Score

**Components** (weighted combination):
1. **Content Length** (20% weight)
   - Min: 50 words (below this = likely navigation/spam)
   - Ideal: 200-2000 words
   - Scoring: `min(contentWords / 500, 1.0) * 0.2`

2. **Information Density** (30% weight)
   - Ratio of meaningful content to boilerplate
   - Metrics:
     - Unique noun phrases / total words
     - Absence of navigation keywords ("Home", "Menu", "Login", etc.)
   - Scoring: `(uniqueNouns / totalWords) * 0.3`

3. **Structure Quality** (20% weight)
   - Presence of headers (H1-H6)
   - Paragraph organization
   - Absence of excessive lists/navigation
   - Scoring: `(hasHeaders ? 0.1 : 0) + (hasParagraphs ? 0.1 : 0)`

4. **Domain Authority** (30% weight) - *Optional*
   - Top-level domains (.edu, .gov, .org) get bonus
   - Known reputable sources get boost
   - Scoring:
     - `.edu`, `.gov`: +0.15
     - `.org`: +0.10
     - Verified domains (arxiv.org, github.com, etc.): +0.15
     - Default: 0.0

**Aggregate Formula**:
```
qualityScore = (contentLengthScore * 0.2) +
               (informationDensity * 0.3) +
               (structureQuality * 0.2) +
               (domainAuthority * 0.3)
```

**Threshold**: Minimum quality score of **0.4** to pass filter

**Implementation**:
```typescript
interface QualityMetrics {
  contentWords: number;
  uniqueNouns: number;
  totalWords: number;
  hasHeaders: boolean;
  hasParagraphs: boolean;
  domain: string;
}

function calculateQualityScore(metrics: QualityMetrics): number {
  // Content length score
  const contentScore = Math.min(metrics.contentWords / 500, 1.0) * 0.2;

  // Information density
  const density = (metrics.uniqueNouns / metrics.totalWords) * 0.3;

  // Structure quality
  const structure = (metrics.hasHeaders ? 0.1 : 0) + (metrics.hasParagraphs ? 0.1 : 0);

  // Domain authority
  let authority = 0;
  if (metrics.domain.endsWith('.edu') || metrics.domain.endsWith('.gov')) {
    authority = 0.15;
  } else if (metrics.domain.endsWith('.org')) {
    authority = 0.10;
  } else if (['arxiv.org', 'github.com', 'stackoverflow.com'].includes(metrics.domain)) {
    authority = 0.15;
  }

  return contentScore + density + structure + authority;
}
```

---

### 3. Deduplication

**Multi-Level Deduplication Strategy**:

#### Level 1: URL Deduplication (Already Implemented)
- Exact URL matching
- Ignores query parameters and fragments
- **Action**: Keep first occurrence, concatenate content from duplicates

#### Level 2: Content-Based Deduplication (New)
- **Metric**: Jaccard similarity on content tokens
- **Threshold**: 0.8 (80% overlap)
- **Implementation**:
  ```typescript
  function jaccardSimilarity(text1: string, text2: string): number {
    const tokens1 = new Set(text1.toLowerCase().split(/\s+/));
    const tokens2 = new Set(text2.toLowerCase().split(/\s+/));

    const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
    const union = new Set([...tokens1, ...tokens2]);

    return intersection.size / union.size;
  }

  function isDuplicateContent(chunk1: Chunk, chunk2: Chunk): boolean {
    return jaccardSimilarity(chunk1.content, chunk2.content) > 0.8;
  }
  ```

#### Level 3: Source Diversity Enforcement
- **Rule**: Maximum 3 chunks per domain
- **Rationale**: Prevents single source from dominating context
- **Selection**: Keep highest-scoring chunks from each domain

**Deduplication Pipeline**:
```
1. URL deduplication (existing)
   ↓
2. Content-based deduplication (Jaccard > 0.8)
   ↓
3. Source diversity (max 3 chunks per domain)
   ↓
4. Top-K selection (K=15 for writer context)
```

---

### 4. Anti-Noise Heuristics

**Noise Patterns to Detect and Remove**:

#### 4.1 Navigation Elements
- **Patterns**: "Home", "Menu", "Login", "Sign Up", "Contact Us", "About", "Privacy Policy"
- **Detection**: Presence of 5+ navigation keywords in short text (< 100 words)
- **Action**: Discard result

#### 4.2 Promotional Content
- **Patterns**: "Buy Now", "Subscribe", "Limited Offer", "$" symbols in excess
- **Detection**: High density of commercial keywords (> 10% of content)
- **Action**: Penalize quality score by -0.2

#### 4.3 Boilerplate Text
- **Patterns**: Cookie notices, copyright statements, social media links
- **Detection**: Regex matching + keyword frequency
- **Action**: Strip boilerplate before quality assessment

#### 4.4 Low-Content Pages
- **Patterns**: Pages with mostly images, videos, or code snippets
- **Detection**: Text-to-markup ratio < 0.3
- **Action**: Discard result

#### 4.5 Listicles Without Context
- **Patterns**: Excessive bullet points or numbered lists with < 20 words per item
- **Detection**: List items > 50% of content AND avg item length < 20 words
- **Action**: Penalize quality score by -0.15

**Implementation**:
```typescript
function detectNoise(content: string, html: string): NoiseDetection {
  const navKeywords = ['Home', 'Menu', 'Login', 'Sign Up', 'Contact', 'About', 'Privacy'];
  const commercialKeywords = ['Buy', 'Subscribe', 'Offer', 'Sale', 'Discount'];

  const words = content.split(/\s+/);
  const navCount = navKeywords.filter(kw => content.includes(kw)).length;
  const commercialCount = commercialKeywords.filter(kw => content.includes(kw)).length;

  const isNav = words.length < 100 && navCount >= 5;
  const isPromo = (commercialCount / words.length) > 0.1;
  const isLowContent = (content.length / html.length) < 0.3;

  return { isNav, isPromo, isLowContent, shouldDiscard: isNav || isLowContent };
}
```

---

### Quality Filter Integration Flow

```
Search Results
    ↓
1. Relevance Threshold Filter
   (Remove similarity < threshold)
    ↓
2. Noise Detection
   (Remove navigation/low-content pages)
    ↓
3. Quality Scoring
   (Calculate 0-1 quality score per result)
    ↓
4. Quality Threshold Filter
   (Keep only score >= 0.4)
    ↓
5. Content Deduplication
   (Jaccard similarity > 0.8)
    ↓
6. Source Diversity Enforcement
   (Max 3 chunks per domain)
    ↓
7. Top-K Selection
   (Keep top 15 highest-scoring results)
    ↓
Pass to Writer LLM
```

---

## Algorithm 4: Confidence Scoring - Detailed Specifications

### What Confidence Means

**Definition**: A probabilistic measure (0-1) of how reliable a cited source is for supporting a specific claim.

**Interpretation**:
- **0.9-1.0** (High): Multiple authoritative sources agree
- **0.7-0.9** (Medium-High): Reputable source, well-ranked
- **0.5-0.7** (Medium): Single source, decent rank
- **0.3-0.5** (Low): Weak evidence, low-ranked source
- **0.0-0.3** (Very Low): Speculative, conflicting evidence

**Purpose**: Help users understand which citations are trustworthy vs. speculative.

---

### Confidence Signals (Inputs)

**1. Source Agreement (40% weight)**
- **Metric**: Percentage of top-10 sources that support the same claim
- **Calculation**:
  ```typescript
  sourceAgreement = (sourcesSupporting / totalSources)
  ```
- **Example**: If 7 out of 10 sources mention "renewable energy grew 15%", agreement = 0.7

**2. Result Rank (30% weight)**
- **Metric**: Position in reranked results (inverse ranking)
- **Calculation**:
  ```typescript
  rankScore = 1 - (rank - 1) / totalResults
  // Rank 1 → 1.0, Rank 10 → 0.1
  ```
- **Rationale**: Higher-ranked results passed stronger relevance filters

**3. Source Authority (20% weight)**
- **Metric**: Domain authority score (same as quality filter)
- **Values**:
  - `.edu`, `.gov`, verified domains: 1.0
  - `.org`: 0.7
  - `.com` with high quality: 0.5
  - Default: 0.3

**4. Publication Recency (10% weight)** - *Optional for time-sensitive queries*
- **Metric**: Age of content (for time-sensitive topics)
- **Calculation**:
  ```typescript
  recencyScore = Math.max(0, 1 - (daysSincePublished / 365))
  // Fresh content → 1.0, 1-year-old → 0.0
  ```
- **Trigger**: Only applied if query contains time keywords ("latest", "recent", "2024", etc.)

---

### Aggregate Confidence Formula

```typescript
confidence = (sourceAgreement * 0.4) +
             (rankScore * 0.3) +
             (sourceAuthority * 0.2) +
             (recencyScore * 0.1)  // Optional, 0 if not time-sensitive
```

**Normalization**: Clamp to [0, 1]

---

### How Confidence Affects Answer Generation

#### 1. Citation Notation

**Format in Writer Output**:
- **High (>0.8)**: `[1]` - Standard citation
- **Medium (0.5-0.8)**: `[1~]` - Uncertain marker
- **Low (<0.5)**: `[1?]` - Speculative marker
- **Conflicting**: `[1,2!]` - Multiple sources disagree

**Implementation**:
```typescript
function formatCitation(index: number, confidence: number, hasConflict: boolean): string {
  if (hasConflict) return `[${index}!]`;
  if (confidence > 0.8) return `[${index}]`;
  if (confidence > 0.5) return `[${index}~]`;
  return `[${index}?]`;
}
```

#### 2. Writer Prompt Instructions

**Added to writer prompt**:
```
When citing sources, use confidence markers:
- [n] for high-confidence facts (>0.8): Multiple sources agree, authoritative
- [n~] for medium-confidence facts (0.5-0.8): Single good source or moderate agreement
- [n?] for low-confidence facts (<0.5): Speculative, weak evidence
- [n!] for conflicting facts: Sources disagree on this point

Prefer high-confidence sources. Flag conflicts explicitly.
```

#### 3. Source Ordering

**Priority**: Present high-confidence sources first in context
```typescript
results.sort((a, b) => b.confidence - a.confidence);
```

#### 4. Answer Hedging

**Low-confidence statements trigger hedging language**:
- Confidence < 0.5: Writer instructed to use "may", "possibly", "some sources suggest"
- Conflicting sources: Writer instructed to acknowledge disagreement

---

### Confidence Scoring Integration Flow

```
Reranked & Filtered Results
    ↓
1. Calculate Source Agreement
   (Cluster similar claims, count support)
    ↓
2. Calculate Rank Scores
   (Inverse ranking formula)
    ↓
3. Retrieve Source Authority
   (From quality filter domain scores)
    ↓
4. Check Time Sensitivity
   (Detect temporal keywords in query)
    ↓
5. Calculate Recency Scores (if applicable)
   (Age-based decay function)
    ↓
6. Aggregate Confidence Score
   (Weighted combination: 0.4 + 0.3 + 0.2 + 0.1)
    ↓
7. Attach Confidence to Each Result
   (Metadata: { ...result, confidence: 0.85 })
    ↓
8. Sort by Confidence (descending)
    ↓
9. Format Citations with Markers
   ([1] vs [1~] vs [1?] vs [1!])
    ↓
Pass Enhanced Results to Writer
```

---

### Example Confidence Calculations

#### Example 1: High-Confidence Citation
- **Claim**: "Renewable energy capacity grew 30% in 2023"
- **Source Agreement**: 8/10 sources mention this → 0.8
- **Rank**: Position 2 → 0.9
- **Authority**: .org domain → 0.7
- **Recency**: Published 2 months ago → 0.95
- **Confidence**: (0.8 * 0.4) + (0.9 * 0.3) + (0.7 * 0.2) + (0.95 * 0.1) = **0.83**
- **Citation**: `[1]` (high confidence)

#### Example 2: Low-Confidence Citation
- **Claim**: "Company X may release product Y next year"
- **Source Agreement**: 1/10 sources mention this → 0.1
- **Rank**: Position 8 → 0.2
- **Authority**: .com blog → 0.3
- **Recency**: Not time-sensitive → 0
- **Confidence**: (0.1 * 0.4) + (0.2 * 0.3) + (0.3 * 0.2) + (0 * 0.1) = **0.16**
- **Citation**: `[3?]` (speculative)

#### Example 3: Conflicting Sources
- **Claim A**: "Market grew 10%" (sources 1, 3, 5)
- **Claim B**: "Market grew 15%" (sources 2, 4, 6)
- **Agreement**: 3/6 for each → 0.5
- **Conflict Detected**: True
- **Citations**: `[1,2!]` (conflicting evidence)
- **Writer Instruction**: "Sources disagree on the exact growth rate (10% vs 15%)"

---

## Testing & Validation

### Quality Filter Validation
1. Manual review of 100 filtered vs. non-filtered results
2. Measure false positive rate (good sources incorrectly filtered): Target < 5%
3. Measure false negative rate (noise incorrectly kept): Target < 10%

### Confidence Scoring Validation
1. Manual annotation of 50 claims with ground-truth confidence
2. Compare human ratings vs. algorithmic scores (correlation > 0.7)
3. A/B test: Show users answers with vs. without confidence markers
4. Measure user trust ratings (expect +20% for confident claims)

---

## Implementation Checklist

### Quality Filtering
- [ ] Implement relevance threshold filter
- [ ] Build quality score calculator (4 components)
- [ ] Add Jaccard similarity deduplication
- [ ] Implement source diversity enforcement
- [ ] Create noise detection heuristics
- [ ] Integrate into researcher pipeline (post-reranking)
- [ ] Add logging for filtered results (observability)

### Confidence Scoring
- [ ] Implement source agreement clustering
- [ ] Calculate rank scores (inverse ranking)
- [ ] Detect time-sensitive queries
- [ ] Calculate recency scores
- [ ] Aggregate confidence formula
- [ ] Format citations with markers ([1], [1~], [1?], [1!])
- [ ] Update writer prompt with confidence instructions
- [ ] Add conflict detection logic

---

**This specification provides actionable criteria for Algorithms 4 and 10, ready for implementation!** 🚀
