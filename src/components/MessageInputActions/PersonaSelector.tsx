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
              'flex items-center gap-1 rounded-xl px-2.5 py-2 text-black/50 transition duration-200 hover:bg-light-secondary hover:text-black focus:outline-none dark:text-white/50 dark:hover:bg-dark-secondary dark:hover:text-white',
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
                'max-w-28 truncate text-xs font-medium',
                compact && 'hidden md:inline',
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
                className="absolute left-0 bottom-full z-10 mb-2 w-80"
              >
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: 6 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: 6 }}
                  transition={{ duration: 0.12, ease: 'easeOut' }}
                  className="rounded-xl border border-light-200 bg-light-primary p-2 shadow-lg dark:border-dark-200 dark:bg-dark-primary"
                >
                  <PopoverButton
                    type="button"
                    onClick={() => setSelectedPersonaId(null)}
                    className={cn(
                      'flex w-full flex-col items-start rounded-lg p-2 text-left transition duration-200 focus:outline-none',
                      !selectedPersona
                        ? 'bg-light-secondary dark:bg-dark-secondary'
                        : 'hover:bg-light-secondary dark:hover:bg-dark-secondary',
                    )}
                  >
                    <div className="flex items-center gap-2 text-black dark:text-white">
                      <Bot size={16} />
                      <span className="text-xs font-medium">Default</span>
                    </div>
                    <p className="mt-1 text-xs text-black/70 dark:text-white/70">
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
                        'mt-1 flex w-full flex-col items-start rounded-lg p-2 text-left transition duration-200 focus:outline-none',
                        selectedPersonaId === persona.id
                          ? 'bg-light-secondary dark:bg-dark-secondary'
                          : 'hover:bg-light-secondary dark:hover:bg-dark-secondary',
                      )}
                    >
                      <div className="flex items-center gap-2 text-black dark:text-white">
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: persona.color }}
                        />
                        <span className="text-xs font-medium">
                          {persona.name}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-black/70 dark:text-white/70">
                        {persona.description}
                      </p>
                      <p className="mt-1 text-[11px] uppercase tracking-wide text-black/45 dark:text-white/45">
                        {persona.strengths.join(' · ')}
                      </p>
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
