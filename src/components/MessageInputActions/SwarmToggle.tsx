'use client';

import { Users } from 'lucide-react';
import { useChat } from '@/lib/hooks/useChat';
import { cn } from '@/lib/utils';

const SwarmToggle = () => {
  const {
    interactionMode,
    swarmEnabled,
    setInteractionMode,
    setSwarmEnabled,
  } = useChat();
  const inactive = interactionMode !== 'computer';

  const handleClick = () => {
    if (interactionMode !== 'computer') {
      setInteractionMode('computer');
      setSwarmEnabled(true);
      return;
    }

    setSwarmEnabled(!swarmEnabled);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'rounded-xl px-2.5 py-2 transition duration-200 flex items-center gap-1.5',
        inactive
          ? 'text-black/30 dark:text-white/30'
          : swarmEnabled
            ? 'bg-sky-500/15 text-sky-500 hover:bg-sky-500/20'
            : 'text-black/50 dark:text-white/50 hover:bg-light-secondary dark:hover:bg-dark-secondary hover:text-black dark:hover:text-white',
      )}
      title={
        inactive
          ? 'Enable Swarm and switch to Computer mode'
          : swarmEnabled
            ? 'Swarm mode enabled'
            : 'Swarm mode disabled'
      }
    >
      <Users size={16} />
      <span className="hidden md:inline text-xs font-medium">Swarm</span>
    </button>
  );
};

export default SwarmToggle;
