import { WidgetOutput } from './types';
import { Chunk } from '@/lib/types';
import { assembleContext } from './contextOptimizer';

const escapeAttr = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export const buildSearchContext = (
  query: string,
  mode: 'speed' | 'balanced' | 'quality',
  searchFindings: Chunk[] | undefined,
  widgetOutputs: WidgetOutput[],
) => {
  const assembled = assembleContext({
    query,
    chunks: searchFindings || [],
    mode,
    strategy: 'optimized',
  });

  const findingsContext = assembled.selected
    .map((candidate, index) => {
      const result = candidate.chunk;

      return `<result index="${index + 1}" citation="${escapeAttr(
        result.metadata.citation || `[${index + 1}]`,
      )}" confidence="${escapeAttr(
        result.metadata.confidence ?? '',
      )}" confidence_label="${escapeAttr(
        result.metadata.confidenceLabel ?? '',
      )}" source_type="${escapeAttr(
        result.metadata.sourceType ?? 'web',
      )}" title="${escapeAttr(result.metadata.title || '')}" url="${escapeAttr(
        result.metadata.url || '',
      )}" domain="${escapeAttr(result.metadata.domain || '')}" lexical_score="${escapeAttr(
        result.metadata.lexicalScore ?? '',
      )}" vector_score="${escapeAttr(
        result.metadata.vectorScore ?? '',
      )}" late_interaction_score="${escapeAttr(
        result.metadata.lateInteractionScore ?? '',
      )}" cross_encoder_score="${escapeAttr(
        result.metadata.crossEncoderScore ?? '',
      )}">${candidate.excerpt}</result>`;
    })
    .join('\n');

  const widgetContext = widgetOutputs
    .map((output) => `<result>${output.llmContext}</result>`)
    .join('\n-------------\n');

  return `<search_results note="These are the search results and assistant can cite these">\n${findingsContext}\n</search_results>\n<widgets_result noteForAssistant="Its output is already showed to the user, assistant can use this information to answer the query but do not CITE this as a source">\n${widgetContext}\n</widgets_result>`;
};
