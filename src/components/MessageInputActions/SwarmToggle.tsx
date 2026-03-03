'use client';

import { Users } from 'lucide-react';
import { useChat } from '@/lib/hooks/useChat';
import { cn } from '@/lib/utils';

const SwarmToggle = () => {
  const { interactionMode, swarmEnabled, setSwarmEnabled } = useChat();

  if (interactionMode !== 'computer') {
    return null;
  }

  return (
    <button
      type="button"
      onClick={() => setSwarmEnabled(!swarmEnabled)}
      className={cn(
        'rounded-xl p-2 transition duration-200',
        swarmEnabled
          ? 'bg-sky-500/15 text-sky-500 hover:bg-sky-500/20'
          : 'text-black/50 dark:text-white/50 hover:bg-light-secondary dark:hover:bg-dark-secondary hover:text-black dark:hover:text-white',
      )}
      title={swarmEnabled ? 'Swarm mode enabled' : 'Swarm mode disabled'}
    >
      <Users size={16} />
    </button>
  );
};

export default SwarmToggle;
