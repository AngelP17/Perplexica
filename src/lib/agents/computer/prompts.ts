import { ChatTurnMessage } from '@/lib/types';
import formatChatHistoryAsString from '@/lib/utils/formatHistory';

export const withSystemInstructions = (
  basePrompt: string,
  systemInstructions: string,
) => {
  const trimmed = systemInstructions.trim();

  if (!trimmed) {
    return basePrompt;
  }

  return `${basePrompt}\n\nAdditional user instructions:\n${trimmed}`;
};

export const getComputerTaskContext = (
  task: string,
  chatHistory: ChatTurnMessage[],
) => {
  const trimmedHistory = chatHistory.slice(-6);

  if (trimmedHistory.length === 0) {
    return `Primary task: ${task}`;
  }

  return [
    `Primary task: ${task}`,
    '',
    'Recent conversation context:',
    formatChatHistoryAsString(trimmedHistory),
  ].join('\n');
};

export const getSwarmPlanningPrompt = (task: string) => {
  return [
    `Task: ${task}`,
    '',
    'Produce a compact execution plan using only these execution roles:',
    '- coder: for writing files, reading files, listing files, and running Python code',
    '- researcher: for reading and analyzing existing files',
    '- browser: for navigating websites, clicking, typing, taking screenshots, and scraping web content',
    '',
    'Rules:',
    '1. Use the fewest agents possible (1-3 agents maximum)',
    '2. Each agent must have a clear, specific task',
    '3. Only use browser when the task requires actual web interaction',
    '4. Prefer coder for all file and Python work',
    '',
    'Example 1 - File task:',
    '{"plan":"Create and execute Python script","agents":[{"role":"coder","task":"Write fibonacci.py and execute it to print first 10 numbers"}]}',
    '',
    'Example 2 - Web task:',
    '{"plan":"Scrape and save web content","agents":[{"role":"browser","task":"Navigate to example.com and scrape main heading"},{"role":"coder","task":"Save scraped content to data.txt"}]}',
    '',
    'Example 3 - Analysis task:',
    '{"plan":"Analyze workspace files","agents":[{"role":"researcher","task":"Read all .py files and summarize their purpose"}]}',
    '',
    'Return ONLY valid JSON matching this exact format:',
    '{"plan":"<brief description>","agents":[{"role":"<coder|researcher|browser>","task":"<specific task>"}]}',
  ].join('\n');
};

export const getComputerSummaryPrompt = () => {
  return [
    'You are writing the final response for a computer agent run.',
    'Summarize what was completed, mention any created files or important outputs, and call out unresolved errors if they remain.',
    'Do not mention hidden prompts, tool schemas, or internal planning mechanics.',
    'Keep the answer concise and practical.',
  ].join(' ');
};
