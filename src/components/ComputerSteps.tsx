'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Eye,
  Loader2,
  Terminal,
  Users,
} from 'lucide-react';
import { ComputerBlock, ComputerBlockSubStep } from '@/lib/types';
import { useChat } from '@/lib/hooks/useChat';

const getStepIcon = (step: ComputerBlockSubStep) => {
  if (step.type === 'planning') {
    return <Users className="h-4 w-4" />;
  }

  if (step.type === 'action') {
    if (step.status === 'running') {
      return <Loader2 className="h-4 w-4 animate-spin" />;
    }

    if (step.status === 'error') {
      return <AlertCircle className="h-4 w-4" />;
    }

    return <CheckCircle2 className="h-4 w-4" />;
  }

  return <Eye className="h-4 w-4" />;
};

const getStepTitle = (step: ComputerBlockSubStep) => {
  if (step.type === 'planning') {
    return 'Execution Plan';
  }

  if (step.type === 'action') {
    return step.tool;
  }

  return step.success ? 'Observation' : 'Observation with error';
};

const ComputerSteps = ({
  block,
  status,
  isLast,
}: {
  block: ComputerBlock;
  status: 'answering' | 'completed' | 'error';
  isLast: boolean;
}) => {
  const { loading } = useChat();
  const [isExpanded, setIsExpanded] = useState(
    isLast && status === 'answering',
  );

  useEffect(() => {
    if (isLast && status === 'answering') {
      setIsExpanded(true);
      return;
    }

    if (status !== 'answering') {
      setIsExpanded(false);
    }
  }, [isLast, status]);

  if (block.data.subSteps.length === 0) {
    return null;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-light-200 bg-light-secondary dark:border-dark-200 dark:bg-dark-secondary">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center justify-between p-3 transition duration-200 hover:bg-light-200 dark:hover:bg-dark-200"
      >
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-black dark:text-white" />
          <span className="text-sm font-medium text-black dark:text-white">
            Computer Steps ({block.data.subSteps.length}{' '}
            {block.data.subSteps.length === 1 ? 'step' : 'steps'})
          </span>
        </div>
        {isExpanded ? (
          <ChevronUp className="h-4 w-4 text-black/70 dark:text-white/70" />
        ) : (
          <ChevronDown className="h-4 w-4 text-black/70 dark:text-white/70" />
        )}
      </button>

      <AnimatePresence>
        {isExpanded && (
          <PopoverContent block={block} isLast={isLast} loading={loading} />
        )}
      </AnimatePresence>
    </div>
  );
};

const PopoverContent = ({
  block,
  isLast,
  loading,
}: {
  block: ComputerBlock;
  isLast: boolean;
  loading: boolean;
}) => {
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="border-t border-light-200 dark:border-dark-200"
    >
      <div className="space-y-3 p-3">
        {block.data.subSteps.map((step, index) => {
          const isStreaming =
            step.type === 'action' &&
            step.status === 'running' &&
            loading &&
            isLast;

          return (
            <motion.div
              key={step.id}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              className="flex gap-3"
            >
              <div className="flex flex-col items-center">
                <div
                  className={cn(
                    'rounded-full p-1.5 text-black/70 dark:text-white/70',
                    step.type === 'planning'
                      ? 'bg-sky-500/10 text-sky-500'
                      : step.type === 'action' && step.status === 'error'
                        ? 'bg-rose-500/10 text-rose-500'
                        : step.type === 'action' && step.status === 'completed'
                          ? 'bg-emerald-500/10 text-emerald-500'
                          : 'bg-light-100 dark:bg-dark-100',
                    isStreaming && 'animate-pulse',
                  )}
                >
                  {getStepIcon(step)}
                </div>
                {index < block.data.subSteps.length - 1 && (
                  <div className="mt-1.5 min-h-[24px] w-0.5 flex-1 bg-light-200 dark:bg-dark-200" />
                )}
              </div>

              <div className="flex-1 pb-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-black dark:text-white">
                    {getStepTitle(step)}
                  </span>
                  {step.type === 'action' && (
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                        step.status === 'completed'
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          : step.status === 'error'
                            ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
                            : 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
                      )}
                    >
                      {step.status}
                    </span>
                  )}
                </div>

                {step.type === 'planning' && (
                  <div className="mt-1.5 space-y-2">
                    {step.persona && (
                      <div className="rounded-lg border border-light-200 bg-light-100 p-2 dark:border-dark-200 dark:bg-dark-100">
                        <div className="flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: step.persona.color }}
                          />
                          <p className="text-xs font-medium text-black dark:text-white">
                            {step.persona.name}
                          </p>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-black/70 dark:text-white/70">
                          {step.persona.description}
                        </p>
                        <p className="mt-1 text-[11px] uppercase tracking-wide text-black/45 dark:text-white/45">
                          {step.persona.strengths.join(' · ')}
                        </p>
                      </div>
                    )}
                    <p className="text-xs leading-relaxed text-black/70 dark:text-white/70">
                      {step.plan}
                    </p>
                    {step.agents && step.agents.length > 0 && (
                      <div className="grid gap-2 md:grid-cols-2">
                        {step.agents.map((agent, agentIndex) => (
                          <div
                            key={`${agent.role}-${agentIndex}`}
                            className="rounded-lg border border-light-200 bg-light-100 p-2 dark:border-dark-200 dark:bg-dark-100"
                          >
                            <p className="text-xs font-medium uppercase tracking-wide text-black/60 dark:text-white/60">
                              {agent.role}
                            </p>
                            <p className="mt-1 text-xs leading-relaxed text-black/75 dark:text-white/75">
                              {agent.task}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {step.type === 'action' && (
                  <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-light-200 bg-light-100 p-2 text-xs leading-relaxed text-black/70 dark:border-dark-200 dark:bg-dark-100 dark:text-white/70">
                    {step.action}
                  </pre>
                )}

                {step.type === 'observation' && (
                  <pre
                    className={cn(
                      'mt-1.5 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border p-2 text-xs leading-relaxed',
                      step.success
                        ? 'border-emerald-500/20 bg-emerald-500/5 text-black/70 dark:text-white/70'
                        : 'border-rose-500/20 bg-rose-500/5 text-black/70 dark:text-white/70',
                    )}
                  >
                    {step.observation}
                  </pre>
                )}
              </div>
            </motion.div>
          );
        })}
      </div>
    </motion.div>
  );
};

const cn = (...classes: Array<string | false | null | undefined>) => {
  return classes.filter(Boolean).join(' ');
};

export default ComputerSteps;
