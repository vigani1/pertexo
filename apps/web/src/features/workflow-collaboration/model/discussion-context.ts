import { createContext, use } from 'react';
import type { CollaborationScope } from '../data/collaboration.api';
import type { EditingPresence } from './presence';
export const PresenceContext = createContext<{
  scope: CollaborationScope;
  tabId: string;
  report: (state: EditingPresence) => void;
} | null>(null);
export function useWorkflowPresence() {
  const context = use(PresenceContext);
  if (context === null)
    throw new Error('Workflow presence needs its hub owner');
  return context;
}
