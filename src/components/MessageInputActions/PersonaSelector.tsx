'use client';

import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import { AnimatePresence, motion } from 'motion/react';
import { Bot, ChevronDown } from 'lucide-react';
import { useChat } from '@/lib/hooks/useChat';
import {
  COMPUTER_PERSONA_CATALOG,
  getComputerPersonaSummaryById,
} from '@/lib/agents/computer/personas/catalog';
import { cn } from '@/lib/utils';

const PersonaSelector = ({ compact = false }: { compact?: boolean }) => {
  const { interactionMode, selectedPersonaId, setSelectedPersonaId } = useChat();

  if (interactionMode !== 'computer') {
    return null;
  }

  const selectedPersona = getComputerPersonaSummaryById(selectedPersonaId);

  return (
    <Popover className="relative">
      {({ open }) => (
        <>
          <PopoverButton
            type="button"
            className={cn(
              'flex min-w-0 items-center gap-1.5 rounded-xl px-3 py-2 text-black/60 transition duration-200 hover:bg-light-secondary hover:text-black focus:outline-none dark:text-white/60 dark:hover:bg-dark-secondary dark:hover:text-white',
              selectedPersona &&
                'bg-sky-500/10 text-sky-600 dark:text-sky-400 hover:bg-sky-500/15',
            )}
            title={
              selectedPersona
                ? `Persona: ${selectedPersona.name}`
                : 'Choose a specialist persona for computer mode'
            }
          >
            <Bot size={16} />
            <span
              className={cn(
                'max-w-36 truncate text-sm font-medium',
                compact && 'hidden sm:inline',
              )}
            >
              {selectedPersona ? selectedPersona.name : 'Persona'}
            </span>
            <ChevronDown
              size={16}
              className={cn('transition duration-200', open && 'rotate-180')}
            />
          </PopoverButton>

          <AnimatePresence>
            {open && (
              <PopoverPanel
                static
                className="absolute right-0 bottom-full z-20 mb-3 w-[min(30rem,calc(100vw-1.5rem))] max-w-[calc(100vw-1.5rem)] sm:w-[32rem]"
              >
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: 6 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: 6 }}
                  transition={{ duration: 0.12, ease: 'easeOut' }}
                  className="max-h-[min(34rem,72vh)] overflow-y-auto rounded-[1.35rem] border border-white/10 bg-[#07111f]/96 p-3 text-white shadow-[0_24px_80px_-28px_rgba(0,0,0,0.85)] backdrop-blur-xl"
                >
                  <div className="mb-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
                    <div className="flex items-center gap-2 text-white">
                      <Bot size={16} className="text-sky-300" />
                      <span className="text-sm font-semibold tracking-[0.02em]">
                        Specialist Persona
                      </span>
                    </div>
                    <p className="mt-1 text-sm leading-6 text-white/72">
                      Choose the agency lead for Computer mode. This changes how
                      the swarm plans, reviews, and reports its work.
                    </p>
                  </div>

                  <PopoverButton
                    type="button"
                    onClick={() => setSelectedPersonaId(null)}
                    className={cn(
                      'flex w-full flex-col items-start rounded-2xl border px-4 py-3.5 text-left transition duration-200 focus:outline-none',
                      !selectedPersona
                        ? 'border-sky-400/35 bg-sky-400/14 shadow-[inset_0_0_0_1px_rgba(56,189,248,0.14)]'
                        : 'border-white/8 bg-white/[0.03] hover:border-white/14 hover:bg-white/[0.06]',
                    )}
                  >
                    <div className="flex items-center gap-2 text-white">
                      <Bot size={17} className="text-white/85" />
                      <span className="text-base font-semibold">Default</span>
                    </div>
                    <p className="mt-1 pr-2 text-[15px] leading-6 text-white/74">
                      Use the built-in computer agent prompts with no added
                      persona overlay.
                    </p>
                  </PopoverButton>

                  {COMPUTER_PERSONA_CATALOG.map((persona) => (
                    <PopoverButton
                      key={persona.id}
                      type="button"
                      onClick={() => setSelectedPersonaId(persona.id)}
                      className={cn(
                        'mt-2 flex w-full flex-col items-start rounded-2xl border px-4 py-3.5 text-left transition duration-200 focus:outline-none',
                        selectedPersonaId === persona.id
                          ? 'border-sky-400/35 bg-sky-400/14 shadow-[inset_0_0_0_1px_rgba(56,189,248,0.14)]'
                          : 'border-white/8 bg-white/[0.03] hover:border-white/14 hover:bg-white/[0.06]',
                      )}
                    >
                      <div className="flex items-center gap-3 text-white">
                        <span
                          className="h-3.5 w-3.5 rounded-full shadow-[0_0_0_4px_rgba(255,255,255,0.04)]"
                          style={{ backgroundColor: persona.color }}
                        />
                        <span className="text-base font-semibold tracking-[0.01em]">
                          {persona.name}
                        </span>
                      </div>
                      <p className="mt-1.5 pr-2 text-[15px] leading-6 text-white/76">
                        {persona.description}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {persona.strengths.map((strength) => (
                          <span
                            key={strength}
                            className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-white/62"
                          >
                            {strength}
                          </span>
                        ))}
                      </div>
                    </PopoverButton>
                  ))}
                </motion.div>
              </PopoverPanel>
            )}
          </AnimatePresence>
        </>
      )}
    </Popover>
  );
};

export default PersonaSelector;
