import { createContext } from 'react';
import type { QueueContextType } from '../types';

export const QueueContext = createContext<QueueContextType | null>(null);
