# Retrieval Benchmark Report

## Retrieval stages

| Stage | Relevance | Latency ms | Token Cost |
| --- | --- | --- | --- |
| hybrid | 0.889 | 0.029 | 0.0 |
| late_interaction | 0.889 | 0.633 | 255.3 |
| late_plus_cross_encoder | 0.889 | 0.774 | 510.7 |

## Context assembly

| Strategy | Answer Quality | Grounding Rate | Final Tokens | Citation Density | Latency ms |
| --- | --- | --- | --- | --- | --- |
| baseline | 0.782 | 0.672 | 154.7 | 0.0261 | 0.171 |
| dedup | 0.782 | 0.672 | 151.0 | 0.0266 | 0.163 |
| mmr | 0.782 | 0.672 | 151.0 | 0.0266 | 0.182 |
| optimized | 0.782 | 0.672 | 151.0 | 0.0266 | 0.178 |

## Framing

- `hybrid`: BM25 or hybrid broad recall only
- `late_interaction`: broad recall plus ColBERT-style token max-sim rescoring
- `late_plus_cross_encoder`: late interaction plus a cross-encoder-style score on a tiny head slice
- `optimized`: late-interaction candidates plus dedup, MMR, sentence extraction, and token-aware packing
