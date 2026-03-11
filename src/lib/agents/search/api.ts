import { ResearcherOutput, SearchAgentInput } from './types';
import SessionManager from '@/lib/session';
import { classify } from './classifier';
import Researcher from './researcher';
import { getWriterPrompt } from '@/lib/prompts/search/writer';
import { WidgetExecutor } from './widgets';
import { buildSearchContext } from './context';
import { classifyFailure } from '@/lib/evaluation/failureTaxonomy';

class APISearchAgent {
  async searchAsync(session: SessionManager, input: SearchAgentInput) {
    try {
      const classification = await classify({
        chatHistory: input.chatHistory,
        enabledSources: input.config.sources,
        query: input.followUp,
        llm: input.config.llm,
      });

      const widgetPromise = WidgetExecutor.executeAll({
        classification,
        chatHistory: input.chatHistory,
        followUp: input.followUp,
        llm: input.config.llm,
      });

      let searchPromise: Promise<ResearcherOutput> | null = null;

      if (!classification.classification.skipSearch) {
        const researcher = new Researcher();
        searchPromise = researcher.research(SessionManager.createSession(), {
          chatHistory: input.chatHistory,
          followUp: input.followUp,
          classification,
          config: input.config,
        });
      }

      const [widgetOutputs, searchResults] = await Promise.all([
        widgetPromise,
        searchPromise,
      ]);

      if (searchResults) {
        session.emit('data', {
          type: 'searchResults',
          data: searchResults.searchFindings,
        });
      }

      session.emit('data', {
        type: 'researchComplete',
      });

      const finalContextWithWidgets = buildSearchContext(
        input.followUp,
        input.config.mode,
        searchResults?.searchFindings,
        widgetOutputs,
      );

      const writerPrompt = getWriterPrompt(
        finalContextWithWidgets,
        input.config.systemInstructions,
        input.config.mode,
      );

      const answerStream = input.config.llm.streamText({
        messages: [
          {
            role: 'system',
            content: writerPrompt,
          },
          ...input.chatHistory,
          {
            role: 'user',
            content: input.followUp,
          },
        ],
      });

      for await (const chunk of answerStream) {
        session.emit('data', {
          type: 'response',
          data: chunk.contentChunk,
        });
      }

      session.emit('end', {});
    } catch (error) {
      console.error('API search agent failed:', error);

      const message =
        error instanceof Error ? error.message : 'Search request failed';
      const failure = classifyFailure(message);

      session.emit('error', {
        data: `${message} [${failure.type}]`,
      });
    }
  }
}

export default APISearchAgent;
