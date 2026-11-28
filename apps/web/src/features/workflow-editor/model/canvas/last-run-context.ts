import { createContext } from 'react';
import type { LastRunOverlay } from './last-run';

export const LastRunContext = createContext<LastRunOverlay | undefined>(
  undefined,
);
