import { useContext } from 'react';
import type { QueueContextType } from '../types';
import { QueueContext } from './queue-context';

export function useQueue(): QueueContextType {
  const context = useContext(QueueContext);

  if (!context) {
    throw new Error('useQueue must be used within QueueProvider');
  }

  return context;
}
