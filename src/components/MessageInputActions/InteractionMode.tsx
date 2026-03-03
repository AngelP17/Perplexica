'use client';

import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, Search, Terminal } from 'lucide-react';
import { useChat } from '@/lib/hooks/useChat';
import { cn } from '@/lib/utils';

const interactionModes = [
  {
    key: 'search' as const,
    title: 'Search',
    description: 'Research the web and answer with cited sources.',
    icon: <Search size={16} className="text-sky-500" />,
  },
  {
    key: 'computer' as const,
    title: 'Computer',
    description: 'Use local tools, Python, and browser automation.',
    icon: <Terminal size={16} className="text-emerald-500" />,
  },
];

const InteractionMode = ({ compact = false }: { compact?: boolean }) => {
  const { interactionMode, setInteractionMode } = useChat();

  const selectedMode =
    interactionModes.find((mode) => mode.key === interactionMode) ||
    interactionModes[0];

  return (
    <Popover className="relative">
      {({ open }) => (
        <>
          <PopoverButton
            type="button"
            className={cn(
              'flex items-center gap-1 rounded-xl text-black/50 dark:text-white/50 transition duration-200 hover:bg-light-secondary dark:hover:bg-dark-secondary hover:text-black dark:hover:text-white focus:outline-none',
              compact ? 'px-2.5 py-2' : 'px-2.5 py-2',
            )}
          >
            {selectedMode.icon}
            <span
              className={cn(
                'text-xs font-medium text-black/70 dark:text-white/70',
                compact && 'hidden md:inline',
              )}
            >
              {selectedMode.title}
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
                className="absolute left-0 bottom-full mb-2 z-10 w-64"
              >
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: 6 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: 6 }}
                  transition={{ duration: 0.12, ease: 'easeOut' }}
                  className="rounded-xl border border-light-200 dark:border-dark-200 bg-light-primary dark:bg-dark-primary p-2 shadow-lg"
                >
                  {interactionModes.map((mode) => (
                    <PopoverButton
                      key={mode.key}
                      type="button"
                      onClick={() => setInteractionMode(mode.key)}
                      className={cn(
                        'flex w-full flex-col items-start rounded-lg p-2 text-left transition duration-200 focus:outline-none',
                        interactionMode === mode.key
                          ? 'bg-light-secondary dark:bg-dark-secondary'
                          : 'hover:bg-light-secondary dark:hover:bg-dark-secondary',
                      )}
                    >
                      <div className="flex items-center gap-2 text-black dark:text-white">
                        {mode.icon}
                        <span className="text-xs font-medium">
                          {mode.title}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-black/70 dark:text-white/70">
                        {mode.description}
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

export default InteractionMode;
