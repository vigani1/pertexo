import { useQuery } from '@tanstack/react-query';
import { stepDiscussionsQuery } from '../data/collaboration.queries';
import { useWorkflowPresence } from '../model/context';

const NONE: ReadonlyMap<string, number> = new Map();

/** Open discussions about each step of the hub's workflow. */
export function useStepDiscussions(): ReadonlyMap<string, number> {
  const { scope } = useWorkflowPresence();
  return useQuery(stepDiscussionsQuery(scope)).data ?? NONE;
}
