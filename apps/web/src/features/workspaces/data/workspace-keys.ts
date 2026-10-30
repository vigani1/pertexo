import type { QueryKey } from '@tanstack/react-query';

// No API imports here, so what opens a workspace can read the key cheaply.
export const workspaceKeys = {
  accessible: (userId: string) =>
    ['identity', userId, 'accessible-workspaces'] as const,
  /** Anyone's list, for a tab whose session isn't confirmed yet. */
  isAccessibleList: (key: QueryKey) =>
    key[0] === 'identity' && key[2] === 'accessible-workspaces',
};
